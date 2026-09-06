"""Deeper-graph loop: harvesting, resolution, reuse, fair scheduling, planning, and diagnostics."""

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers import Document, Finding, FixtureProvider, Page, Plan, ProviderFailure
from app.resolution import (
    near_duplicates,
    normalize_label,
    record_identity,
    resolve_entity,
    select_passages,
)
from tests.conftest import researched, sse_events


async def test_depth_two_fixture_harvests_a_chain_resolves_aliases_and_rejects_reversed_relations(
    api,
):
    client, app = api
    app.state.worker.provider = FixtureProvider(depth=2)
    run, graph = await researched(api)
    labels = {n["label"]: n for n in graph["nodes"]}
    assert set(labels) == {
        "Raspberry Pi 5",
        "Broadcom BCM2712",
        "RP1 I/O controller",
        "LPDDR4X-4267 SDRAM",
        "Arm Cortex-A76 CPU",
        "VideoCore VII GPU",
    }
    # Tier 0 is the product root; the BCM2712's parts sit at tier 2 through PART_OF chains.
    assert labels["Broadcom BCM2712"]["tier"] == 1
    assert labels["Arm Cortex-A76 CPU"]["tier"] == 2 and labels["VideoCore VII GPU"]["tier"] == 2
    # A bare "BCM2712" finding with part number and maker resolved to "Broadcom BCM2712" by
    # identifier, recorded the alias, and corroborated the tier-1 edge; the VideoCore finding
    # that names "BCM2712" as its object then resolved through that alias on a later pass.
    soc = labels["Broadcom BCM2712"]
    assert "BCM2712" in soc["aliases"] and soc["external_ids"]["mpn"] == "BCM2712"
    assert len(graph["edges"]) == 5
    soc_edge = next(e for e in graph["edges"] if e["source_node_id"] == soc["id"])
    assert len(soc_edge["claim_ids"]) == 2
    assert all(e["support_label"] == "directly_supported" for e in graph["edges"])
    events = sse_events(await client.get(run["events_url"]))
    rejected = [e["payload"]["reason"] for e in events if e["type"] == "claim.rejected"]
    assert "predicate_invalid" in rejected  # product PART_OF component is reversed
    planned = [e for e in events if e["type"] == "task.planned"]
    assert planned and all(e["payload"]["planner"] == "planner" for e in planned)
    depths = [e["payload"]["depth"] for e in events if e["type"] == "task.started"]
    # Fair scheduling: every tier-1 branch gets a turn before any branch goes a level deeper.
    assert depths == [0, 1, 1, 1, 2, 2]
    assert run["progress"] == {"tasks_done": 6, "tasks_total": 6} and run["frontier"] == {}
    assert run["status"] == "partial" and run["stop_reason"] == "research_exhausted"
    bom = (await client.get(run["bom_url"])).json()
    assert {(i["name"], i["tier"]) for i in bom["items"]} >= {
        ("Arm Cortex-A76 CPU", 2),
        ("VideoCore VII GPU", 2),
    }
    history = await client.get(f"/v1/runs/{run['id']}/history")
    assert history.status_code == 200 and history.json()["run_id"] == run["id"]
    assert (await client.get("/v1/runs/run_missing/history")).status_code == 404


async def test_default_fixture_depth_keeps_the_original_three_component_example(api):
    _, graph = await researched(api)
    assert len(graph["nodes"]) == 4 and len(graph["edges"]) == 3


class PageProvider:
    """Exposes the search_pages/analyze/plan contract with a single reusable page."""

    name = "test_pages"

    def __init__(self):
        self.analyzed = []
        self.body = "Widget contains tin and a battery. Tin is refined by Acme Smelting."

    async def plan(self, context, budget):
        return Plan.model_validate(
            {
                "relation_sought": "upstream_inputs",
                "queries": [
                    {
                        "query": f"{context['target']['label']} one",
                        "source_types": ["other"],
                        "reason": "a",
                    },
                    {
                        "query": f"{context['target']['label']} two",
                        "source_types": ["other"],
                        "reason": "b",
                    },
                ],
                "skip": False,
                "skip_reason": None,
                "priority": "high",
            }
        )

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        return [Page(url="https://example.org/widget", title="Widget", snippet="", body=self.body)]

    async def analyze(self, target, product, company, url, title, body, budget):
        self.analyzed.append(target["label"])
        findings = []
        if target["kind"] == "product":
            findings = [
                Finding("tin", "material", "INPUT_TO", "Widget contains tin", "stated"),
                # Harvested: a relation between two entities other than the target.
                Finding(
                    "tin",
                    "material",
                    "PROCESSED_BY",
                    "Tin is refined by Acme Smelting",
                    "stated; neither endpoint is the target",
                    scope_type="generic",
                    object_label="Acme Smelting",
                    object_kind="organization",
                ),
                # Reversed direction for the table: organization PROCESSED_BY material.
                Finding(
                    "Acme Smelting",
                    "organization",
                    "PROCESSED_BY",
                    "Tin is refined by Acme Smelting",
                    "reversed",
                    scope_type="generic",
                    object_label="tin",
                    object_kind="material",
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_pages_are_reused_per_question_and_harvested_relations_attach_to_named_objects(api):
    client, app = api
    provider = PageProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    # Two planner queries returned the same page: analyzed once for the root's question.
    assert provider.analyzed.count("Widget") == 1
    # A different target reuses the stored analysis: harvested findings are target-independent.
    assert provider.analyzed.count("tin") == 0
    labels = {n["label"]: n for n in graph["nodes"]}
    assert set(labels) == {"Widget", "tin", "Acme Smelting"}
    edges = {(e["source_node_id"], e["target_node_id"], e["predicate"]) for e in graph["edges"]}
    assert (labels["tin"]["id"], labels["Widget"]["id"], "INPUT_TO") in edges
    # The harvested tin -> Acme relation was placed once tin existed (second pass), with the
    # organization created as a non-dependency node that gets no tier and no research task.
    assert (labels["tin"]["id"], labels["Acme Smelting"]["id"], "PROCESSED_BY") in edges
    assert labels["Acme Smelting"]["tier"] is None
    assert provider.analyzed.count("Acme Smelting") == 0
    events = sse_events(await client.get(run["events_url"]))
    sources = [e for e in events if e["type"] == "source.retrieved"]
    assert len(sources) == 1  # one stored source record for the reused page
    assert any(
        e["type"] == "claim.rejected" and e["payload"]["reason"] == "predicate_invalid"
        for e in events
    )


class FlakyProvider(PageProvider):
    name = "test_flaky"

    async def analyze(self, target, product, company, url, title, body, budget):
        if target["kind"] == "product":
            raise ProviderFailure("model_output_invalid", "bad JSON")
        return await super().analyze(target, product, company, url, title, body, budget)


async def test_invalid_model_output_fails_one_task_visibly_without_ending_the_run(api):
    client, app = api
    app.state.worker.provider = FlakyProvider()
    upload = (
        await client.post(
            "/v1/uploads", files={"file": ("bom.csv", "material,quantity,unit\ntin,2,g")}
        )
    ).json()
    run, graph = await researched(api, "Widget", upload_id=upload["id"])
    # The root task failed on invalid output; the uploaded tin branch still ran to completion.
    assert run["stop_reason"] == "research_exhausted"
    events = sse_events(await client.get(run["events_url"]))
    outcomes = [e["payload"]["outcome"] for e in events if e["type"] == "task.finished"]
    assert "failed:model_output_invalid" in outcomes
    assert any("unusable" in q and "continued" in q for q in run["open_questions"])
    assert {n["label"] for n in graph["nodes"]} == {"Widget", "tin"}


def test_resolution_is_deterministic_and_conservative():
    graph = {
        "nodes": [
            {
                "id": "n1",
                "kind": "component",
                "label": "Broadcom BCM2712",
                "aliases": ["BCM2712"],
                "external_ids": {"mpn": "BCM2712", "manufacturer": "Broadcom"},
            },
            {
                "id": "n2",
                "kind": "component",
                "label": "BCM2712C1",
                "aliases": [],
                "external_ids": {"mpn": "BCM2712C1", "manufacturer": "Broadcom"},
            },
            {"id": "n3", "kind": "material", "label": "Tin", "aliases": [], "external_ids": {}},
        ]
    }
    assert normalize_label("  Broadcom BCM2712 ") == "broadcom bcm2712"
    assert resolve_entity(graph, "component", "bcm2712")[0]["id"] == "n1"  # alias, case-folded
    assert resolve_entity(graph, "material", "tin")[0]["id"] == "n3"
    assert resolve_entity(graph, "component", "Tin") == (None, None)  # kind must match
    # Package or revision suffix is a different part.
    assert resolve_entity(graph, "component", "BCM2712C1")[0]["id"] == "n2"
    # A part number alone never merges; with the manufacturer it does.
    assert resolve_entity(graph, "component", "Pi 5 SoC", part_number="BCM2712") == (None, None)
    assert resolve_entity(graph, "component", "Pi 5 SoC", "BCM2712", "broadcom")[0]["id"] == "n1"
    # Same name with a conflicting identifier is a review case, not a merge.
    # Name says one part, identifier says its revision: ambiguous, so reviewed rather than merged.
    assert resolve_entity(graph, "component", "Broadcom BCM2712", "BCM2712C1", "Broadcom") == (
        None,
        "ambiguous_match",
    )
    assert resolve_entity(graph, "component", "Broadcom BCM2712", "BCM2712", "Qualcomm") == (
        None,
        "identifier_conflict",
    )
    graph["nodes"].append(
        {"id": "n4", "kind": "material", "label": "tin", "aliases": [], "external_ids": {}}
    )
    assert resolve_entity(graph, "material", "TIN") == (None, "ambiguous_match")
    node = {"id": "n5", "kind": "component", "label": "RP1", "aliases": [], "external_ids": {}}
    record_identity(node, "RP1 I/O controller", "RP1", "Raspberry Pi")
    assert node["aliases"] == ["RP1 I/O controller"] and node["external_ids"] == {
        "mpn": "RP1",
        "manufacturer": "Raspberry Pi",
    }


def test_passage_selection_keeps_the_first_window_and_keyword_dense_windows():
    text = "intro " * 3000 + "BCM2712 datasheet " * 500 + "filler " * 4000 + "BCM2712 again " * 300
    short, windows = select_passages("short text", ["BCM2712"])
    assert short == "short text" and windows == [(0, len("short text"))]
    passages, windows = select_passages(text, ["Broadcom BCM2712"])
    assert windows[0] == (0, 8000) and len(windows) <= 3
    assert "[OMITTED SOURCE TEXT]" in passages and "BCM2712" in passages
    assert len(passages) <= 8000 + 2 * 6000 + 2 * len("\n[OMITTED SOURCE TEXT]\n")


def test_model_roles_resolve_consistently_for_both_providers():
    openai = Settings(_env_file=None, openai_model="base", openai_verifier_model="ver")
    assert [openai.model_for(r) for r in ("extraction", "verifier", "planner")] == [
        "base",
        "ver",
        "ver",
    ]
    router = Settings(
        _env_file=None,
        llm_provider="openrouter",
        openrouter_model="a/b:free",
        openrouter_planner_model="c/d:free",
    )
    assert [router.model_for(r) for r in ("extraction", "verifier", "planner")] == [
        "a/b:free",
        "a/b:free",
        "c/d:free",
    ]
    with pytest.raises(ValidationError, match="OPENROUTER_PLANNER_MODEL"):
        Settings(
            _env_file=None,
            research_provider="live",
            llm_provider="openrouter",
            tavily_api_key="t",
            openrouter_api_key="r",
            openrouter_planner_model="paid/model",
        )


class QueryStarvingProvider(PageProvider):
    """First query returns four irrelevant long pages; the second returns the useful one."""

    name = "test_starving"

    def __init__(self):
        super().__init__()
        self.queries = []

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        self.queries.append((query, count))
        if query.endswith("one"):
            return [
                Page(
                    url=f"https://filings.org/{i}",
                    title="Form SD",
                    snippet="",
                    body="unrelated " * 400,
                )
                for i in range(4)
            ]
        return [Page(url="https://example.org/widget", title="Widget", snippet="", body=self.body)]


async def test_document_allowance_is_shared_across_queries_and_irrelevant_pages_are_skipped(api):
    client, app = api
    provider = QueryStarvingProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    # Both planned queries ran: the first got half the allowance, and its unrelated long pages
    # were skipped before any extraction call, so the useful page was still analyzed.
    assert [q for q, _ in provider.queries][:2] == ["Widget one", "Widget two"]
    # The product task has twice the per-task document allowance (8), so each query got 4.
    assert provider.queries[0][1] == 4
    assert provider.queries[2][1] == 2  # a tier-1 task shares the plain allowance (4)
    assert "tin" in {n["label"] for n in graph["nodes"]}
    history = (await client.get(f"/v1/runs/{run['id']}/history")).json()["entries"]
    skipped = [e for e in history if e.get("skipped") == "no mention of product or target"]
    # Four unrelated filings per "one" query were skipped without a call, for the product, tin,
    # and Acme Smelting (location) tasks.
    assert len(skipped) == 12 and provider.analyzed.count("Widget") == 1


class ReplanningProvider(PageProvider):
    """First plan yields nothing; the replan proposes a new query that finds the page."""

    name = "test_replan"

    def __init__(self):
        super().__init__()
        self.plans = 0
        self.searches = []

    async def plan(self, context, budget):
        self.plans += 1
        query = "dead end" if self.plans == 1 else "second wind"
        if context["target"]["kind"] != "product":
            query = f"{context['target']['label']} query"
        return Plan.model_validate(
            {
                "relation_sought": "upstream_inputs",
                "queries": [{"query": query, "source_types": ["other"], "reason": "r"}],
                "skip": False,
                "skip_reason": None,
                "priority": "high",
            }
        )

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        self.searches.append(query)
        if query == "dead end":
            return []
        return [Page(url="https://example.org/widget", title="Widget", snippet="", body=self.body)]


async def test_replanned_queries_run_with_their_own_document_share(api):
    client, app = api
    provider = ReplanningProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    assert provider.searches[:2] == ["dead end", "second wind"]
    assert "tin" in {n["label"] for n in graph["nodes"]}
    events = sse_events(await client.get(run["events_url"]))
    assert [e["payload"]["outcome"] for e in events if e["type"] == "task.finished"][0] == (
        "findings_committed"
    )
    assert run["status"] == "partial" and run["stop_reason"] == "research_exhausted"


class ParallelProvider(PageProvider):
    """Three distinct pages; analysis only completes once all three are in flight together."""

    name = "test_parallel"

    def __init__(self):
        super().__init__()
        self.inflight = 0
        self.peak = 0
        self.gate = __import__("asyncio").Event()

    async def plan(self, context, budget):
        # One query so the task's whole document allowance is available to it.
        return Plan.model_validate(
            {
                "relation_sought": "upstream_inputs",
                "queries": [
                    {"query": context["target"]["label"], "source_types": ["other"], "reason": "r"}
                ],
                "skip": False,
                "skip_reason": None,
                "priority": "high",
            }
        )

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        return [
            Page(
                url=f"https://example.org/p{i}",
                title="Widget",
                snippet="",
                body=f"{self.body} page {i}",
            )
            for i in range(3)
        ]

    async def analyze(self, target, product, company, url, title, body, budget):
        import asyncio

        self.inflight += 1
        self.peak = max(self.peak, self.inflight)
        if self.inflight >= 3:
            self.gate.set()
        try:
            await asyncio.wait_for(self.gate.wait(), timeout=5)
        finally:
            self.inflight -= 1
        return await super().analyze(target, product, company, url, title, body, budget)


async def test_documents_within_a_task_are_analyzed_concurrently(api):
    client, app = api
    provider = ParallelProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    assert provider.peak == 3  # all three pages were in flight at once
    assert "tin" in {n["label"] for n in graph["nodes"]}
    assert run["usage"]["documents"] >= 3


class StagnantProvider(PageProvider):
    """Root finds A; A finds A1, A2, A3; nothing below them is ever found."""

    name = "test_stagnant"

    async def plan(self, context, budget):
        return Plan.model_validate(
            {
                "relation_sought": "upstream_inputs",
                "queries": [
                    {"query": context["target"]["label"], "source_types": ["other"], "reason": "r"}
                ],
                "skip": False,
                "skip_reason": None,
                "priority": "high",
            }
        )

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        return [
            Page(
                url=f"https://example.org/{query}",
                title=query,
                snippet="",
                body=f"Page about {query}",
            )
        ]

    async def analyze(self, target, product, company, url, title, body, budget):
        self.analyzed.append(target["label"])
        children = {"Widget": ["A"], "A": ["A1", "A2", "A3"]}.get(target["label"], [])
        findings = [
            Finding(child, "component", "PART_OF", f"Page about {target['label']}", "stated")
            for child in children
        ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_a_branch_pauses_after_consecutive_empty_tasks_and_releases_budget(api):
    client, app = api
    provider = StagnantProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget", limits={"max_hops": 4})
    # A1 and A2 found nothing, so A3 was never researched and its budget was released.
    assert provider.analyzed.count("A3") == 0
    assert any("Paused the A branch" in q for q in run["open_questions"])
    assert run["frontier"] == {}
    assert {n["label"] for n in graph["nodes"]} == {"Widget", "A", "A1", "A2", "A3"}


def test_rank_pages_prefers_expected_source_types_and_first_party_hosts():
    from app.providers import rank_pages

    pages = [
        Page(url="https://shop.example.com/buy-widget", title="Buy Widget", snippet="", body="x"),
        Page(
            url="https://www.ifixit.com/Teardown/Widget",
            title="Widget Teardown",
            snippet="",
            body="x",
        ),
        Page(
            url="https://acme.com/docs/widget-datasheet.pdf",
            title="Datasheet",
            snippet="",
            body="x",
        ),
        Page(url="https://news.org/widget", title="Widget news", snippet="", body=None),
    ]
    ranked = rank_pages(pages, ["datasheet"], product="Widget", company="Acme")
    assert [p.url for p in ranked][:2] == [
        "https://acme.com/docs/widget-datasheet.pdf",
        "https://www.ifixit.com/Teardown/Widget",
    ]
    assert ranked[-1].url == "https://shop.example.com/buy-widget"


def test_name_variants_resolve_through_recorded_identifiers_and_flag_near_duplicates():
    from app.resolution import near_duplicates, software_artifact

    graph = {
        "nodes": [
            {
                "id": "n1",
                "kind": "component",
                "label": "Broadcom BCM2712",
                "aliases": [],
                "external_ids": {"mpn": "BCM2712", "manufacturer": "Broadcom"},
            },
            {"id": "n2", "kind": "component", "label": "RP1", "aliases": [], "external_ids": {}},
            {
                "id": "n3",
                "kind": "component",
                "label": "LPDDR4X-4267 SDRAM",
                "aliases": [],
                "external_ids": {},
            },
        ]
    }
    # Bare part number resolves to the node that recorded it; a maker prefix stated by the
    # finding is stripped; an unknown maker prefix does not match.
    assert resolve_entity(graph, "component", "BCM2712")[0]["id"] == "n1"
    assert (
        resolve_entity(graph, "component", "Cypress RP1", manufacturer="Cypress")[0]["id"] == "n2"
    )
    assert resolve_entity(graph, "component", "Cypress RP1") == (None, None)
    # Containment and shared part-number tokens are review signals, never merges.
    assert [n["id"] for n in near_duplicates(graph, "component", "RP1 southbridge")] == ["n2"]
    assert [n["id"] for n in near_duplicates(graph, "component", "LPDDR4X RAM")] == ["n3"]
    assert [
        n["id"] for n in near_duplicates(graph, "component", "Raspberry Pi RP1 south bridge")
    ] == ["n2"]
    assert near_duplicates(graph, "component", "Sony UK Technology Centre") == []
    assert near_duplicates(graph, "material", "RP1") == []  # kind must match
    assert software_artifact("brcmfmac43455-sdio.bin") and software_artifact("brcmfmac driver")
    assert not software_artifact("Arm Cortex-A76 CPU cluster")
    from app.resolution import interface_feature

    for label in ("USB 3.0 Ports", "Wi-Fi 6 (802.11ax)", "40-pin GPIO header", "Gigabit Ethernet"):
        assert interface_feature(label), label
    assert not interface_feature("Broadcom BCM54213 PHY")
    assert not interface_feature("micro-HDMI connector", part_number="10118194")
    assert not interface_feature("Molex CSI connector", manufacturer="Molex")


class SoftwareProvider(PageProvider):
    name = "test_software"

    async def analyze(self, target, product, company, url, title, body, budget):
        self.analyzed.append(target["label"])
        findings = []
        if target["kind"] == "product":
            findings = [
                Finding("CYW43455", "component", "PART_OF", "Widget contains tin", "stated"),
                Finding(
                    "USB 3.0 Ports", "component", "PART_OF", "Widget contains tin", "interface"
                ),
                Finding(
                    "brcmfmac driver", "component", "INPUT_TO", "Widget contains tin", "software"
                ),
                Finding(
                    "Cypress CYW43455",
                    "component",
                    "PART_OF",
                    "Tin is refined by Acme Smelting",
                    "variant",
                    manufacturer="Cypress",
                ),
                Finding(
                    "CYW43455 wireless module",
                    "component",
                    "PART_OF",
                    "Widget contains tin and a battery",
                    "near duplicate",
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_software_is_rejected_variants_merge_by_maker_and_near_duplicates_are_flagged(api):
    client, app = api
    app.state.worker.provider = SoftwareProvider()
    run, graph = await researched(api, "Widget")
    labels = {n["label"]: n for n in graph["nodes"]}
    assert set(labels) == {"Widget", "CYW43455", "CYW43455 wireless module"}
    # "Cypress CYW43455" merged into CYW43455 by stated maker prefix, recording the alias.
    assert "Cypress CYW43455" in labels["CYW43455"]["aliases"]
    events = sse_events(await client.get(run["events_url"]))
    reviews = [e["payload"]["reason"] for e in events if e["type"] == "entity.review_needed"]
    assert any(r.startswith("near_duplicate") and "CYW43455 wireless module" in r for r in reviews)
    rejected = {e["payload"]["detail"] for e in events if e["type"] == "claim.rejected"}
    assert {"software", "interface"} <= rejected


def test_relevance_gate_accepts_pages_that_name_only_the_part_number():
    from app.worker import Worker

    run = {"product": "Raspberry Pi 5"}
    body = "CYW43455 single-chip 802.11ac Wi-Fi and Bluetooth combo. " * 60
    assert Worker.relevant(body, run, {"label": "CYW43455 combo chip", "aliases": []})
    assert Worker.relevant(
        body, run, {"label": "Infineon Wi-Fi chip", "external_ids": {"mpn": "CYW43455"}}
    )
    assert not Worker.relevant(body, run, {"label": "BCM54213 Gigabit Ethernet PHY", "aliases": []})


def test_resolution_candidates_and_preferred_label():
    from app.resolution import preferred_label, resolution_candidates

    graph = {
        "nodes": [
            {"id": "p", "kind": "product", "label": "Widget", "aliases": []},
            {"id": "rp1", "kind": "component", "label": "RP1", "aliases": []},
            {"id": "dma", "kind": "component", "label": "8-channel DMA controller", "aliases": []},
            {"id": "pll", "kind": "component", "label": "PLL", "aliases": []},
            {"id": "tin", "kind": "material", "label": "tin", "aliases": []},
        ],
        "edges": [
            {"source_node_id": "dma", "target_node_id": "rp1", "predicate": "PART_OF"},
            {"source_node_id": "pll", "target_node_id": "rp1", "predicate": "PART_OF"},
            {"source_node_id": "tin", "target_node_id": "rp1", "predicate": "INPUT_TO"},
            {"source_node_id": "rp1", "target_node_id": "p", "predicate": "PART_OF"},
        ],
    }
    # Siblings under the same anchor of the same kind, plus token near-duplicates anywhere.
    labels = [
        n["label"]
        for n in resolution_candidates(graph, "component", "eight-channel DMA controller", "rp1")
    ]
    # Siblings under the anchor, best shared-word match first; the anchor itself is never a
    # candidate, and cousins under the anchor's own whole (here none) come after siblings.
    assert labels == ["8-channel DMA controller", "PLL"]
    assert resolution_candidates(graph, "component", "eight-channel DMA controller") == []
    graph["nodes"].append(
        {"id": "cam", "kind": "component", "label": "48MP Main camera", "aliases": []}
    )
    graph["nodes"].append({"id": "cams", "kind": "component", "label": "cameras", "aliases": []})
    graph["edges"] += [
        {"source_node_id": "cam", "target_node_id": "p", "predicate": "PART_OF"},
        {"source_node_id": "cams", "target_node_id": "p", "predicate": "PART_OF"},
    ]
    cousins = [
        n["label"] for n in resolution_candidates(graph, "component", "rear wide camera", "cams")
    ]
    assert cousins[0] == "48MP Main camera" and "cameras" not in cousins
    assert preferred_label("D0 stepping of the BCM2712 application processor", "BCM2712")
    assert not preferred_label("Broadcom BCM2712", "BCM2712")  # short names are kept
    assert preferred_label("Dialog/Renesas power chip", "Renesas DA9091")
    assert not preferred_label("RP1 chip", "RP1")
    assert not preferred_label("D0 stepping of the BCM2712 application processor", "the chip")


class ResolvingProvider(PageProvider):
    """Two pages describe RP1's DMA block in different words; the model says they match."""

    name = "test_resolving"
    bodies = {
        "one": "Widget uses the RP1 chip. RP1 has an 8-channel DMA controller. RP1 contains a PLL.",
        "two": "RP1 also has an eight-channel direct memory access (DMA) controller inside.",
    }

    def __init__(self):
        super().__init__()
        self.resolve_calls = []

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        which = query.rsplit(" ", 1)[-1]
        return [Page(url=f"https://example.org/{which}", title=which, body=self.bodies[which])]

    async def resolve(self, product, items, budget):
        from app.providers import ResolutionItem

        self.resolve_calls.append(items)
        out = []
        for item in items:
            match = next(
                (c["index"] for c in item["candidates"] if "8-channel" in c["label"]), None
            )
            out.append(
                ResolutionItem(
                    index=item["index"],
                    match=match,
                    verdict="same" if match is not None else "different",
                    rationale="same block, spelled out",
                )
            )
        return out

    async def analyze(self, target, product, company, url, title, body, budget):
        # Harvesting: every stated relation on the page, whatever the target.
        self.analyzed.append(target["label"])
        rp1 = {"object_label": "RP1", "object_kind": "component", "scope_type": "generic"}
        if url.endswith("one"):
            findings = [
                Finding("RP1", "component", "PART_OF", "Widget uses the RP1 chip", "stated"),
                Finding(
                    "8-channel DMA controller",
                    "component",
                    "PART_OF",
                    "RP1 has an 8-channel DMA controller",
                    "a",
                    **rp1,
                ),
                Finding("PLL", "component", "PART_OF", "RP1 contains a PLL", "b", **rp1),
            ]
        else:
            findings = [
                Finding(
                    "eight-channel direct memory access (DMA) controller",
                    "component",
                    "PART_OF",
                    "eight-channel direct memory access (DMA) controller inside",
                    "paraphrase",
                    **rp1,
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


@pytest.mark.parametrize("mode", ["merge", "flag"])
async def test_model_resolution_merges_or_flags_paraphrase_duplicates(api, mode):
    client, app = api
    app.state.worker.settings = app.state.worker.settings.model_copy(
        update={"model_resolution": mode}
    )
    provider = ResolvingProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget", limits={"max_hops": 3})
    labels = {n["label"]: n for n in graph["nodes"]}
    events = sse_events(await client.get(run["events_url"]))
    # One resolution call, for the second page: the paraphrase had siblings to compare with, and
    # the model saw only that short sibling list. Cross-document paraphrases are the case this
    # exists for; within one document the extraction prompt asks for consistent labels. The RP1
    # task then reused both stored analyses without any further model call.
    assert len(provider.resolve_calls) == 1
    assert provider.analyzed == ["Widget", "Widget"]
    item = provider.resolve_calls[0][0]
    assert item["label"].startswith("eight-channel")
    assert {c["label"] for c in item["candidates"]} <= {"8-channel DMA controller", "PLL"}
    if mode == "merge":
        assert "eight-channel direct memory access (DMA) controller" not in labels
        dma = labels["8-channel DMA controller"]
        assert "eight-channel direct memory access (DMA) controller" in dma["aliases"]
        merged = [e["payload"] for e in events if e["type"] == "entity.merged"]
        assert merged and merged[0]["resolver"] == "model" and merged[0]["node_id"] == dma["id"]
        # Both spans became claims on one edge.
        edge = next(e for e in graph["edges"] if e["source_node_id"] == dma["id"])
        assert len(edge["claim_ids"]) == 2
    else:
        assert "eight-channel direct memory access (DMA) controller" in labels
        reasons = [e["payload"]["reason"] for e in events if e["type"] == "entity.review_needed"]
        assert any(r.startswith("model_unsure") for r in reasons)
        assert not any(e["type"] == "entity.merged" for e in events)


class OverlappingProvider(PageProvider):
    """Records how many analyses are in flight at once; each tier-1 task blocks until released."""

    name = "test_overlap"

    def __init__(self):
        super().__init__()
        self.in_flight = 0
        self.peak = 0
        self.gate = None

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        # A distinct page per query, so nothing is reused across the concurrent tasks.
        return [Page(url=f"https://example.org/{query}", title=query, body=f"{self.body} {query}")]

    async def analyze(self, target, product, company, url, title, body, budget):
        import asyncio

        self.analyzed.append(target["label"])
        findings = []
        if target["kind"] == "product":
            findings = [
                Finding(label, "material", "INPUT_TO", "Widget contains tin", "stated")
                for label in ("tin", "cobalt", "nickel")
            ]
        else:
            self.in_flight += 1
            self.peak = max(self.peak, self.in_flight)
            # Wait until every pool slot has arrived, then let all through together.
            if self.in_flight >= 3:
                self.gate.set()
            await asyncio.wait_for(self.gate.wait(), 5)
            self.in_flight -= 1
        return Document(url, title, "example.org", body, findings=findings)


async def test_task_pool_overlaps_branches_and_serializes_commits(api):
    import asyncio

    client, app = api
    app.state.worker.settings = app.state.worker.settings.model_copy(update={"task_concurrency": 3})
    provider = OverlappingProvider()
    provider.gate = asyncio.Event()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    assert provider.peak == 3  # three tier-1 branches were researched at the same time
    assert run["status"] == "partial" and run["stop_reason"] == "research_exhausted"
    assert run["progress"] == {"tasks_done": 4, "tasks_total": 4}
    events = sse_events(await client.get(run["events_url"]))
    started = [e["payload"]["depth"] for e in events if e["type"] == "task.started"]
    assert started == [0, 1, 1, 1]
    # Fair start: the three concurrent tasks came from three different branches.
    targets = {e["payload"]["target_node_id"] for e in events if e["type"] == "task.started"}
    assert len(targets) == 4


async def test_budget_stop_in_one_pooled_task_ends_the_run_cleanly(api):
    import asyncio
    import time

    client, app = api
    app.state.worker.settings = app.state.worker.settings.model_copy(update={"task_concurrency": 3})
    provider = OverlappingProvider()
    provider.gate = asyncio.Event()
    app.state.worker.provider = provider
    started = time.monotonic()
    # The root reads two documents; of the three concurrent tier-1 tasks only one can charge the
    # third. The others hit the cap, and the task still waiting on its gate is cancelled rather
    # than left to time out.
    run, graph = await researched(api, "Widget", limits={"max_documents": 3})
    assert time.monotonic() - started < 3
    assert run["status"] == "partial" and run["stop_reason"] == "budget_exhausted"
    assert run["usage"]["binding_limit"] == "max_documents"
    assert run["usage"]["documents"] == 3
    assert provider.in_flight == 1  # the cancelled analysis never returned


class CorroboratingProvider(PageProvider):
    """Five distinct pages state the same relation."""

    name = "test_corroboration"

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        return [
            Page(url=f"https://example{i}.org/widget", title="Widget", body=f"{self.body} {i}")
            for i in range(5)
        ]

    async def analyze(self, target, product, company, url, title, body, budget):
        findings = []
        if target["kind"] == "product":
            findings = [Finding("tin", "material", "INPUT_TO", "Widget contains tin", "stated")]
        return Document(url, title, "example.org", body, findings=findings)


async def test_corroboration_stops_at_four_sources_per_relation(api):
    client, app = api
    app.state.worker.provider = CorroboratingProvider()
    run, graph = await researched(api, "Widget", limits={"max_documents_per_task": 6})
    edge = next(e for e in graph["edges"] if e["predicate"] == "INPUT_TO")
    assert len(edge["claim_ids"]) == 4 and len(edge["source"]) == 4
    events = sse_events(await client.get(run["events_url"]))
    # Two queries shared the six-document allowance: six pages read, four sources kept.
    assert [e["payload"]["reason"] for e in events if e["type"] == "claim.rejected"] == [
        "duplicate",
        "duplicate",
    ]


class ConflictProvider(PageProvider):
    """The same PMIC appears under its old and new maker; the model confirms the acquisition."""

    name = "test_conflict"
    bodies = {
        "one": "Widget uses the Dialog DA9091 PMIC.",
        "two": "The Renesas DA9091 powers Widget.",
    }

    def __init__(self):
        super().__init__()
        self.resolve_calls = []

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        which = query.rsplit(" ", 1)[-1]
        return [Page(url=f"https://example.org/{which}", title=which, body=self.bodies[which])]

    async def resolve(self, product, items, budget):
        from app.providers import ResolutionItem

        self.resolve_calls.append(items)
        return [
            ResolutionItem(
                index=i["index"], match=0, verdict="same", rationale="Renesas acquired Dialog"
            )
            for i in items
        ]

    async def analyze(self, target, product, company, url, title, body, budget):
        if target["kind"] != "product":
            return Document(url, title, "example.org", body, findings=[])
        if url.endswith("one"):
            finding = Finding(
                "Dialog DA9091",
                "component",
                "PART_OF",
                "Widget uses the Dialog DA9091 PMIC",
                "stated",
                part_number="DA9091",
                manufacturer="Dialog",
            )
        else:
            finding = Finding(
                "Renesas DA9091",
                "component",
                "PART_OF",
                "The Renesas DA9091 powers Widget",
                "stated",
                part_number="DA9091",
                manufacturer="Renesas",
            )
        return Document(url, title, "example.org", body, findings=[finding])


async def test_manufacturer_only_identifier_conflicts_can_be_resolved_by_the_model(api):
    client, app = api
    provider = ConflictProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    parts = [n for n in graph["nodes"] if n["kind"] == "component"]
    assert len(parts) == 1
    assert parts[0]["label"] == "Dialog DA9091" and "Renesas DA9091" in parts[0]["aliases"]
    assert parts[0]["external_ids"] == {"mpn": "DA9091", "manufacturer": "Dialog"}
    assert provider.resolve_calls[0][0]["candidates"][0]["label"] == "Dialog DA9091"
    events = sse_events(await client.get(run["events_url"]))
    assert not any(
        e["type"] == "claim.rejected" and e["payload"]["reason"] == "identifier_conflict"
        for e in events
    )
    merged = [e["payload"] for e in events if e["type"] == "entity.merged"]
    assert merged and merged[0]["alias"] == "Renesas DA9091"


def test_accessories_are_not_parts_and_predicates_are_normalized_by_kind():
    from app.resolution import accessory, normalized_predicate, static_rejection

    assert accessory("USB-C Charge Cable (1 m)") and accessory("Official Raspberry Pi 5 Case")
    assert not accessory("display flex cable", part_number="821-01234")
    assert not accessory("Ceramic Shield front cover glass", manufacturer="Corning")
    assert (
        static_rejection(
            "component",
            "USB-C Charge Cable (1 m)",
            "PART_OF",
            "product",
            "iPhone",
            "product",
            "iPhone",
        )
        == "predicate_invalid"
    )
    assert normalized_predicate("PART_OF", "material", "product") == "INPUT_TO"
    assert normalized_predicate("INPUT_TO", "component", "component") == "PART_OF"
    assert normalized_predicate("INPUT_TO", "material", "component") == "INPUT_TO"
    assert normalized_predicate("PART_OF", "component", "product") == "PART_OF"


class DanglingWholeProvider(PageProvider):
    """A material is stated to be part of a board; a second page may or may not tie the board
    to the product."""

    name = "test_dangling"
    connects = False

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        which = query.rsplit(" ", 1)[-1]
        if which == "two" and not self.connects:
            return []
        # Distinct bodies, so the second page is not treated as a reuse of the first.
        return [Page(url=f"https://example.org/{which}", title=which, body=f"{self.body} {which}")]

    async def analyze(self, target, product, company, url, title, body, budget):
        findings = []
        if target["kind"] == "product" and url.endswith("one"):
            findings = [
                Finding("tin", "material", "PART_OF", "Widget contains tin", "material as part"),
                Finding(
                    "tin",
                    "material",
                    "INPUT_TO",
                    "Tin is refined by Acme Smelting",
                    "whole not yet connected",
                    object_label="main logic board",
                    object_kind="component",
                ),
            ]
        elif target["kind"] == "product":
            findings = [
                Finding(
                    "main logic board",
                    "component",
                    "PART_OF",
                    "Widget contains tin and a battery",
                    "connects the board",
                )
            ]
        return Document(url, title, "example.org", body, findings=findings)


@pytest.mark.parametrize("connects", [False, True])
async def test_a_whole_is_never_created_from_a_claim_about_its_part(api, connects):
    client, app = api
    provider = DanglingWholeProvider()
    provider.connects = connects
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    labels = {n["label"]: n for n in graph["nodes"]}
    events = sse_events(await client.get(run["events_url"]))
    rejected = [e["payload"]["reason"] for e in events if e["type"] == "claim.rejected"]
    predicates = sorted(e["predicate"] for e in graph["edges"])
    if connects:
        # The second page tied the board to the product, so the orphaned material claim was
        # committed on retry and the board became a tier-1 part with tin under it at tier 2.
        assert set(labels) == {"Widget", "tin", "main logic board"}
        assert labels["main logic board"]["tier"] == 1
        assert predicates == ["INPUT_TO", "INPUT_TO", "PART_OF"]
        assert rejected == []
    else:
        assert set(labels) == {"Widget", "tin"}
        assert predicates == ["INPUT_TO"]  # the material PART_OF claim committed as INPUT_TO
        # Rejected once, at the end of the run, after retries found no whole to attach to.
        assert rejected == ["disconnected"]
        kinds = [e["type"] for e in events]
        assert kinds.index("claim.rejected") > len(kinds) - 1 - kinds[::-1].index("task.finished")


def test_spec_tokens_and_slug_labels():
    from app.resolution import part_tokens, tidy_label

    assert part_tokens("12mp ultrawide snapper") == set()
    assert part_tokens("kioxia 256gb nand") == set()
    assert part_tokens("100% recycled cobalt 2023") == set()  # bare numbers are not identities
    assert part_tokens("bcm2712 a76") == {"bcm2712", "a76"}
    assert (
        near_duplicates(
            {"nodes": [{"id": "a", "kind": "component", "label": "12MP telephoto shooter"}]},
            "component",
            "12MP ultrawide snapper",
        )
        == []
    )
    assert tidy_label("kioxia-256gb-nand-flash-memory") == "kioxia 256gb nand flash memory"
    assert tidy_label("Ti-6Al-4V") == "Ti-6Al-4V" and tidy_label("Cortex-A76") == "Cortex-A76"


def test_locate_span_tolerates_whitespace_citations_and_typographic_punctuation():
    from app.resolution import locate_span

    body = (
        "The iPhone 15 Pro is powered by the A17 Pro,[12] a 3‑nm chip.\n"
        "Apple’s Taptic Engine uses   100% recycled\ntungsten. Raw Materials Supply\n\n"
        "Major Suppliers: GlobalWafers, SUMCO."
    )
    assert locate_span(body, "Taptic Engine uses") == "Taptic Engine uses"
    assert locate_span(body, "uses 100% recycled tungsten") == "uses   100% recycled\ntungsten"
    assert locate_span(body, "the A17 Pro, a 3-nm chip") == "the A17 Pro,[12] a 3‑nm chip"
    assert locate_span(body, "Apple's Taptic Engine") == "Apple’s Taptic Engine"
    assert (
        locate_span(body, "Raw Materials Supply Major Suppliers: GlobalWafers")
        == "Raw Materials Supply\n\nMajor Suppliers: GlobalWafers"
    )
    assert locate_span(body, "the A18 Pro") is None
    assert locate_span(body, "") is None


class SelfLoopProvider(PageProvider):
    """A part number and its maker-prefixed name resolve to one node; a relation between the
    two names is a relation from the node to itself."""

    name = "test_selfloop"

    async def analyze(self, target, product, company, url, title, body, budget):
        findings = []
        if target["kind"] == "product":
            findings = [
                Finding(
                    "Broadcom BCM2712",
                    "component",
                    "PART_OF",
                    "Widget contains tin",
                    "a",
                    part_number="BCM2712",
                    manufacturer="Broadcom",
                ),
                Finding(
                    "BCM2712",
                    "component",
                    "PART_OF",
                    "Widget contains tin and a battery",
                    "self loop through the recorded part number",
                    object_label="Broadcom BCM2712",
                    object_kind="component",
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_a_relation_between_two_names_of_one_node_is_rejected(api):
    client, app = api
    app.state.worker.provider = SelfLoopProvider()
    run, graph = await researched(api, "Widget")
    assert {n["label"] for n in graph["nodes"]} == {"Widget", "Broadcom BCM2712"}
    assert len(graph["edges"]) == 1
    events = sse_events(await client.get(run["events_url"]))
    # Rejected for the product task and again when the BCM2712 task reused the analysis.
    assert [e["payload"]["reason"] for e in events if e["type"] == "claim.rejected"] == [
        "predicate_invalid",
        "predicate_invalid",
    ]


class ScopedProvider(PageProvider):
    """The same relation is stated once generically and once for the product."""

    name = "test_scoped"

    async def analyze(self, target, product, company, url, title, body, budget):
        findings = []
        if target["kind"] == "product":
            findings = [
                Finding(
                    "tin",
                    "material",
                    "INPUT_TO",
                    "Widget contains tin",
                    "generic first",
                    scope_type="generic",
                    object_label="Acme Smelting",
                    object_kind="component",
                ),
                Finding(
                    "Acme Smelting",
                    "component",
                    "PART_OF",
                    "Tin is refined by Acme Smelting",
                    "connects",
                ),
                Finding(
                    "tin",
                    "material",
                    "INPUT_TO",
                    "Widget contains tin and a battery",
                    "then product scope",
                    object_label="Acme Smelting",
                    object_kind="component",
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_one_edge_per_relation_takes_the_strongest_scope(api):
    client, app = api
    app.state.worker.provider = ScopedProvider()
    run, graph = await researched(api, "Widget")
    labels = {n["label"]: n for n in graph["nodes"]}
    tin_edges = [e for e in graph["edges"] if e["source_node_id"] == labels["tin"]["id"]]
    assert len(tin_edges) == 1
    assert tin_edges[0]["scope"]["type"] == "product" and len(tin_edges[0]["claim_ids"]) == 2
    claims = {c["id"]: c for c in graph["claims"]}
    assert sorted(claims[i]["scope"]["type"] for i in tin_edges[0]["claim_ids"]) == [
        "generic",
        "product",
    ]


def test_gazetteer_resolves_places_with_precision():
    from app.gazetteer import Gazetteer

    g = Gazetteer()
    city = g.resolve("Harrodsburg, Kentucky")
    assert (city["country_iso2"], city["precision"], city["city"]) == ("US", "city", "Harrodsburg")
    assert g.resolve("Hsinchu Science Park")["city"] == "Hsinchu"
    assert g.resolve("Pencoed, South Wales")["country_iso2"] == "GB"
    region = g.resolve("Kentucky")
    assert (region["precision"], region["admin1"]) == ("region", "Kentucky")
    country = g.resolve("Taiwan")
    assert (country["country_iso2"], country["precision"]) == ("TW", "country")
    assert g.resolve("Somewhere", "US")["precision"] == "country"  # extractor's code, centroid
    assert g.resolve("Nowhere") is None
    # A city must agree with a named region or country: no French Paris in Texas.
    texas = g.resolve("Paris, Texas")
    assert (texas["country_iso2"], texas["precision"], texas["admin1"]) == ("US", "region", "Texas")


class SiteProvider(PageProvider):
    """A teardown names an assembler with a stated share; a press page names its plant and
    the plant's city."""

    name = "test_sites"
    bodies = {
        "one": "Pegatron assembles 30% of Widget units. Widget contains tin.",
        "two": "Pegatron operates the Kunshan plant in Kunshan, Jiangsu. The Kunshan plant builds Widget.",
    }

    async def search_pages(self, query, count, budget, **kwargs):
        budget.charge("searches")
        which = query.rsplit(" ", 1)[-1]
        return [Page(url=f"https://example.org/{which}", title=which, body=self.bodies[which])]

    async def analyze(self, target, product, company, url, title, body, budget):
        self.analyzed.append(target["label"])
        findings = []
        if url.endswith("one"):
            findings = [
                Finding(
                    "Pegatron",
                    "organization",
                    "MANUFACTURES",
                    "Pegatron assembles 30% of Widget units",
                    "stated share",
                    share=0.3,
                ),
                Finding("tin", "material", "INPUT_TO", "Widget contains tin", "stated"),
            ]
        else:
            # Harvesting: the plant relations are on the page whatever the target.
            findings = [
                Finding(
                    "Pegatron",
                    "organization",
                    "OPERATES",
                    "Pegatron operates the Kunshan plant",
                    "plant",
                    object_label="Kunshan plant",
                    object_kind="facility",
                ),
                Finding(
                    "Kunshan plant",
                    "facility",
                    "LOCATED_IN",
                    "Pegatron operates the Kunshan plant in Kunshan, Jiangsu",
                    "place",
                    scope_type="product",  # normalized to generic
                    object_label="Kunshan, Jiangsu",
                    object_kind="geography",
                    country_iso2="CN",
                ),
                Finding(
                    "Kunshan plant",
                    "facility",
                    "MANUFACTURES",
                    "The Kunshan plant builds Widget",
                    "plant makes the product",
                    object_label="Widget",
                    object_kind="product",
                ),
            ]
        return Document(url, title, "example.org", body, findings=findings)


async def test_makers_are_located_and_shares_become_distributions(api):
    client, app = api
    provider = SiteProvider()
    app.state.worker.provider = provider
    run, graph = await researched(api, "Widget")
    labels = {n["label"]: n for n in graph["nodes"]}
    # The organization became a research target at depth 1 (after the parts); its pages had
    # already been analyzed for the product, so it reused them without a model call.
    events = sse_events(await client.get(run["events_url"]))
    planned = {
        e["payload"]["target_node_id"]: e["payload"]["depth"]
        for e in events
        if e["type"] == "task.planned"
    }
    assert planned[labels["Pegatron"]["id"]] == 1
    assert labels["Kunshan plant"]["id"] in planned  # the plant is a target too
    assert "Kunshan, Jiangsu" not in {n["label"] for n in graph["nodes"] if n["id"] in planned}
    assert provider.analyzed == ["Widget", "Widget"]
    place = labels["Kunshan, Jiangsu"]
    assert place["external_ids"]["iso2"] == "CN"
    assert place["data"]["geography"]["precision"] == "city"
    plant = labels["Kunshan plant"]
    layer = plant["data"]["geography"]
    assert (layer["country_iso2"], layer["address"], layer["lat"]) == ("CN", "Kunshan", 31.39)
    located = next(e for e in graph["edges"] if e["predicate"] == "LOCATED_IN")
    assert layer["claim_ids"] == located["claim_ids"] and located["scope"]["type"] == "generic"
    # The stated share sits on the edge and in the distribution; the plant carries it as a
    # labelled prior split over the operator's located plants.
    makes = next(
        e
        for e in graph["edges"]
        if e["predicate"] == "MANUFACTURES" and e["source_node_id"] == labels["Pegatron"]["id"]
    )
    assert makes["data"]["operational"]["weight"] == 0.3
    assert makes["data"]["custom"]["share"]["basis"] == "stated"
    sites = (await client.get(f"/v1/graphs/{run['graph_id']}/sites")).json()
    dist = next(
        d
        for d in sites["distributions"]
        if d["family"] == "makers" and d["target_label"] == "Widget"
    )
    assert dist["stated_total"] == 0.3 and dist["unassigned"] == 0.7
    by_label = {e["label"]: e for e in dist["entries"]}
    assert by_label["Pegatron"]["share"] == 0.3
    assert by_label["Kunshan plant"]["share"] is None
    assert by_label["Kunshan plant"]["share_estimate"] == 0.7  # the only unstated source
    pin = next(s for s in sites["sites"] if s["label"] == "Kunshan plant")
    assert (pin["country_iso2"], pin["city"], pin["precision"]) == ("CN", "Kunshan", "city")
    assert pin["role"] == "plant"
    assert pin["location_sources"] == ["https://example.org/two"]
    assert pin["operators"][0]["label"] == "Pegatron"
    widget_row = next(m for m in pin["makes"] if m["label"] == "Widget")
    assert widget_row["share_basis"] in {"uniform_prior", "stated_over_plants"}
    # Pegatron itself has no place of its own, so it is not a pin.
    assert not any(s["label"] == "Pegatron" for s in sites["sites"])


def test_enrichment_locations_without_coordinates_get_gazetteer_centres():
    from app.gazetteer import Gazetteer
    from app.worker import Worker

    worker = Worker.__new__(Worker)
    worker.gazetteer = Gazetteer()
    node = {"id": "f1", "kind": "facility", "label": "Foxconn Zhengzhou factory", "data": {}}
    layer = {
        "country_iso2": "CN",
        "admin1": None,
        "lat": None,
        "lon": None,
        "address": "Zhengzhou, Henan, China",
        "precision": "address",
        "claim_ids": ["clm_1"],
    }
    worker.fill_coordinates(node, layer)
    assert (layer["lat"], layer["lon"], layer["precision"]) == (34.75, 113.63, "city")
    assert layer["address"] == "Zhengzhou, Henan, China"
    assert node["data"]["custom"]["geocoding"]["method"] == "gazetteer_v1"
    # A place the gazetteer does not know falls back to the country centre, at country precision.
    unknown = {**layer, "lat": None, "lon": None, "address": "Somewhere obscure"}
    worker.fill_coordinates(node, unknown)
    assert (unknown["lat"], unknown["precision"]) == (35.9, "country")
    # Coordinates already stated by the source are never overwritten.
    stated = {**layer, "lat": 34.7, "lon": 113.6, "precision": "address"}
    worker.fill_coordinates(node, stated)
    assert (stated["lat"], stated["precision"]) == (34.7, "address")

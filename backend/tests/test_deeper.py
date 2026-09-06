"""Deeper-graph loop: harvesting, resolution, reuse, fair scheduling, planning, and diagnostics."""

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers import Document, Finding, FixtureProvider, Page, Plan, ProviderFailure
from app.resolution import normalize_label, record_identity, resolve_entity, select_passages
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
    assert provider.analyzed.count("tin") == 1  # a different question re-analyzes the same page
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
    assert provider.queries[0][1] == 2
    assert "tin" in {n["label"] for n in graph["nodes"]}
    history = (await client.get(f"/v1/runs/{run['id']}/history")).json()["entries"]
    skipped = [e for e in history if e.get("skipped") == "no mention of product or target"]
    # Four unrelated filings per "one" query (root and tin tasks) were skipped without a call.
    assert len(skipped) == 8 and provider.analyzed.count("Widget") == 1


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
    labels = {
        n["label"]
        for n in resolution_candidates(graph, "component", "eight-channel DMA controller", "rp1")
    }
    assert labels == {"8-channel DMA controller", "PLL"}
    assert resolution_candidates(graph, "component", "eight-channel DMA controller") == []
    assert preferred_label("D0 stepping of the BCM2712 application processor", "BCM2712")
    assert not preferred_label("Broadcom BCM2712", "BCM2712")  # short names are kept
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
        self.analyzed.append(target["label"])
        findings = []
        if target["kind"] == "product" and url.endswith("one"):
            findings = [
                Finding("RP1", "component", "PART_OF", "Widget uses the RP1 chip", "stated")
            ]
        elif target["label"] == "RP1" and url.endswith("one"):
            findings = [
                Finding(
                    "8-channel DMA controller",
                    "component",
                    "PART_OF",
                    "RP1 has an 8-channel DMA controller",
                    "a",
                ),
                Finding("PLL", "component", "PART_OF", "RP1 contains a PLL", "b"),
            ]
        elif target["label"] == "RP1":
            findings = [
                Finding(
                    "eight-channel direct memory access (DMA) controller",
                    "component",
                    "PART_OF",
                    "eight-channel direct memory access (DMA) controller inside",
                    "paraphrase",
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
    # One resolution call, for the second RP1 page: the paraphrase had siblings to compare with,
    # and the model saw only that short sibling list. Cross-document paraphrases are the case
    # this exists for; within one document the extraction prompt asks for consistent labels.
    assert len(provider.resolve_calls) == 1
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
    # The root reads one document; of the three concurrent tier-1 tasks only one can charge the
    # second. The others hit the cap, and the task still waiting on its gate is cancelled rather
    # than left to time out.
    run, graph = await researched(api, "Widget", limits={"max_documents": 2})
    assert time.monotonic() - started < 3
    assert run["status"] == "partial" and run["stop_reason"] == "budget_exhausted"
    assert run["usage"]["binding_limit"] == "max_documents"
    assert run["usage"]["documents"] == 2
    assert provider.in_flight == 1  # the cancelled analysis never returned

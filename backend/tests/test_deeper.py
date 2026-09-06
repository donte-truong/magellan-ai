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

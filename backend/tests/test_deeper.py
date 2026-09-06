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

    async def search_pages(self, query, count, budget):
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
    assert any("abandoned" in q for q in run["open_questions"])
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

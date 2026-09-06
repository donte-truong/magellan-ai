import asyncio

from app.providers import Document, Finding
from tests.conftest import researched, sse_events


async def test_public_evidence_corroborates_an_uploaded_row_without_losing_quantity_provenance(api):
    client, _ = api
    upload = (
        await client.post(
            "/v1/uploads",
            files={"file": ("bom.csv", "component,quantity,unit\nBroadcom BCM2712,1,ea")},
        )
    ).json()
    run, graph = await researched(api, upload_id=upload["id"])
    assert len(graph["edges"]) == 3
    bom = (await client.get(run["bom_url"])).json()
    processor = next(row for row in bom["items"] if row["name"] == "Broadcom BCM2712")
    assert processor["support_label"] == "directly_supported"
    assert processor["quantity"] == 1 and processor["quantity_support_label"] == "user_asserted"
    assert len(processor["claim_ids"]) == 2
    inspector = (await client.get(f"/v1/graphs/{graph['id']}/edges/{processor['edge_id']}")).json()
    assert inspector["evidence_summary"]["source_count"] == 2
    public_claim = next(
        c for c in inspector["claims"] if c["support_label"] == "directly_supported"
    )
    await client.post(f"/v1/claims/{public_claim['id']}/review", json={"verdict": "reject"})
    processor = next(
        row
        for row in (await client.get(run["bom_url"])).json()["items"]
        if row["name"] == "Broadcom BCM2712"
    )
    assert processor["support_label"] == "user_asserted"
    events = sse_events(await client.get(run["events_url"]))
    assert any(e["type"] == "edge.updated" for e in events)
    assert all(e["payload"]["source_id"] for e in events if e["type"] == "source.retrieved")


async def test_generic_branches_do_not_become_product_bom_rows(api):
    client, _ = api
    run, graph = await researched(api, "Widget")
    ops = [
        {
            "op": "add_node",
            "temp_id": "battery",
            "node": {"kind": "component", "label": "Generic battery"},
        },
        {"op": "add_node", "temp_id": "cobalt", "node": {"kind": "material", "label": "cobalt"}},
        {
            "op": "add_edge",
            "edge": {
                "source_node_id": "battery",
                "target_node_id": graph["root_node_id"],
                "predicate": "PART_OF",
                "scope": {"type": "generic"},
            },
        },
        {
            "op": "add_edge",
            "edge": {
                "source_node_id": "cobalt",
                "target_node_id": "battery",
                "predicate": "INPUT_TO",
                "scope": {"type": "product"},
            },
        },
    ]
    response = await client.post(
        f"/v1/graphs/{graph['id']}/mutations",
        headers={"If-Match": str(graph["revision"])},
        json={"ops": ops},
    )
    assert response.status_code == 200
    assert (await client.get(run["bom_url"])).json()["items"] == []


async def test_geography_job_commits_location_evidence_and_geojson(api):
    client, app = api
    _, graph = await researched(api, "Widget")
    response = await client.post(
        f"/v1/graphs/{graph['id']}/mutations",
        headers={"If-Match": str(graph["revision"])},
        json={
            "ops": [
                {
                    "op": "add_node",
                    "temp_id": "plant",
                    "node": {"kind": "facility", "label": "Example Plant"},
                }
            ]
        },
    )
    assert response.status_code == 200
    plant_id = response.json()["temp_id_map"]["plant"]

    class LocationProvider:
        name = "test"

        async def locate(self, node, budget):
            return Document(
                "https://example.org/plant",
                "Synthetic location evidence",
                "Example",
                "Example Plant is at 51.5, -0.1 in GB.",
                findings=[
                    Finding(
                        "Example Plant",
                        "facility",
                        "LOCATED_IN",
                        "Example Plant is at 51.5, -0.1 in GB.",
                        "Verified test location",
                        "generic",
                    )
                ],
                geography={
                    "country_iso2": "GB",
                    "lat": 51.5,
                    "lon": -0.1,
                    "precision": "address",
                    "claim_ids": [],
                },
            )

    app.state.worker.provider = LocationProvider()
    job = (
        await client.post(
            f"/v1/graphs/{graph['id']}/enrichments",
            json={"kinds": ["geography"], "node_ids": [plant_id]},
        )
    ).json()
    await app.state.worker.tick()
    result = (await client.get(f"/v1/graphs/{graph['id']}/enrichments/{job['id']}")).json()
    assert result["status"] == "completed" and result["results"][0]["outcome"] == "filled"
    features = (await client.get(f"/v1/graphs/{graph['id']}/geography")).json()["features"]
    assert features[0]["geometry"]["coordinates"] == [-0.1, 51.5]
    claim_id = features[0]["properties"]["claim_ids"][0]
    claim = (await client.get(f"/v1/claims/{claim_id}")).json()
    assert claim["predicate"] == "LOCATED_IN" and claim["evidence"][0]["span"]
    updated = (await client.get(f"/v1/graphs/{graph['id']}")).json()
    assert updated["stats"]["node_count"] == 3 and updated["stats"]["edge_count"] == 1


async def test_cancellation_during_provider_call_prevents_late_commits(api):
    client, app = api
    started, released = asyncio.Event(), asyncio.Event()

    class SlowProvider:
        name = "test"

        async def research(self, target, product, company, budget):
            started.set()
            await released.wait()
            yield Document(
                "https://example.org",
                "Test",
                "Example",
                "Widget contains tin.",
                findings=[Finding("tin", "material", "INPUT_TO", "Widget contains tin.", "Test")],
            )

    app.state.worker.provider = SlowProvider()
    run = (await client.post("/v1/runs", json={"product": "Widget"})).json()
    task = asyncio.create_task(app.state.worker.tick())
    await asyncio.wait_for(started.wait(), timeout=3)
    await client.post(f"/v1/runs/{run['id']}/cancel")
    released.set()
    await asyncio.wait_for(task, timeout=3)
    assert (await client.get(run["bom_url"])).json()["status"] == "cancelled"
    assert (await client.get(f"/v1/graphs/{run['graph_id']}")).json()["edges"] == []


async def test_wall_clock_budget_stops_a_stalled_provider(api):
    client, app = api

    class StalledProvider:
        name = "test"

        async def research(self, target, product, company, budget):
            await asyncio.sleep(30)
            if False:
                yield

    app.state.worker.provider = StalledProvider()
    run, graph = await researched(api, "Widget", limits={"max_seconds": 1})
    assert (
        run["stop_reason"] == "budget_exhausted" and run["usage"]["binding_limit"] == "max_seconds"
    )
    assert graph["edges"] == []

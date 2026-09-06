from copy import deepcopy

import pytest

from app.providers import LiveProvider
from tests.conftest import sse_events


async def estimate_for(client, description="Raspberry Pi 5 board"):
    response = await client.post("/v1/bom", json={"description": description})
    assert response.status_code == 200, response.text
    return response.json()


async def test_run_from_an_estimate_seeds_user_asserted_rows_then_verifies_afresh(api):
    client, app = api
    estimate = await estimate_for(client)
    response = await client.post(
        "/v1/runs", json={"product": "raspberry pi 5", "bom_estimate": estimate}
    )
    assert response.status_code == 202, response.text
    run = response.json()
    assert run["open_questions"][0].startswith(f"Seeded from BOM estimate {estimate['id']}: 3 item")
    assert "_bom_estimate" not in run and "_seed_urls" not in run
    assert await app.state.worker.tick()
    run = (await client.get(f"/v1/runs/{run['id']}")).json()
    assert run["status"] == "partial"
    graph = (await client.get(f"/v1/graphs/{run['graph_id']}?include=claims")).json()
    components = [n for n in graph["nodes"] if n["kind"] == "component"]
    assert {n["label"] for n in components} == {i["name"] for i in estimate["items"]}
    # Imported rows keep their original provenance on the node, never as evidence.
    for node in components:
        (record,) = node["data"]["custom"]["bom_items"]
        assert record["estimate_id"] == estimate["id"]
        assert record["provenance"] == "imported_not_independently_verified"
        assert record["basis"] == "evidenced" and record["sources"][0]["type"] == "web_page"
    # One edge per component: the imported claim plus fresh public corroboration on the same edge.
    assert len(graph["edges"]) == 3
    bom = (await client.get(run["bom_url"])).json()
    assert len(bom["items"]) == 3
    for row in bom["items"]:
        assert row["support_label"] == "directly_supported"
        assert len(row["claim_ids"]) >= 2
        detail = (await client.get(f"/v1/graphs/{graph['id']}/edges/{row['edge_id']}")).json()
        labels = {c["support_label"] for c in detail["claims"]}
        assert labels == {"user_asserted", "directly_supported"}
        imported = next(c for c in detail["claims"] if c["support_label"] == "user_asserted")
        assert imported["evidence"][0]["source"]["url"].startswith("urn:magellan:bom-estimate:")
        assert imported["evidence"][0]["locator"].startswith("BOM estimate item ")
        assert detail["data"]["custom"]["bom_estimate"]["item_id"]
        assert detail["data"]["custom"]["operational_provenance"] == {
            "support_label": "user_asserted"
        }
    events = sse_events(await client.get(run["events_url"]))
    # The root product plus the three imported components.
    assert sum(e["type"] == "node.added" for e in events) == 4
    export = (await client.get(f"/v1/graphs/{graph['id']}/export")).json()
    assert any(s["kind"] == "upload" for s in export["sources"])
    assert any(s["url"].startswith("https://") for s in export["sources"])


async def test_estimate_import_is_validated_before_any_research(api):
    client, app = api
    estimate = await estimate_for(client)

    async def rejected(payload, message):
        response = await client.post("/v1/runs", json=payload)
        assert response.status_code == 400, response.text
        assert message in response.text

    await rejected({"product": "Other product", "bom_estimate": estimate}, "must match")
    upload = (
        await client.post(
            "/v1/uploads", files={"file": ("bom.csv", "component,quantity\nWidget,1")}
        )
    ).json()
    await rejected(
        {"product": "Raspberry Pi 5", "upload_id": upload["id"], "bom_estimate": estimate},
        "not both",
    )
    cyclic = deepcopy(estimate)
    cyclic["items"][0]["parent_item_id"] = cyclic["items"][1]["id"]
    cyclic["items"][1]["parent_item_id"] = cyclic["items"][0]["id"]
    await rejected({"product": "Raspberry Pi 5", "bom_estimate": cyclic}, "without cycles")
    dangling = deepcopy(estimate)
    dangling["items"][0]["sources"][0]["source_id"] = "src_missing"
    await rejected({"product": "Raspberry Pi 5", "bom_estimate": dangling}, "missing source")
    private = deepcopy(estimate)
    private["items"][0]["sources"][0]["url"] = "http://127.0.0.1/secret"
    await rejected({"product": "Raspberry Pi 5", "bom_estimate": private}, "public HTTP")
    duplicate = deepcopy(estimate)
    duplicate["items"].append(deepcopy(duplicate["items"][0]))
    await rejected({"product": "Raspberry Pi 5", "bom_estimate": duplicate}, "Duplicate BOM item")
    running = deepcopy(estimate)
    running["status"] = "running"
    await rejected({"product": "Raspberry Pi 5", "bom_estimate": running}, "status")
    assert not await app.state.worker.tick()


async def test_estimate_assembly_row_and_extra_fields_are_kept_as_metadata(api):
    client, app = api
    estimate = await estimate_for(client)
    estimate["items"].append(
        {
            "id": "itm_assembly",
            "name": "Raspberry Pi 5",
            "category": "subassembly",
            "quantity": 1,
            "unit": "ea",
            "material": None,
            "manufacturer": "Raspberry Pi",
            "part_number": "SC1111",
            "parent_item_id": None,
            "notes": "assembly row",
            "basis": "guessed",
            "confidence": "medium",
            "sources": [{"type": "model_knowledge", "note": "n"}],
            "extra_snapshot_field": {"kept": True},
        }
    )
    response = await client.post(
        "/v1/runs", json={"product": "Raspberry Pi 5", "bom_estimate": estimate}
    )
    assert response.status_code == 202, response.text
    assert await app.state.worker.tick()
    graph = (await client.get(f"/v1/graphs/{response.json()['graph_id']}")).json()
    root = next(n for n in graph["nodes"] if n["id"] == graph["root_node_id"])
    assert root["data"]["custom"]["bom_items"][0]["part_number"] == "SC1111"
    assert not any(e["source_node_id"] == root["id"] for e in graph["edges"])


@pytest.mark.parametrize("llm_provider", ["openai", "openrouter"])
def test_imported_part_numbers_sharpen_live_search_queries(llm_provider):
    node = {
        "label": "Broadcom BCM2712",
        "data": {
            "custom": {
                "bom_items": [
                    {"part_number": "BCM2712", "manufacturer": "Broadcom"},
                    {"part_number": "BCM2712", "manufacturer": None},
                ]
            }
        },
    }
    assert LiveProvider.query_hints(node) == "BCM2712 Broadcom"
    assert LiveProvider.query_hints({"label": "x", "data": {"custom": {}}}) == ""

from pathlib import Path

import jsonschema
import yaml

from tests.conftest import researched, sse_events

CONTRACT = yaml.safe_load((Path(__file__).resolve().parents[2] / "docs/openapi.yaml").read_text())


def validate(name, response):
    schema = {"$ref": f"#/components/schemas/{name}", "components": CONTRACT["components"]}
    jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(
        response
    )


async def test_implemented_routes_cover_contract_through_geography(api):
    client, _ = api
    actual = (await client.get("/openapi.json")).json()
    for path, methods in CONTRACT["paths"].items():
        for method, operation in methods.items():
            if method not in {"get", "post"} or not set(operation.get("tags", [])).intersection(
                {"uploads", "runs", "graphs", "claims", "enrichments", "geography"}
            ):
                continue
            assert f"/v1{path}" in actual["paths"], path
            assert method in actual["paths"][f"/v1{path}"], path
            assert actual["paths"][f"/v1{path}"][method]["operationId"] == operation["operationId"]
    assert not any(
        path.startswith("/v1/portfolios") or path.startswith("/v1/market/")
        for path in actual["paths"]
    )


async def test_response_shapes_match_authoritative_yaml(api):
    client, app = api
    uploaded = await client.post(
        "/v1/uploads", files={"file": ("bom.csv", "material,quantity,unit\ntin,2,g")}
    )
    validate("Upload", uploaded.json())
    run, graph = await researched(api, upload_id=uploaded.json()["id"])
    validate("Run", run)
    validate("Graph", graph)
    validate("BOM", (await client.get(run["bom_url"])).json())
    base = f"/v1/graphs/{graph['id']}"
    paths = [
        (base + f"/nodes/{graph['nodes'][1]['id']}", "NodeDetail"),
        (base + f"/edges/{graph['edges'][0]['id']}", "EdgeDetail"),
        (base + "/export", "GraphExport"),
        (base + f"/diff?from=0&to={graph['revision']}", "GraphDiff"),
        (base + "/geography", "GeoFeatureCollection"),
        (f"/v1/materials/{graph['nodes'][1]['id']}/production", "ProductionShares"),
        (f"/v1/claims/{graph['edges'][0]['claim_ids'][0]}", "Claim"),
    ]
    for path, schema in paths:
        result = await client.get(path)
        assert result.status_code == 200, result.text
        validate(schema, result.json())
    for event in sse_events(await client.get(run["events_url"])):
        validate("RunEvent", event)
    fork = await client.post(base + "/fork")
    validate("GraphMeta", fork.json())
    mutation = await client.post(
        base + "/mutations",
        json={
            "ops": [
                {
                    "op": "annotate",
                    "target_id": graph["root_node_id"],
                    "key": "notes",
                    "value": "test",
                }
            ]
        },
        headers={"If-Match": str(graph["revision"])},
    )
    validate("MutationResult", mutation.json())
    validate("MutationRecord", (await client.get(base + "/mutations")).json()["items"][0])
    enrichment = await client.post(base + "/enrichments", json={"kinds": ["concentration"]})
    validate("Enrichment", enrichment.json())
    await app.state.worker.tick()
    validate(
        "Enrichment", (await client.get(base + f"/enrichments/{enrichment.json()['id']}")).json()
    )
    exported = (await client.get(base + "/export")).json()
    validate("GraphExport", exported)
    for source in exported["sources"]:
        validate("Source", source)
    for evidence in exported["evidence"]:
        validate("Evidence", evidence)
    validate("ErrorResponse", (await client.get("/v1/graphs/missing")).json())

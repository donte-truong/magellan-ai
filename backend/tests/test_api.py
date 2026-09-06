import asyncio
import json
import math

import pytest

from app.db import Database
from app.graphs import add_claim_edge, make_node, make_source, refresh
from app.providers import Document, Finding, ProviderFailure
from app.worker import Worker
from tests.conftest import researched, sse_events


async def test_bom_decomposition_has_source_spans_and_explicit_gaps(api):
    client, app = api
    response = await client.post("/v1/bom/decompose", json={"product": "Raspberry Pi 5"})
    assert response.status_code == 202
    run = response.json()
    assert (await client.get(run["bom_url"])).json()["items"] == []
    await app.state.worker.tick()
    bom = (await client.get(run["bom_url"])).json()
    assert {item["name"] for item in bom["items"]} == {
        "Broadcom BCM2712",
        "RP1 I/O controller",
        "LPDDR4X-4267 SDRAM",
    }
    assert bom["status"] == "partial" and bom["open_questions"]
    assert bom["provider"] == "curated_fixture"
    for item in bom["items"]:
        assert item["quantity"] is None and item["unit"] is None
        assert item["support_label"] == "directly_supported"
        assert item["evidence"] and item["claim_ids"]
        evidence = item["evidence"][0]
        with app.state.db.transaction("alpha") as repo:
            source = repo.get(evidence["source_id"], "source")
            assert evidence["span"] in source["_body"]
        public_source = (await client.get(f"/v1/sources/{evidence['source_id']}")).json()
        assert "_body" not in public_source and "content_hash" in public_source
    assert bom["method"]["name"] and bom["data_quality"]["coverage_pct"] == 100


async def test_unknown_product_does_not_invent_a_bom(api):
    client, _ = api
    run, graph = await researched(api, "Unverifiable gadget 123")
    assert run["status"] == "partial"
    assert len(graph["nodes"]) == 1 and not graph["edges"]
    bom = (await client.get(run["bom_url"])).json()
    assert bom["items"] == [] and bom["data_quality"]["coverage_pct"] == 0


async def test_workspace_isolation_including_nested_ids_and_sources(api):
    client, _ = api
    run, graph = await researched(api)
    edge = graph["edges"][0]
    claim = (await client.get(f"/v1/claims/{edge['claim_ids'][0]}")).json()
    paths = [
        f"/v1/runs/{run['id']}",
        run["events_url"],
        run["bom_url"],
        f"/v1/graphs/{graph['id']}",
        f"/v1/graphs/{graph['id']}/export",
        f"/v1/graphs/{graph['id']}/nodes/{graph['root_node_id']}",
        f"/v1/graphs/{graph['id']}/edges/{edge['id']}",
        f"/v1/claims/{claim['id']}",
        f"/v1/sources/{claim['evidence'][0]['source_id']}",
    ]
    for path in paths:
        response = await client.get(path, headers={"Authorization": "Bearer beta-token"})
        assert response.status_code == 404, (path, response.text)
        assert response.json()["error"]["code"] == "not_found"
    for path in ("/v1/runs", "/v1/graphs"):
        assert (await client.get(path, headers={"Authorization": "Bearer beta-token"})).json()[
            "items"
        ] == []
    unauthorized = await client.get("/v1/graphs", headers={"Authorization": "Bearer wrong"})
    assert unauthorized.status_code == 401
    assert unauthorized.headers["www-authenticate"] == "Bearer"


async def test_idempotency_concurrent_creations_and_conflicts(api):
    client, _ = api
    headers = {"Idempotency-Key": "once"}
    responses = await asyncio.gather(
        *(client.post("/v1/runs", json={"product": "test"}, headers=headers) for _ in range(4))
    )
    assert sorted(r.status_code for r in responses) == [200, 200, 200, 202]
    assert len({r.json()["id"] for r in responses}) == 1
    conflict = await client.post("/v1/runs", json={"product": "other"}, headers=headers)
    assert (
        conflict.status_code == 409 and conflict.json()["error"]["code"] == "idempotency_conflict"
    )
    separate = await client.post(
        "/v1/runs",
        json={"product": "test"},
        headers={**headers, "Authorization": "Bearer beta-token"},
    )
    assert separate.status_code == 202 and separate.json()["id"] != responses[0].json()["id"]


async def test_concurrent_run_limit_and_cancel_release_slot(api):
    client, app = api
    responses = await asyncio.gather(
        *(client.post("/v1/runs", json={"product": f"product {i}"}) for i in range(5))
    )
    assert sorted(r.status_code for r in responses) == [202, 202, 202, 429, 429]
    limited = next(r for r in responses if r.status_code == 429)
    assert limited.headers["retry-after"]
    run = next(r.json() for r in responses if r.status_code == 202)
    cancelled = await client.post(f"/v1/runs/{run['id']}/cancel")
    again = await client.post(f"/v1/runs/{run['id']}/cancel")
    assert cancelled.json() == again.json()
    assert cancelled.json()["status"] == "cancelled"
    assert (await client.post("/v1/runs", json={"product": "replacement"})).status_code == 202
    while await app.state.worker.tick():
        pass
    assert (await client.get(f"/v1/runs/{run['id']}")).json()["status"] == "cancelled"


async def test_csv_upload_all_rows_are_ingested_and_idempotent(api):
    client, _ = api
    content = "component,quantity,unit\n" + "\n".join(f"part {i},{i},ea" for i in range(12))
    headers = {"Idempotency-Key": "csv"}
    response = await client.post(
        "/v1/uploads", files={"file": ("bom.csv", content, "text/csv")}, headers=headers
    )
    assert response.status_code == 201
    upload = response.json()
    assert upload["row_count"] == 12 and len(upload["preview"]) == 10
    replay = await client.post(
        "/v1/uploads", files={"file": ("bom.csv", content, "text/csv")}, headers=headers
    )
    assert replay.status_code == 200 and replay.json() == upload
    run, graph = await researched(api, "custom product", upload_id=upload["id"])
    assert len(graph["edges"]) == 12
    bom = (await client.get(run["bom_url"])).json()
    assert {i["quantity"] for i in bom["items"]} == set(range(12))
    assert all(i["support_label"] == "user_asserted" for i in bom["items"])
    assert all(i["evidence"][0]["locator"].startswith("BOM row") for i in bom["items"])
    assert (
        await client.get(
            f"/v1/uploads/{upload['id']}", headers={"Authorization": "Bearer beta-token"}
        )
    ).status_code == 404
    assert (
        await client.post(
            "/v1/runs",
            json={"product": "x", "upload_id": upload["id"]},
            headers={"Authorization": "Bearer beta-token"},
        )
    ).status_code == 404


@pytest.mark.parametrize(
    "filename,content",
    [
        ("x.txt", b"component\nx"),
        ("x.csv", b""),
        ("x.csv", b"bad\nx"),
        ("x.csv", b"component,component\nx,y"),
        ("x.csv", b"component,quantity\nx"),
        ("x.csv", b"component\n\xff"),
        ("x.csv", b"component\n\x00"),
        ("x.csv", b"component\n" + b"x\n" * 101),
        ("x.csv", b"component\n" + b"x" * (1024 * 1024)),
    ],
)
async def test_bad_uploads_are_rejected(api, filename, content):
    client, _ = api
    response = await client.post("/v1/uploads", files={"file": (filename, content)})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_input"


async def test_mutations_atomic_temp_ids_revisions_fork_diff_and_export(api):
    client, app = api
    run, graph = await researched(api, "custom")
    url = f"/v1/graphs/{graph['id']}"
    body = {
        "message": "Add asserted input",
        "ops": [
            {"op": "add_node", "temp_id": "tin", "node": {"kind": "material", "label": "tin"}},
            {
                "op": "add_edge",
                "edge": {
                    "source_node_id": "tin",
                    "target_node_id": graph["root_node_id"],
                    "predicate": "INPUT_TO",
                    "scope": {"type": "product"},
                    "rationale": "Prototype BOM",
                },
            },
        ],
    }
    headers = {"If-Match": str(graph["revision"]), "Idempotency-Key": "mutation"}
    response = await client.post(url + "/mutations", json=body, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["revision"] == graph["revision"] + 1
    assert (await client.post(url + "/mutations", json=body, headers=headers)).json() == result
    stale = await client.post(
        url + "/mutations", json=body, headers={"If-Match": str(graph["revision"])}
    )
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"
    changed = (await client.get(url + "?include=claims")).json()
    assert changed["edges"][0]["support_label"] == "user_asserted"
    assert changed["claims"][0]["support_label"] == "user_asserted"
    assert (await client.get(url + f"?revision={graph['revision']}")).json()["edges"] == []
    delta = (
        await client.get(url + f"/diff?from={graph['revision']}&to={changed['revision']}")
    ).json()
    assert len(delta["nodes_added"]) == len(delta["edges_added"]) == 1
    edge = (await client.get(url + f"/edges/{changed['edges'][0]['id']}")).json()
    assert edge["claims"][0]["evidence"][0]["span"]
    exported = await client.get(url + "/export")
    assert exported.headers["content-disposition"].startswith("attachment")
    assert len(exported.json()["sources"]) == len(exported.json()["evidence"]) == 1
    assert "_body" not in json.dumps(exported.json())
    fork = await client.post(url + "/fork", json={"name": "Copy", "revision": changed["revision"]})
    assert fork.status_code == 201 and fork.json()["revision"] == 0
    assert fork.json()["parent_graph_id"] == graph["id"]
    copied = (await client.get(f"/v1/graphs/{fork.json()['id']}")).json()
    assert copied["nodes"] == changed["nodes"] and copied["edges"] == changed["edges"]
    with app.state.db.transaction("alpha") as repo:
        count = len(repo.all("source"))
    invalid_batch = {
        "ops": body["ops"] + [{"op": "remove_node", "node_id": "missing", "reason": "test"}]
    }
    failed = await client.post(
        url + "/mutations", json=invalid_batch, headers={"If-Match": str(changed["revision"])}
    )
    assert failed.status_code == 404
    assert (await client.get(url)).json()["revision"] == changed["revision"]
    with app.state.db.transaction("alpha") as repo:
        assert len(repo.all("source")) == count
    log = (await client.get(url + "/mutations")).json()
    assert len(log["items"]) == 1 and log["items"][0]["actor"] == "user"


async def test_concurrent_mutations_only_one_accepts_revision(api):
    client, _ = api
    _, graph = await researched(api, "custom")
    url = f"/v1/graphs/{graph['id']}/mutations"
    body = {
        "ops": [
            {"op": "annotate", "target_id": graph["root_node_id"], "key": "note", "value": "review"}
        ]
    }
    responses = await asyncio.gather(
        *(
            client.post(url, json=body, headers={"If-Match": str(graph["revision"])})
            for _ in range(3)
        )
    )
    assert sorted(r.status_code for r in responses) == [200, 409, 409]


async def test_mutation_cannot_change_evidence_or_leave_dangling_edges(api):
    client, _ = api
    _, graph = await researched(api)
    url = f"/v1/graphs/{graph['id']}/mutations"
    for operation in [
        {
            "op": "update_node",
            "node_id": graph["root_node_id"],
            "patch": {"label": "Different product"},
        },
        {
            "op": "update_node",
            "node_id": graph["root_node_id"],
            "patch": {"data": {"geography": None}},
        },
        {
            "op": "update_edge",
            "edge_id": graph["edges"][0]["id"],
            "patch": {"support_label": "directly_supported"},
        },
        {
            "op": "update_node",
            "node_id": graph["nodes"][1]["id"],
            "patch": {"label": "invented replacement"},
        },
        {
            "op": "remove_node",
            "node_id": graph["nodes"][1]["id"],
            "reason": "remove referenced component",
        },
        {"op": "remove_node", "node_id": graph["root_node_id"], "reason": "remove root"},
    ]:
        response = await client.post(
            url, json={"ops": [operation]}, headers={"If-Match": str(graph["revision"])}
        )
        assert response.status_code == 400, response.text


async def test_review_keeps_original_label_and_revision_history(api):
    client, _ = api
    _, graph = await researched(api)
    edge = graph["edges"][0]
    cid = edge["claim_ids"][0]
    response = await client.post(
        f"/v1/claims/{cid}/review", json={"verdict": "dispute", "note": "Needs another source"}
    )
    assert response.status_code == 200
    assert (
        response.json()["status"] == "disputed"
        and response.json()["support_label"] == "directly_supported"
    )
    url = f"/v1/graphs/{graph['id']}/edges/{edge['id']}"
    assert (await client.get(url)).json()["support_label"] == "disputed"
    historical = (await client.get(url + f"?revision={graph['revision']}")).json()
    assert (
        historical["support_label"] == "directly_supported"
        and historical["claims"][0]["status"] == "accepted"
    )
    assert (
        (await client.get(f"/v1/graphs/{graph['id']}/mutations"))
        .json()["items"][0]["message"]
        .startswith("Reviewed claim")
    )


async def test_geography_concentration_and_unmapped_results(api):
    client, app = api
    upload = (
        await client.post(
            "/v1/uploads",
            files={"file": ("bom.csv", "material,quantity,unit\ntin,2,g\nunknownite,,\n")},
        )
    ).json()
    _, graph = await researched(api, "custom product", upload_id=upload["id"])
    node = next(n for n in graph["nodes"] if n["label"] == "tin")
    production = await client.get(f"/v1/materials/{node['id']}/production?year=2024&stage=mine")
    assert production.status_code == 200
    data = production.json()
    assert 0 < data["hhi"] < 1 and data["method"]["name"]
    assert data["hhi"] == pytest.approx(math.fsum(s["share"] ** 2 for s in data["shares"]))
    assert 99 < data["data_quality"]["coverage_pct"] < 100
    assert (await client.get(f"/v1/sources/{data['source_id']}")).status_code == 200
    assert (await client.get(f"/v1/materials/{node['id']}/production?year=1900")).status_code == 404
    assert (
        await client.get(f"/v1/materials/{node['id']}/production?stage=export")
    ).status_code == 404
    assert (
        await client.get(
            f"/v1/materials/{node['id']}/production", headers={"Authorization": "Bearer beta-token"}
        )
    ).status_code == 404
    reference = (await client.get("/v1/reference/commodities")).json()["items"]
    assert {"commodity": "tin", "years": [2024], "stages": ["mine"]} in reference
    response = await client.post(
        f"/v1/graphs/{graph['id']}/enrichments",
        json={"kinds": ["concentration", "geography", "market_exposure"]},
    )
    assert response.status_code == 202
    job = response.json()
    await app.state.worker.tick()
    job = (await client.get(f"/v1/graphs/{graph['id']}/enrichments/{job['id']}")).json()
    assert job["status"] == "partial" and any(
        r["outcome"] == "unresolved" and r["reason"] for r in job["results"]
    )
    geo = await client.get(f"/v1/graphs/{graph['id']}/geography")
    assert geo.headers["content-type"].startswith("application/geo+json")
    assert len(geo.json()["features"]) == len(data["shares"])
    assert all(f["geometry"] is None for f in geo.json()["features"])
    enriched = (await client.get(f"/v1/graphs/{graph['id']}")).json()
    layer = next(n for n in enriched["nodes"] if n["id"] == node["id"])["data"]
    assert layer["concentration"]["data_quality"] and layer["market"]["method"]
    assert (
        await client.get(f"/v1/graphs/{graph['id']}/geography?revision={graph['revision']}")
    ).json()["features"] == []
    events = sse_events(await client.get(job["events_url"]))
    assert events[-1]["type"] == "job.completed" and any(
        e["type"] == "node.updated" for e in events
    )


async def test_facility_map_requires_an_accepted_matching_location_claim(api):
    client, app = api
    _, graph = await researched(api, "custom")
    with app.state.db.transaction("alpha", write=True) as repo:
        stored = repo.graph(graph["id"])
        facility = make_node("facility", "Test facility", status="directly_supported")
        country = make_node("geography", "United Kingdom", external_ids={"iso2": "GB"})
        stored["nodes"].extend([facility, country])
        source = make_source(
            repo,
            "https://example.org/location",
            "Synthetic test evidence",
            "Test facility is at 51.5, -0.1 in GB.",
        )
        _, claim = add_claim_edge(
            repo,
            stored,
            facility["id"],
            country["id"],
            "LOCATED_IN",
            {"type": "generic"},
            source,
            "Test facility is at 51.5, -0.1 in GB.",
            "directly_supported",
        )
        facility["data"]["geography"] = {
            "country_iso2": "GB",
            "lat": 51.5,
            "lon": -0.1,
            "precision": "address",
            "claim_ids": [claim["id"]],
        }
        spoof = make_node("facility", "Unevidenced facility")
        spoof["data"]["geography"] = {
            "country_iso2": "GB",
            "lat": 0,
            "lon": 0,
            "claim_ids": [claim["id"]],
        }
        stored["nodes"].append(spoof)
        stored["revision"] += 1
        refresh(stored)
        repo.save_graph(stored)
    features = (await client.get(f"/v1/graphs/{graph['id']}/geography")).json()["features"]
    assert len(features) == 1 and features[0]["geometry"]["coordinates"] == [-0.1, 51.5]
    await client.post(f"/v1/claims/{claim['id']}/review", json={"verdict": "reject"})
    assert (await client.get(f"/v1/graphs/{graph['id']}/geography")).json()["features"] == []


async def test_question_answers_resume_run_and_validate_choice(api):
    client, app = api
    run, _ = await researched(api, "Raspberry Pi")
    assert run["status"] == "awaiting_input"
    question = run["pending_questions"][0]
    body = {"question_id": question["question_id"], "choice": "invalid"}
    assert (await client.post(f"/v1/runs/{run['id']}/answers", json=body)).status_code == 400
    body["choice"] = question["choices"][0]["id"]
    response = await client.post(f"/v1/runs/{run['id']}/answers", json=body)
    assert response.json()["status"] == "queued"
    await app.state.worker.tick()
    assert len((await client.get(run["bom_url"])).json()["items"]) == 3


async def test_replay_and_sse_resume_gap(api):
    client, app = api
    run, graph = await researched(api)
    events = sse_events(await client.get(run["events_url"]))
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    resumed = sse_events(
        await client.get(run["events_url"], headers={"Last-Event-ID": str(events[-3]["seq"])})
    )
    assert resumed == events[-2:]
    assert (
        await client.get(run["events_url"], headers={"Last-Event-ID": "invalid"})
    ).status_code == 400
    assert (
        sse_events(await client.get(run["events_url"], headers={"Last-Event-ID": "999999"}))[0][
            "type"
        ]
        == "snapshot.required"
    )
    replay = await client.post(
        "/v1/runs", json={"product": run["product"], "replay_of_run_id": run["id"]}
    )
    assert replay.status_code == 202
    await app.state.worker.tick()
    replayed = (await client.get(replay.json()["bom_url"])).json()
    assert replayed["mode"] == "replay" and len(replayed["items"]) == 3
    assert replayed["graph_id"] != graph["id"]
    assert all(
        e["mode"] == "replay" for e in sse_events(await client.get(replay.json()["events_url"]))
    )
    app.state.settings.event_retention = 10
    second, _ = await researched(api)
    retained = sse_events(await client.get(second["events_url"]))
    assert retained[0]["type"] == "snapshot.required"


@pytest.mark.parametrize(
    "limits,expected_nodes,binding",
    [
        ({"max_nodes": 2}, 2, "max_nodes"),
        ({"max_claims": 0}, 1, "max_claims"),
        ({"max_documents": 1}, 2, "max_documents"),
    ],
)
async def test_budget_limits_preserve_committed_findings(api, limits, expected_nodes, binding):
    _, _app = api
    run, graph = await researched(api, limits=limits)
    assert run["status"] == "partial" and run["stop_reason"] == "budget_exhausted"
    assert run["usage"]["binding_limit"] == binding and len(graph["nodes"]) == expected_nodes


async def test_provider_failure_and_bad_spans_do_not_commit_claims(api):
    client, app = api

    class BrokenProvider:
        name = "test"

        async def research(self, target, product, company, budget):
            yield Document(
                "https://example.org",
                "Test",
                "Example",
                "Product has a battery.",
                findings=[
                    Finding(
                        "invented",
                        "component",
                        "PART_OF",
                        "This span is not in the document",
                        "wrong",
                    )
                ],
            )
            raise ProviderFailure("provider_timeout", "Provider timed out")

    app.state.worker.provider = BrokenProvider()
    run, graph = await researched(api, "product")
    # One outage fails the task, not the run; the run ends only after several in a row.
    assert run["stop_reason"] == "research_exhausted" and graph["edges"] == []
    assert any("provider_timeout" in q for q in run["open_questions"])
    outcomes = [
        e["payload"]["outcome"]
        for e in sse_events(await client.get(run["events_url"]))
        if e["type"] == "task.finished"
    ]
    assert outcomes == ["failed:provider_timeout"]
    assert any(
        e["type"] == "claim.rejected" for e in sse_events(await client.get(run["events_url"]))
    )


async def test_durable_restart_and_expired_worker_lease(api):
    client, app = api
    response = await client.post("/v1/runs", json={"product": "Raspberry Pi 5"})
    db = Database(app.state.settings.database_url)
    worker = Worker(db, app.state.settings)
    assert await worker.tick()
    assert len((await client.get(response.json()["bom_url"])).json()["items"]) == 3
    response = await client.post("/v1/runs", json={"product": "test"})
    with db.transaction("alpha", write=True) as repo:
        run = repo.get(response.json()["id"], "run")
        run.update(status="running", _lease_until=0, _worker="crashed")
        repo.put("run", run)
    await worker.tick()
    recovered = (await client.get(f"/v1/runs/{run['id']}")).json()
    assert recovered["status"] == "partial" and recovered["stop_reason"] == "worker_interrupted"
    db.engine.dispose()


async def test_pagination_filter_and_errors_are_consistent(api):
    client, _ = api
    for i in range(3):
        await researched(api, f"custom {i}")
    first = (await client.get("/v1/runs?limit=2&status=partial")).json()
    assert len(first["items"]) == 2 and first["next_cursor"]
    second = (
        await client.get(
            "/v1/runs", params={"limit": 2, "status": "partial", "cursor": first["next_cursor"]}
        )
    ).json()
    assert len(second["items"]) == 1 and second["next_cursor"] is None
    assert {r["id"] for r in first["items"]}.isdisjoint({r["id"] for r in second["items"]})
    assert (
        await client.get("/v1/graphs", params={"cursor": first["next_cursor"]})
    ).status_code == 400
    for path in (
        "/v1/runs?limit=201",
        "/v1/runs?cursor=%%%",
        "/v1/runs?status=invalid",
        "/v1/graphs/nope?revision=-1",
    ):
        response = await client.get(path)
        assert response.status_code == 400
        assert response.json()["error"]["request_id"] == response.headers["x-request-id"]
    for body in (
        {"product": " "},
        {"product": "x", "limits": {"max_hops": 99}},
        {"product": "x", "unexpected": True},
    ):
        assert (await client.post("/v1/runs", json=body)).status_code == 400

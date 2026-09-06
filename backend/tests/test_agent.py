from unittest.mock import AsyncMock

from app.agent import Answer
from app.providers import Edit, ProviderFailure
from tests.conftest import researched


async def test_chat_is_scoped_revision_pinned_and_read_only(api):
    client, app = api
    _, graph = await researched(api)
    path = f"/v1/graphs/{graph['id']}"
    edge = graph["edges"][0]
    body = {
        "message": "What do we know about this connection?",
        "revision": graph["revision"],
        "selection": {"edge_ids": [edge["id"]]},
    }
    response = await client.post(path + "/chat", json=body)
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["graph_id"] == graph["id"]
    assert answer["revision"] == graph["revision"]
    assert "Curated preview" in answer["content"]
    assert edge["id"] in answer["edge_ids"]
    assert (await client.get(path + "?include=claims")).json() == graph
    assert (
        await client.post(path + "/chat", json=body, headers={"Authorization": "Bearer beta-token"})
    ).status_code == 404
    assert (
        await client.post(path + "/chat", json={**body, "selection": {"node_ids": ["nd_foreign"]}})
    ).status_code == 400
    assert (await client.post(path + "/chat", json={**body, "revision": 99999})).status_code == 404


async def test_live_chat_uses_selection_quotes_and_history_and_filters_refs(api):
    client, app = api
    _, graph = await researched(api)
    edge = graph["edges"][0]
    provider = type("Model", (), {"name": "test_live"})()
    provider.structured = AsyncMock(
        return_value=Answer(
            content="A supported connection.",
            node_ids=["nd_fake"],
            edge_ids=[edge["id"], "ed_fake", edge["id"]],
        )
    )
    app.state.provider = provider
    history = [{"role": "user", "content": "Summarize the graph"}]
    result = await client.post(
        f"/v1/graphs/{graph['id']}/chat",
        json={
            "message": "What supports it?",
            "revision": graph["revision"],
            "selection": {"edge_ids": [edge["id"]]},
            "history": history,
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["edge_ids"] == [edge["id"]]
    assert result.json()["node_ids"] == []
    data = provider.structured.call_args.args[2]
    assert data["history"] == history
    assert data["graph"]["selection"]["edge_ids"] == [edge["id"]]
    assert data["graph"]["relations"][0]["evidence"][0]["quotes"][0]["span"]


async def test_provider_failure_is_actionable_and_does_not_expose_secrets(api):
    client, app = api
    _, graph = await researched(api)
    provider = type("Model", (), {"name": "test_live"})()
    provider.structured = AsyncMock(
        side_effect=ProviderFailure("rate_limit", "private-upstream-token")
    )
    app.state.provider = provider
    result = await client.post(
        f"/v1/graphs/{graph['id']}/chat",
        json={"message": "Explain this graph", "revision": graph["revision"]},
    )
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "agent_unavailable"
    assert "private-upstream" not in result.text


async def test_edit_passes_focus_checks_revision_and_preserves_base(api):
    client, app = api
    _, graph = await researched(api)
    path = f"/v1/graphs/{graph['id']}"
    scenario = (await client.post(path + "/scenarios", json={})).json()
    node = next(n for n in graph["nodes"] if n["kind"] == "component")
    app.state.worker.provider.propose_edits = AsyncMock(
        return_value=[
            Edit(op="replace_node", label=node["label"], new_label="Alternative processor")
        ]
    )
    body = {
        "instruction": "Replace this with Alternative processor",
        "revision": scenario["revision"],
        "target_node_ids": [node["id"]],
    }
    edit_path = f"/v1/graphs/{scenario['id']}/edits"
    response = await client.post(edit_path, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["applied"]
    assert app.state.worker.provider.propose_edits.call_args.args[1]["selection"] == [node["label"]]
    assert (await client.get(path + "?include=claims")).json() == graph
    assert (await client.post(edit_path, json=body)).status_code == 409
    assert app.state.worker.provider.propose_edits.call_count == 1
    assert (
        await client.post(
            edit_path, json={"instruction": "Remove it", "target_node_ids": ["nd_foreign"]}
        )
    ).status_code == 400

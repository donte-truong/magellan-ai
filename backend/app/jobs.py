from copy import deepcopy

from app.db import new_id, now, public
from app.errors import APIError, invalid
from app.graphs import create_graph, find_node, refresh
from app.schemas import RunUsage

TERMINAL_RUN = {"completed", "partial", "failed", "cancelled"}
TERMINAL_JOB = {"completed", "partial", "failed"}


def create_run(repo, request, provider):
    if request.upload_id:
        repo.get(request.upload_id, "upload")
    original = None
    if request.replay_of_run_id:
        original = repo.get(request.replay_of_run_id, "run")
        if original["status"] not in TERMINAL_RUN:
            raise invalid("Only terminal runs can be replayed")
        if (
            request.product.casefold() != original["product"].casefold()
            or request.company != original["company"]
        ):
            raise invalid("Replay product and company must match the original run")
        if request.upload_id and request.upload_id != original.get("upload_id"):
            raise invalid("Replay cannot substitute a different BOM upload")
    active = [r for r in repo.all("run") if r["status"] not in TERMINAL_RUN]
    if len(active) >= 3:
        raise APIError(
            429,
            "rate_limited",
            "At most three research runs may be active per workspace",
            headers={"Retry-After": "5"},
        )
    identifier = new_id("run")
    mode = "replay" if original else "live"
    graph = create_graph(request.product, identifier, mode)
    usage = RunUsage().model_dump(exclude_none=True)
    if provider.name == "curated_fixture" or original:
        usage["cost_minor"] = 0
    run = {
        "id": identifier,
        "product": request.product,
        "company": request.company,
        "upload_id": request.upload_id,
        "mode": mode,
        "status": "queued",
        "graph_id": graph["id"],
        "limits": request.limits.model_dump(),
        "usage": usage,
        "progress": {"tasks_done": 0, "tasks_total": 1},
        "pending_questions": [],
        "stop_reason": None,
        "open_questions": [],
        "events_url": f"/v1/runs/{identifier}/events",
        "bom_url": f"/v1/runs/{identifier}/bom",
        "provider": provider.name,
        "created_at": now(),
        "completed_at": None,
    }
    if original:
        snapshot = repo.graph(original["graph_id"])
        if (
            len(snapshot["nodes"]) > request.limits.max_nodes
            or len(snapshot["_claims"]) > request.limits.max_claims
            or snapshot["stats"]["max_tier"] > request.limits.max_hops
        ):
            raise invalid("Replay limits must accommodate the cached graph")
        run["_replay_snapshot"] = snapshot
        run["_replay_status"] = original["status"]
        run["_replay_questions"] = original["open_questions"]
        run["provider"] = original["provider"]
        graph["root_node_id"] = snapshot["root_node_id"]
        graph["nodes"] = [deepcopy(find_node(snapshot, snapshot["root_node_id"]))]
        refresh(graph)
    repo.save_graph(graph)
    repo.emit(run, "run.status", {"status": "queued", "progress": run["progress"], "usage": usage})
    repo.emit(run, "node.added", {"node": graph["nodes"][0]})
    repo.put("run", run)
    return public(run)


def cancel_run(repo, identifier):
    run = repo.get(identifier, "run")
    if run["status"] not in TERMINAL_RUN:
        run.update(status="cancelled", stop_reason="user_cancelled", completed_at=now())
        repo.emit(
            run,
            "run.completed",
            {
                "status": "cancelled",
                "stop_reason": "user_cancelled",
                "coverage_summary": {},
                "open_questions": run["open_questions"],
            },
        )
        repo.put("run", run)
    return public(run)


def answer_run(repo, identifier, answer):
    run = repo.get(identifier, "run")
    if run.get("_answers", {}).get(answer.question_id) == answer.choice:
        return public(run)
    question = next(
        (q for q in run["pending_questions"] if q["question_id"] == answer.question_id), None
    )
    if run["status"] != "awaiting_input" or question is None:
        raise APIError(409, "invalid_input", "Run is not awaiting this question")
    choice = next((c for c in question["choices"] if c["id"] == answer.choice), None)
    if choice is None:
        raise invalid("Choice must match one of the pending question's choices")
    run.setdefault("_answers", {})[answer.question_id] = answer.choice
    run["pending_questions"].remove(question)
    if question["kind"] == "product_ambiguity":
        run["product"] = choice["label"]
        graph = repo.graph(run["graph_id"])
        root = find_node(graph, graph["root_node_id"])
        root["label"] = root["canonical_name"] = choice["label"]
        graph["name"] = choice["label"]
        graph["revision"] += 1
        repo.save_graph(graph)
        repo.emit(run, "node.updated", {"node": root})
    else:
        run["company"] = choice["label"]
    run["status"] = "queued" if not run["pending_questions"] else "awaiting_input"
    repo.emit(
        run,
        "run.status",
        {"status": run["status"], "progress": run["progress"], "usage": run["usage"]},
    )
    repo.put("run", run)
    return public(run)


def create_enrichment(repo, graph_id, request):
    graph = repo.graph(graph_id)
    ids = request.node_ids if request.node_ids is not None else [n["id"] for n in graph["nodes"]]
    for identifier in ids:
        find_node(graph, identifier)
    active = [e for e in repo.all("enrichment") if e["status"] not in TERMINAL_JOB]
    if len(active) >= 3:
        raise APIError(
            429,
            "rate_limited",
            "At most three enrichments may be active per workspace",
            headers={"Retry-After": "5"},
        )
    identifier = new_id("enr")
    enrichment = {
        "id": identifier,
        "graph_id": graph_id,
        "kinds": request.kinds,
        "status": "queued",
        "progress": {"nodes_done": 0, "nodes_total": len(set(ids))},
        "results": [],
        "revision_after": None,
        "created_at": now(),
        "events_url": f"/v1/graphs/{graph_id}/enrichments/{identifier}/events",
        "_node_ids": list(dict.fromkeys(ids)),
    }
    repo.emit(enrichment, "job.status", {"status": "queued", "progress": enrichment["progress"]})
    repo.put("enrichment", enrichment, graph_id)
    return public(enrichment)


def bom_view(run, graph):
    from app.graphs import claims_for

    nodes = {n["id"]: n for n in graph["nodes"]}
    eligible = [
        e
        for e in graph["edges"]
        if e["predicate"] in {"PART_OF", "INPUT_TO"}
        and nodes[e["source_node_id"]]["kind"] in {"component", "material"}
        and nodes[e["target_node_id"]]["kind"] in {"product", "component", "material"}
        and e["scope"]["type"] == "product"
        and e["scope"].get("product_node_id") == graph["root_node_id"]
    ]
    depths = {graph["root_node_id"]: 0}
    for _ in graph["nodes"]:
        changed = False
        for edge in eligible:
            source, target = edge["source_node_id"], edge["target_node_id"]
            if target in depths and depths.get(source, len(nodes) + 1) > depths[target] + 1:
                depths[source] = depths[target] + 1
                changed = True
        if not changed:
            break
    items = []
    for edge in eligible:
        node, parent = nodes[edge["source_node_id"]], nodes[edge["target_node_id"]]
        if parent["id"] not in depths:
            continue
        operational = edge["data"].get("operational") or {}
        claims = claims_for(graph, edge["claim_ids"])
        items.append(
            {
                "node_id": node["id"],
                "name": node["label"],
                "kind": node["kind"],
                "tier": depths[node["id"]],
                "parent_node_id": parent["id"],
                "edge_id": edge["id"],
                "quantity": operational.get("quantity"),
                "unit": operational.get("unit"),
                "quantity_support_label": (
                    "user_asserted"
                    if edge["data"].get("custom", {}).get("operational_provenance")
                    else edge["support_label"]
                )
                if operational.get("quantity") is not None
                else None,
                "support_label": edge["support_label"],
                "scope": edge["scope"],
                "claim_ids": edge["claim_ids"],
                "evidence": [e for c in claims for e in c["evidence"]],
            }
        )
    supported = sum(item["support_label"] == "directly_supported" for item in items)
    return {
        "run_id": run["id"],
        "graph_id": graph["id"],
        "revision": graph["revision"],
        "product": run["product"],
        "status": run["status"],
        "mode": run["mode"],
        "provider": run["provider"],
        "items": sorted(items, key=lambda i: (i["tier"], i["name"], i["edge_id"])),
        "open_questions": run["open_questions"],
        "method": {
            "name": "evidence_backed_bom_decomposition",
            "version": "1",
            "params": {"predicates": ["PART_OF", "INPUT_TO"]},
            "assumptions": [
                "Only product-scoped evidenced or explicitly user-asserted relationships are included; generic and company context remain in the graph.",
                "Unknown quantities remain null.",
            ],
        },
        "data_quality": {
            "coverage_pct": 100 * supported / len(items) if items else 0,
            "notes": [
                "Coverage is the fraction of returned BOM rows directly supported by public evidence, not the fraction of the physical product discovered.",
                "This is a research BOM, not a complete manufacturing BOM.",
            ],
            "as_of": graph["updated_at"],
        },
    }

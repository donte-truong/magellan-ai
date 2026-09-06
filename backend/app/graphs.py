from collections import Counter, deque
from copy import deepcopy

from pydantic import ValidationError

from app.db import digest, new_id, now, public
from app.edge_metadata import annotate_edge, ensure_edge_metadata
from app.errors import APIError, invalid, not_found
from app.schemas import Claim, ClaimSummary, DataLayers, Edge, Node, Scope, Source

DEPENDENCY_PREDICATES = {
    "INPUT_TO",
    "PART_OF",
    "MANUFACTURES",
    "PRODUCES",
    "PROCESSED_BY",
    "SUPPLIES",
}


def make_node(kind, label, **kwargs):
    return Node(
        id=new_id("nd"), kind=kind, label=label, canonical_name=label, **kwargs
    ).model_dump()


def create_graph(name, run_id=None, mode="live"):
    root = make_node("product", name, tier=0, status="user_asserted")
    graph = {
        "id": new_id("gph"),
        "name": name,
        "revision": 0,
        "run_id": run_id,
        "parent_graph_id": None,
        "root_node_id": root["id"],
        "mode": mode,
        "created_at": now(),
        "updated_at": now(),
        "nodes": [root],
        "edges": [],
        "_claims": {},
    }
    refresh(graph)
    return graph


def refresh(graph):
    upstream = {}
    for edge in graph["edges"]:
        if edge["predicate"] in DEPENDENCY_PREDICATES:
            upstream.setdefault(edge["target_node_id"], []).append(edge["source_node_id"])
    tiers = {graph["root_node_id"]: 0}
    queue = deque(tiers)
    while queue:
        parent = queue.popleft()
        for child in upstream.get(parent, []):
            if child not in tiers:
                tiers[child] = tiers[parent] + 1
                queue.append(child)
    for node in graph["nodes"]:
        node["tier"] = tiers.get(node["id"])
    for edge in graph["edges"]:
        annotate_edge(edge, graph)
    graph["stats"] = {
        "node_count": len(graph["nodes"]),
        "edge_count": len(graph["edges"]),
        "max_tier": max(tiers.values(), default=0),
        "by_support_label": dict(Counter(e["support_label"] for e in graph["edges"])),
    }


def meta(graph):
    return {k: v for k, v in public(graph).items() if k not in {"nodes", "edges", "claims"}}


def summary(claim):
    return ClaimSummary.model_validate(
        {k: claim[k] for k in ClaimSummary.model_fields}
    ).model_dump()


def claims_for(graph, ids=None):
    claims = graph.get("_claims", {})
    if ids is None:
        ids = {cid for e in graph["edges"] for cid in e["claim_ids"]}
        ids.update(
            cid
            for n in graph["nodes"]
            for cid in (n["data"].get("geography") or {}).get("claim_ids", [])
        )
    return [deepcopy(claims[cid]) for cid in sorted(ids) if cid in claims]


def graph_view(graph, include=None, tier_max=None):
    graph = ensure_edge_metadata(deepcopy(graph))
    if tier_max is not None:
        graph["nodes"] = [
            n for n in graph["nodes"] if n["tier"] is not None and n["tier"] <= tier_max
        ]
        ids = {n["id"] for n in graph["nodes"]}
        graph["edges"] = [
            e for e in graph["edges"] if e["source_node_id"] in ids and e["target_node_id"] in ids
        ]
        refresh(graph)
    if include:
        if include != "claims":
            raise invalid("Only include=claims is supported")
        graph["claims"] = [summary(c) for c in claims_for(graph)]
    return public(graph)


def find_node(graph, identifier):
    return find_item(graph["nodes"], identifier)


def find_item(items, identifier):
    for item in items:
        if item["id"] == identifier:
            return item
    raise not_found()


def detail_node(graph, identifier):
    node = deepcopy(find_node(graph, identifier))
    node["in_edge_ids"] = [e["id"] for e in graph["edges"] if e["target_node_id"] == identifier]
    node["out_edge_ids"] = [e["id"] for e in graph["edges"] if e["source_node_id"] == identifier]
    node["claims"] = [
        summary(c) for c in claims_for(graph) if identifier in (c["subject_id"], c["object_id"])
    ]
    return node


def detail_edge(graph, identifier):
    edge = annotate_edge(deepcopy(find_item(graph["edges"], identifier)), graph)
    edge["claims"] = claims_for(graph, edge["claim_ids"])
    contradiction_ids = {
        cid for claim in edge["claims"] for cid in claim["contradiction_claim_ids"]
    }
    edge["contradictions"] = claims_for(graph, contradiction_ids)
    edge["rationale"] = " ".join(c["rationale"] for c in edge["claims"])
    edge["caveats"] = ["Support labels describe evidence, not probabilities."]
    return edge


def export_graph(repo, graph):
    result = public(ensure_edge_metadata(deepcopy(graph)))
    result["claims"] = claims_for(graph)
    result["evidence"] = list(
        {e["id"]: e for c in result["claims"] for e in c["evidence"]}.values()
    )
    source_ids = {e["source_id"] for e in result["evidence"]}
    source_ids.update(
        n["data"]["concentration"]["source_id"]
        for n in graph["nodes"]
        if n["data"].get("concentration")
    )
    result["sources"] = [public(repo.get(sid, "source")) for sid in sorted(source_ids)]
    result["exported_at"] = now()
    return result


def diff(before, after):
    before, after = (ensure_edge_metadata(deepcopy(g)) for g in (before, after))
    result = {"graph_id": after["id"], "from": before["revision"], "to": after["revision"]}
    for key in ("nodes", "edges"):
        old, new = ({v["id"]: v for v in graph[key]} for graph in (before, after))
        result[f"{key}_added"] = [new[k] for k in new if k not in old]
        result[f"{key}_removed"] = [k for k in old if k not in new]
        result[f"{key}_changed"] = [new[k] for k in new if k in old and new[k] != old[k]]
    return result


def make_source(repo, url, title, body, kind="other", publisher=None, **fields):
    source = Source(
        id=new_id("src"),
        url=url,
        title=title,
        retrieved_at=now(),
        content_hash=digest(body.encode()),
        kind=kind,
        publisher=publisher,
        **fields,
    ).model_dump()
    repo.put("source", {**source, "_body": body})
    return source


def refresh_edge_support(graph, edge):
    claims = claims_for(graph, edge["claim_ids"])
    accepted = [c for c in claims if c["status"] == "accepted"]
    order = [
        "directly_supported",
        "strongly_inferred",
        "weakly_inferred",
        "user_asserted",
        "unresolved",
    ]
    if any(c["status"] == "disputed" or c["support_label"] == "disputed" for c in claims):
        edge["support_label"] = "disputed"
    else:
        edge["support_label"] = next(
            (label for label in order if any(c["support_label"] == label for c in accepted)),
            "unresolved",
        )
    evidence = [e for c in claims for e in c["evidence"]]
    sources = {e["source_id"]: e["source"] for e in evidence if e.get("source")}
    dates = [s["published_at"] for s in sources.values() if s.get("published_at")]
    edge["evidence_summary"] = {
        "source_count": len(sources),
        "independent_family_count": len(
            {s.get("source_family_id") or s["id"] for s in sources.values()}
        ),
        "latest_published_at": max(dates) if dates else None,
        "has_contradiction": any(
            c["status"] == "disputed" or c["contradiction_claim_ids"] for c in claims
        )
        or any(e["support_type"] == "contradicts" for e in evidence),
    }


SCOPE_STRENGTH = {"generic": 0, "company": 1, "product": 2}


def add_claim_edge(
    repo,
    graph,
    subject,
    target,
    predicate,
    scope,
    source,
    span,
    label="user_asserted",
    rationale="",
    locator="",
    data=None,
):
    """Only entry point for relationship writes: claim, span and source are mandatory."""
    subject_node, target_node = find_node(graph, subject), find_node(graph, target)
    scope = validate_scope(graph, scope)
    kinds = (subject_node["kind"], target_node["kind"])
    if predicate == "LOCATED_IN" and kinds[1] != "geography":
        raise invalid("LOCATED_IN must reference a geography node")
    source_record = repo.get(source["id"], "source")
    if not span or len(span) > 600 or span not in source_record["_body"]:
        raise invalid(
            "Evidence span must be present in the stored source and at most 600 characters"
        )
    claim = Claim(
        id=new_id("clm"),
        subject_id=subject,
        object_id=target,
        predicate=predicate,
        scope=scope,
        status="accepted",
        support_label=label,
        rationale=rationale,
        observed_at=now(),
        evidence=[
            {
                "id": new_id("ev"),
                "source_id": source["id"],
                "span": span,
                "support_type": "supports",
                "locator": locator,
                "extracted_at": now(),
                "source": public(source),
            }
        ],
    ).model_dump()
    repo.put("claim", claim)
    graph["_claims"][claim["id"]] = claim
    # One edge per relation: a claim under another scope corroborates the same edge (each claim
    # keeps its own scope), and the edge takes the strongest scope any claim establishes.
    existing = next(
        (
            e
            for e in graph["edges"]
            if e["source_node_id"] == subject
            and e["target_node_id"] == target
            and e["predicate"] == predicate
        ),
        None,
    )
    if existing:
        existing["claim_ids"].append(claim["id"])
        if SCOPE_STRENGTH[scope["type"]] > SCOPE_STRENGTH[existing["scope"]["type"]]:
            existing["scope"] = scope
        refresh_edge_support(graph, existing)
        return existing, claim
    edge = Edge(
        id=new_id("ed"),
        source_node_id=subject,
        target_node_id=target,
        predicate=predicate,
        scope=scope,
        support_label=label,
        claim_ids=[claim["id"]],
        data=data or {},
        evidence_summary={"source_count": 1, "independent_family_count": 1},
    ).model_dump()
    graph["edges"].append(edge)
    return edge, claim


def validate_scope(graph, scope, temp=None):
    scope = deepcopy(scope)
    for key in ("product_node_id", "organization_node_id"):
        if scope.get(key):
            scope[key] = (temp or {}).get(scope[key], scope[key])
            expected = "product" if key == "product_node_id" else "organization"
            if find_node(graph, scope[key])["kind"] != expected:
                raise invalid(f"{key} has the wrong node kind")
    if scope["type"] == "product":
        scope.setdefault("product_node_id", graph["root_node_id"])
        if not scope.get("product_node_id"):
            scope["product_node_id"] = graph["root_node_id"]
    if scope["type"] == "company" and not scope.get("organization_node_id"):
        raise invalid("Company scope requires organization_node_id")
    return Scope.model_validate(scope).model_dump()


def merge_patch(target, patch):
    result = deepcopy(target)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_patch(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def user_layers(data):
    if set(data).intersection({"concentration", "market", "geography"}):
        raise invalid(
            "Evidence and computed layers are populated by enrichments; use custom for user assertions"
        )
    result = DataLayers.model_validate(data).model_dump(exclude_unset=True)
    if "custom" in result:
        result["custom"] = {
            k: {"value": v, "support_label": "user_asserted"} for k, v in result["custom"].items()
        }
    if "operational" in result:
        result.setdefault("custom", {})["operational_provenance"] = {
            "support_label": "user_asserted"
        }
    return result


def apply_mutations(repo, graph, batch, expected_revision):
    if graph["revision"] != expected_revision:
        raise APIError(
            409,
            "revision_conflict",
            "Graph revision has changed",
            {"current_revision": graph["revision"]},
        )
    before = deepcopy(graph)
    temp = {}
    for operation in batch.ops:
        op = operation.model_dump(exclude_none=True)
        try:
            if op["op"] == "add_node":
                raw = deepcopy(op["node"])
                if set(raw) - {
                    "kind",
                    "label",
                    "canonical_name",
                    "aliases",
                    "external_ids",
                    "data",
                }:
                    raise invalid(
                        "Node identity, tier and support status are managed by the server"
                    )
                raw["data"] = user_layers(raw.get("data", {}))
                node = Node(id=new_id("nd"), status="user_asserted", **raw).model_dump()
                if operation.temp_id:
                    if operation.temp_id in temp or any(
                        n["id"] == operation.temp_id for n in graph["nodes"]
                    ):
                        raise invalid("Temporary node IDs must be unique")
                    temp[operation.temp_id] = node["id"]
                graph["nodes"].append(node)
            elif op["op"] == "add_edge":
                raw = deepcopy(op["edge"])
                if set(raw) - {
                    "source_node_id",
                    "target_node_id",
                    "predicate",
                    "scope",
                    "rationale",
                    "data",
                }:
                    raise invalid("Edge identity and evidence are managed by the server")
                subject, target = (
                    temp.get(raw[k], raw[k]) for k in ("source_node_id", "target_node_id")
                )
                find_node(graph, subject)
                find_node(graph, target)
                if subject == target:
                    raise invalid("Self-referential relationships are not allowed")
                scope = validate_scope(graph, raw["scope"], temp)
                source = make_source(
                    repo,
                    f"urn:magellan:mutation:{new_id('mut')}",
                    "User graph assertion",
                    f"{subject} {raw['predicate']} {target}",
                    license_notes="User-asserted relationship; not independently verified.",
                )
                add_claim_edge(
                    repo,
                    graph,
                    subject,
                    target,
                    raw["predicate"],
                    scope,
                    source,
                    f"{subject} {raw['predicate']} {target}",
                    rationale=raw.get("rationale", "User graph assertion"),
                    locator="mutation",
                    data=user_layers(raw.get("data", {})),
                )
            elif op["op"] in {"update_node", "update_edge"}:
                is_node = op["op"] == "update_node"
                identifier = op["node_id" if is_node else "edge_id"]
                identifier = temp.get(identifier, identifier)
                item = find_item(graph["nodes" if is_node else "edges"], identifier)
                allowed = (
                    {"label", "canonical_name", "aliases", "external_ids", "data"}
                    if is_node
                    else {"data"}
                )
                if set(op["patch"]) - allowed:
                    raise invalid("Patch contains immutable or unsupported fields")
                evidence_identity = is_node and any(
                    c["support_label"] != "user_asserted"
                    and identifier in (c["subject_id"], c["object_id"], *c["scope"].values())
                    for c in graph["_claims"].values()
                )
                if (
                    is_node
                    and (item["status"] != "user_asserted" or evidence_identity)
                    and set(op["patch"]) - {"data"}
                ):
                    raise invalid(
                        "Evidence-backed identities cannot be rewritten; add an annotation"
                    )
                patch = deepcopy(op["patch"])
                if "data" in patch:
                    if not isinstance(patch["data"], dict):
                        raise invalid("data must be an object")
                    patch["data"] = user_layers(patch["data"])
                validated = (
                    (Node if is_node else Edge)
                    .model_validate(merge_patch(item, patch))
                    .model_dump()
                )
                item.update(validated)
            elif op["op"] == "remove_edge":
                item = find_item(graph["edges"], op["edge_id"])
                graph["edges"].remove(item)
            elif op["op"] == "remove_node":
                identifier = temp.get(op["node_id"], op["node_id"])
                if identifier == graph["root_node_id"]:
                    raise invalid("The root product cannot be removed")
                for edge in graph["edges"]:
                    if identifier in (
                        edge["source_node_id"],
                        edge["target_node_id"],
                        *edge["scope"].values(),
                    ):
                        raise invalid("Remove relationships referencing this node first")
                graph["nodes"].remove(find_node(graph, identifier))
            else:
                identifier = temp.get(op["target_id"], op["target_id"])
                item = find_item(graph["nodes"] + graph["edges"], identifier)
                item["data"]["custom"][op["key"]] = {
                    "value": operation.value,
                    "support_label": "user_asserted",
                }
        except (ValidationError, KeyError, TypeError) as exc:
            raise invalid("Invalid mutation operation", operation=op["op"]) from exc
    graph["revision"] += 1
    refresh(graph)
    repo.save_graph(graph)
    repo.put(
        "mutation",
        {
            "id": new_id("mut"),
            "graph_id": graph["id"],
            "revision_before": before["revision"],
            "revision_after": graph["revision"],
            "actor": "user",
            "message": batch.message,
            "ops": [op.model_dump(exclude_none=True) for op in batch.ops],
            "created_at": now(),
        },
        graph["id"],
    )
    return {
        "graph_id": graph["id"],
        "revision": graph["revision"],
        "delta": diff(before, graph),
        "temp_id_map": temp,
    }


def review_claim(repo, identifier, review):
    claim = repo.get(identifier, "claim")
    claim["status"] = {"accept": "accepted", "reject": "rejected", "dispute": "disputed"}[
        review.verdict
    ]
    claim["resolution_notes"].append(f"{now()} user {review.verdict}: {review.note}")
    # Human verdicts never upgrade or overwrite the evidence support label.
    repo.put("claim", claim)
    repo.put(
        "review",
        {
            "id": new_id("rev"),
            "claim_id": identifier,
            "verdict": review.verdict,
            "note": review.note,
            "actor": "user",
            "created_at": now(),
        },
        identifier,
    )
    for graph in repo.all("graph"):
        if identifier not in graph["_claims"]:
            continue
        graph["_claims"][identifier] = deepcopy(claim)
        for edge in graph["edges"]:
            if identifier not in edge["claim_ids"]:
                continue
            refresh_edge_support(graph, edge)
        graph["revision"] += 1
        refresh(graph)
        repo.save_graph(graph)
        repo.put(
            "mutation",
            {
                "id": new_id("mut"),
                "graph_id": graph["id"],
                "revision_before": graph["revision"] - 1,
                "revision_after": graph["revision"],
                "actor": "user",
                "ops": [],
                "message": f"Reviewed claim {identifier}: {review.verdict}",
                "created_at": now(),
            },
            graph["id"],
        )
    return public(claim)


def fork_graph(graph, name=None):
    """A scenario: a copy of the graph at its current revision that later research and
    hypothetical edits change while the base stays the latest real version."""
    copy = deepcopy(graph)
    copy.update(
        id=new_id("gph"),
        name=name or f"{graph['name']} (scenario)",
        parent_graph_id=graph["id"],
        forked_from_revision=graph["revision"],
        revision=0,
        run_id=None,
        mode="scenario",
        created_at=now(),
        updated_at=now(),
        scenario_edits=[],
    )
    return copy


def reset_scenario(scenario, base):
    """Put the base graph's latest nodes, edges, and claims back into the scenario."""
    scenario["nodes"] = deepcopy(base["nodes"])
    scenario["edges"] = deepcopy(base["edges"])
    scenario["_claims"] = deepcopy(base["_claims"])
    scenario["root_node_id"] = base["root_node_id"]
    scenario["forked_from_revision"] = base["revision"]
    scenario["scenario_edits"] = []
    scenario["revision"] += 1
    refresh(scenario)
    return scenario


def apply_edits(repo, graph, edits, instruction, edit_id):
    """Apply model-proposed hypothetical operations to a scenario graph. Every added edge goes
    through add_claim_edge with the instruction as its source and span, labelled user_asserted;
    removed and replaced nodes are recorded on the graph. Returns (applied, skipped)."""
    from app.resolution import resolve_entity

    if graph.get("mode") != "scenario":
        raise invalid("Hypothetical edits apply to scenario graphs only")
    source = make_source(
        repo,
        f"scenario://{graph['id']}/{edit_id}",
        "Scenario instruction",
        instruction,
        kind="other",
        publisher="scenario",
        source_family_id=f"scenario:{graph['id']}",
        license_notes="Hypothetical: the user's instruction, not public evidence.",
    )
    span = instruction[:600]
    applied, skipped = [], []
    hypothetical = {"hypothetical": {"edit_id": edit_id, "instruction": instruction}}

    def node_for(label, kind=None, create=False):
        if not label:
            return None
        for candidate_kind in (
            [kind]
            if kind
            else ["component", "material", "organization", "facility", "geography", "product"]
        ):
            node, _ = resolve_entity(graph, candidate_kind, label)
            if node:
                return node
        if create and kind:
            node = make_node(
                kind, label, status="user_asserted", data={"custom": dict(hypothetical)}
            )
            graph["nodes"].append(node)
            return node
        return None

    for edit in edits:
        op = edit.op
        try:
            if op == "add_node":
                if not edit.kind:
                    raise invalid("add_node needs a kind")
                node = node_for(edit.label, edit.kind, create=True)
                applied.append({"op": op, "node_id": node["id"], "label": node["label"]})
            elif op == "add_edge":
                subject = node_for(edit.label, edit.kind, create=bool(edit.kind))
                obj = node_for(edit.object_label, edit.object_kind, create=bool(edit.object_kind))
                if subject is None or obj is None or subject["id"] == obj["id"]:
                    raise invalid("add_edge needs two existing or fully specified entities")
                scope = (
                    {"type": "generic"}
                    if edit.predicate in {"LOCATED_IN", "OPERATES", "OWNED_BY", "SUPPLIES"}
                    else {"type": "product", "product_node_id": graph["root_node_id"]}
                )
                edge, _ = add_claim_edge(
                    repo,
                    graph,
                    subject["id"],
                    obj["id"],
                    edit.predicate,
                    scope,
                    source,
                    span,
                    "user_asserted",
                    edit.rationale or "Hypothetical edit",
                    "scenario instruction",
                    {"custom": dict(hypothetical)},
                )
                edge.setdefault("data", {}).setdefault("custom", {}).update(hypothetical)
                applied.append(
                    {
                        "op": op,
                        "edge_id": edge["id"],
                        "subject": subject["label"],
                        "predicate": edit.predicate,
                        "object": obj["label"],
                    }
                )
            elif op == "remove_edge":
                subject, obj = node_for(edit.label), node_for(edit.object_label)
                before = len(graph["edges"])
                graph["edges"] = [
                    e
                    for e in graph["edges"]
                    if not (
                        subject
                        and obj
                        and e["source_node_id"] == subject["id"]
                        and e["target_node_id"] == obj["id"]
                        and (not edit.predicate or e["predicate"] == edit.predicate)
                    )
                ]
                if len(graph["edges"]) == before:
                    raise invalid("no such edge")
                applied.append(
                    {
                        "op": op,
                        "subject": subject["label"],
                        "object": obj["label"],
                        "removed": before - len(graph["edges"]),
                    }
                )
            elif op in {"remove_node", "replace_node"}:
                old = node_for(edit.label, edit.kind)
                if old is None or old["id"] == graph["root_node_id"]:
                    raise invalid("no such node, or the product root")
                if op == "replace_node":
                    new = node_for(edit.new_label, edit.new_kind or old["kind"], create=True)
                    if new is None or new["id"] == old["id"]:
                        raise invalid("replace_node needs a different new_label")
                    for e in graph["edges"]:
                        if e["source_node_id"] == old["id"]:
                            e["source_node_id"] = new["id"]
                        if e["target_node_id"] == old["id"]:
                            e["target_node_id"] = new["id"]
                        if e["source_node_id"] == new["id"] or e["target_node_id"] == new["id"]:
                            e.setdefault("data", {}).setdefault("custom", {}).update(hypothetical)
                            e["support_label"] = "user_asserted"
                    new["status"] = "user_asserted"
                    new.setdefault("data", {}).setdefault("custom", {}).update(hypothetical)
                graph["nodes"] = [n for n in graph["nodes"] if n["id"] != old["id"]]
                graph["edges"] = [
                    e
                    for e in graph["edges"]
                    if old["id"] not in (e["source_node_id"], e["target_node_id"])
                ]
                applied.append(
                    {
                        "op": op,
                        "removed": old["label"],
                        **(
                            {"replacement": new["label"], "node_id": new["id"]}
                            if op == "replace_node"
                            else {}
                        ),
                    }
                )
            else:
                raise invalid(f"unknown op {op}")
        except APIError as exc:
            skipped.append({"op": op, "label": edit.label, "reason": exc.message})
    return applied, skipped

"""Edge provenance and a deterministic evidence score (edge_evidence_v1).

Pure projection of the claim ledger; never asks a model for a confidence percentage. The
scoring clock is pinned to recorded evidence observations, so reloading an old graph cannot
age its score. Ported from the Node backend's edge-metadata module; see EDGE_METADATA.md.
"""

import math
from datetime import UTC, datetime

BASE = {
    "directly_supported": 0.70,
    "strongly_inferred": 0.50,
    "weakly_inferred": 0.30,
    "disputed": 0.70,
    "user_asserted": 0.25,
    "unresolved": 0.0,
}
MAX_SCORE = 0.95
DISPUTED_CAP = 0.25
YEAR_SECONDS = 365.25 * 24 * 60 * 60
METHOD = {
    "name": "edge_evidence_v1",
    "params": {
        "scope": "evidence_for_stated_relation",
        "scale": "0-1",
        "max_score": MAX_SCORE,
        "disputed_cap": DISPUTED_CAP,
    },
}


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def latest(values):
    times = [t for t in (parse_time(v) for v in values) if t is not None]
    return max(times) if times else None


def stamp(moment):
    """UTC ISO timestamp with millisecond precision, matching the contract's time pattern."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def edge_metadata(edge, graph):
    claims_by_id = graph.get("_claims", {})
    claims = [claims_by_id[cid] for cid in edge["claim_ids"] if cid in claims_by_id]
    # Rejected claims are no longer evidence for the relation, though they stay in the ledger.
    active = [c for c in claims if c.get("status") != "rejected"]
    evidence = [e for c in active for e in c.get("evidence", [])]
    inline = {}
    for item in evidence:
        source = item.get("source")
        if isinstance(source, dict) and source.get("id"):
            inline.setdefault(source["id"], source)
    source_ids = sorted({e["source_id"] for e in evidence})
    sources = []
    for sid in source_ids:
        found = inline.get(sid)
        if found is None:
            continue
        types = sorted({e["support_type"] for e in evidence if e["source_id"] == sid})
        sources.append(
            {**{k: v for k, v in found.items() if not k.startswith("_")}, "support_types": types}
        )
    missing_claim_ids = [cid for cid in edge["claim_ids"] if cid not in claims_by_id]
    missing_source_ids = [sid for sid in source_ids if sid not in inline]
    observed = (
        latest([c.get("observed_at") for c in active] + [e.get("extracted_at") for e in evidence])
        or latest([s.get("retrieved_at") for s in sources])
        or latest([graph.get("created_at")])
    )
    positives = [s for s in sources if "supports" in s["support_types"]]
    web = [
        s
        for s in positives
        if s.get("kind") != "upload"
        and any(
            e["source_id"] == s["id"]
            and e["support_type"] == "supports"
            and e.get("span", "").strip()
            for e in evidence
        )
    ]
    # Connected components of shared family OR shared document hash: copied pages across
    # different hosts must not earn extra corroboration, even transitively.
    groups = []
    for s in web:
        family = s.get("source_family_id") or "unknown_family"
        content = s.get("content_hash") or "unknown_content"
        merged = {"families": {family}, "hashes": {content}}
        remaining = []
        for group in groups:
            if family in group["families"] or content in group["hashes"]:
                merged["families"] |= group["families"]
                merged["hashes"] |= group["hashes"]
            else:
                remaining.append(group)
        groups = remaining + [merged]
    notes = [
        "Heuristic evidence score, not a calibrated probability or a measure of supply-chain completeness.",
        "Family independence uses stored source-family IDs and content hashes; edited syndication may remain undetected.",
    ]
    positive_ids = {s["id"] for s in positives}
    has_support = any(
        e["support_type"] == "supports"
        and e.get("span", "").strip()
        and e["source_id"] in positive_ids
        for e in evidence
    )
    disputed = (
        edge.get("support_label") == "disputed"
        or any(e["support_type"] == "contradicts" for e in evidence)
        or any(
            c.get("status") == "disputed" or c.get("support_label") == "disputed" for c in active
        )
    )
    base = BASE.get(edge.get("support_label"), 0.0) if has_support else 0.0
    if not web:
        base = min(base, BASE["user_asserted"])
    corroboration = min(2, max(0, len(groups) - 1)) * 0.10
    freshness = 0.0
    if web:
        published = latest(
            [
                s.get("published_at")
                for s in web
                if s.get("published_at")
                and observed
                and parse_time(s["published_at"]) is not None
                and parse_time(s["published_at"]) <= observed
            ]
        )
        if published is None or observed is None:
            freshness = -0.05
            notes.append(
                "Supporting publication date unknown or in the future; retrieval time is not publication time."
            )
        else:
            age = (observed - published).total_seconds() / YEAR_SECONDS
            freshness = -0.20 if age > 5 else -0.10 if age > 2 else 0.0
            if freshness:
                notes.append(
                    "Older supporting publication reduces freshness; historical evidence may still be correct."
                )
    else:
        notes.append("User assertion or missing web support; not independently corroborated.")
    contradiction = -0.45 if disputed else 0.0
    if disputed:
        notes.append(
            "Contrary evidence caps confidence at 0.25; this does not estimate a probability that either side is true."
        )
    if graph.get("mode") == "replay":
        notes.append("Replay uses curated verdicts; the score does not imply a live model review.")
    incomplete = not has_support or missing_claim_ids or missing_source_ids
    if incomplete:
        notes.append("Missing evidence lineage forces the score to zero.")
    if incomplete:
        confidence = 0.0
    else:
        total = base + corroboration + freshness + contradiction
        confidence = max(0.0, min(DISPUTED_CAP if disputed else MAX_SCORE, total))
        confidence = math.floor(confidence * 1000 + 0.5) / 1000
    evaluated = stamp(observed) if observed else None
    return {
        "source": sources,
        "date": evaluated[:10] if evaluated else None,
        "time": evaluated[11:] if evaluated else None,
        "confidence": confidence,
        "confidence_details": {
            "method": METHOD,
            "factors": {
                "base": base,
                "corroboration": corroboration,
                "freshness": freshness,
                "contradiction": contradiction,
            },
            "data_quality": {
                "calibrated": False,
                "replay": graph.get("mode") == "replay",
                "supporting_families": len(groups),
                "missing_claim_ids": missing_claim_ids,
                "missing_source_ids": missing_source_ids,
                "notes": notes,
            },
            "evaluated_at": evaluated,
        },
    }


def annotate_edge(edge, graph):
    edge.update(edge_metadata(edge, graph))
    return edge


def has_edge_metadata(edge):
    return (
        isinstance(edge.get("source"), list)
        and "date" in edge
        and "time" in edge
        and isinstance(edge.get("confidence"), int | float)
        and bool(edge.get("confidence_details"))
    )


def ensure_edge_metadata(graph):
    """Upgrade snapshots saved before this feature on read, without rewriting them."""
    for edge in graph.get("edges", []):
        if not has_edge_metadata(edge):
            annotate_edge(edge, graph)
    return graph

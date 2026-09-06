import json
from copy import deepcopy

from app.edge_metadata import edge_metadata, ensure_edge_metadata
from tests.conftest import researched

AT = "2026-09-05T14:23:45.678Z"


class Fixture:
    def __init__(self, label="directly_supported"):
        self.source = {
            "id": "src_1",
            "url": "https://maker.org/spec",
            "title": "Specification",
            "publisher": "Maker",
            "published_at": "2026-01-01T00:00:00Z",
            "retrieved_at": AT,
            "content_hash": "hash-1",
            "source_family_id": "family-1",
            "kind": "other",
            "license_notes": None,
        }
        self.claim = {
            "id": "clm_1",
            "subject_id": "nd_part",
            "object_id": "nd_product",
            "predicate": "PART_OF",
            "scope": {"type": "product", "product_node_id": "nd_product"},
            "status": "accepted",
            "support_label": label,
            "rationale": "Verified quote",
            "observed_at": AT,
            "contradiction_claim_ids": [],
            "resolution_notes": [],
            "evidence": [
                {
                    "id": "ev_1",
                    "source_id": "src_1",
                    "span": "This part is in the product.",
                    "locator": "chars 0:28",
                    "support_type": "supports",
                    "extracted_at": AT,
                    "source": self.source,
                }
            ],
        }
        self.edge = {
            "id": "ed_test",
            "source_node_id": "nd_part",
            "target_node_id": "nd_product",
            "predicate": "PART_OF",
            "scope": self.claim["scope"],
            "support_label": label,
            "claim_ids": ["clm_1"],
            "data": {},
        }
        self.graph = {"_claims": {"clm_1": self.claim}, "created_at": AT, "mode": "live"}

    def add(self, n, family=None, content=None, polarity="supports"):
        source = {
            **self.source,
            "id": f"src_{n}",
            "url": f"https://source{n}.org/spec",
            "source_family_id": family or f"family-{n}",
            "content_hash": content or f"hash-{n}",
        }
        claim = deepcopy(self.claim)
        claim["id"] = f"clm_{n}"
        claim["evidence"] = [
            {
                **self.claim["evidence"][0],
                "id": f"ev_{n}",
                "source_id": f"src_{n}",
                "support_type": polarity,
                "source": source,
            }
        ]
        self.graph["_claims"][claim["id"]] = claim
        self.edge["claim_ids"].append(claim["id"])

    def score(self):
        return edge_metadata(self.edge, self.graph)


def test_metadata_carries_provenance_and_stable_utc_evidence_timestamps():
    f = Fixture()
    f.claim["observed_at"] = "2026-09-05T12:23:45.678-04:00"
    result = f.score()
    assert result["date"] == "2026-09-05" and result["time"] == "16:23:45.678Z"
    assert result["source"][0]["published_at"] == "2026-01-01T00:00:00Z"
    assert result["source"][0]["support_types"] == ["supports"]
    assert result["confidence"] == 0.7
    assert result["confidence_details"]["data_quality"]["calibrated"] is False
    assert result["confidence_details"]["evaluated_at"] == "2026-09-05T16:23:45.678Z"
    assert f.score() == result


def test_only_distinct_supporting_families_or_content_earn_saturating_corroboration():
    f = Fixture()
    f.add(2, family="family-1")
    assert f.score()["confidence"] == 0.7
    f.add(3, family="different-host", content="hash-1")
    assert f.score()["confidence"] == 0.7
    f.add(4)
    assert f.score()["confidence"] == 0.8
    f.add(5)
    assert f.score()["confidence"] == 0.9
    f.add(6)
    assert f.score()["confidence"] == 0.9
    # A bridge between groups also deduplicates their transitive family/content links.
    f.add(7, family="family-4", content="hash-1")
    assert f.score()["confidence_details"]["data_quality"]["supporting_families"] == 3


def test_unknown_future_and_old_publication_dates_reduce_freshness():
    f = Fixture()
    for published, expected in [
        (None, 0.65),
        ("2030-01-01T00:00:00Z", 0.65),
        ("2023-01-01T00:00:00Z", 0.6),
        ("2019-01-01T00:00:00Z", 0.5),
    ]:
        f.source["published_at"] = published
        assert f.score()["confidence"] == expected, published


def test_contradictions_stay_in_source_metadata_and_cap_confidence():
    f = Fixture()
    f.add(2)
    f.add(3)
    f.add(4, family="contrary-family", content="contrary-content", polarity="contradicts")
    scored = f.score()
    assert scored["confidence"] == 0.25 and len(scored["source"]) == 4
    contrary = next(s for s in scored["source"] if s["id"] == "src_4")
    assert contrary["support_types"] == ["contradicts"]
    assert scored["confidence_details"]["factors"]["contradiction"] == -0.45
    assert scored["confidence_details"]["data_quality"]["supporting_families"] == 3


def test_user_assertions_score_modestly_and_broken_lineage_scores_zero():
    f = Fixture("user_asserted")
    f.source["kind"] = "upload"
    f.source["published_at"] = None
    assert f.score()["confidence"] == 0.25
    f.edge["claim_ids"].append("clm_missing")
    assert f.score()["confidence"] == 0
    f.edge["claim_ids"].pop()
    del f.claim["evidence"][0]["source"]
    result = f.score()
    assert result["confidence"] == 0 and result["source"] == []
    assert result["confidence_details"]["data_quality"]["missing_source_ids"] == ["src_1"]


def test_rejected_claims_stop_counting_as_evidence():
    f = Fixture()
    f.add(2)
    assert f.score()["confidence"] == 0.8
    f.graph["_claims"]["clm_2"]["status"] = "rejected"
    assert f.score()["confidence"] == 0.7 and len(f.score()["source"]) == 1
    f.graph["_claims"]["clm_1"]["status"] = "rejected"
    assert f.score()["confidence"] == 0


def test_replay_is_flagged_and_legacy_annotation_is_idempotent():
    f = Fixture()
    graph = {**f.graph, "mode": "replay", "edges": [f.edge]}
    ensure_edge_metadata(graph)
    assert graph["edges"][0]["confidence_details"]["data_quality"]["replay"] is True
    first = json.dumps(graph, sort_keys=True)
    ensure_edge_metadata(graph)
    assert json.dumps(graph, sort_keys=True) == first
    empty = edge_metadata(
        {**f.edge, "claim_ids": []}, {"_claims": {}, "mode": "live", "created_at": "invalid"}
    )
    assert empty["date"] is None and empty["time"] is None
    assert empty["source"] == [] and empty["confidence"] == 0


async def test_api_edges_carry_confidence_on_every_read_path(api):
    client, _ = api
    upload = (
        await client.post(
            "/v1/uploads",
            files={"file": ("bom.csv", "component,quantity,unit\nBroadcom BCM2712,1,ea")},
        )
    ).json()
    run, graph = await researched(api, upload_id=upload["id"])
    by_label = {}
    for edge in graph["edges"]:
        assert edge["confidence_details"]["method"]["name"] == "edge_evidence_v1"
        assert edge["date"] and edge["time"].endswith("Z") and edge["source"]
        by_label.setdefault(edge["support_label"], []).append(edge)
    # Fixture pages have no publication date: a single directly supported source scores 0.65,
    # and the upload row corroborated by the same page keeps that score with two sources.
    assert {e["confidence"] for e in by_label["directly_supported"]} == {0.65}
    corroborated = next(e for e in graph["edges"] if len(e["claim_ids"]) == 2)
    assert {s["kind"] for s in corroborated["source"]} == {"upload", "datasheet"}
    detail = (await client.get(f"/v1/graphs/{graph['id']}/edges/{corroborated['id']}")).json()
    assert detail["confidence"] == 0.65 and detail["confidence_details"]["factors"]["base"] == 0.7
    export = (await client.get(f"/v1/graphs/{graph['id']}/export")).json()
    assert all(e["confidence"] == 0.65 for e in export["edges"])
    # Rejecting the public claim leaves only the user assertion: 0.25.
    public_claim = next(c for c in detail["claims"] if c["support_label"] == "directly_supported")
    await client.post(f"/v1/claims/{public_claim['id']}/review", json={"verdict": "reject"})
    detail = (await client.get(f"/v1/graphs/{graph['id']}/edges/{corroborated['id']}")).json()
    assert detail["support_label"] == "user_asserted" and detail["confidence"] == 0.25
    diff = (
        await client.get(f"/v1/graphs/{graph['id']}/diff?from=0&to={detail and graph['revision']}")
    ).json()
    assert all("confidence" in e for e in diff["edges_added"])

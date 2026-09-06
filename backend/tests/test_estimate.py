import base64

import pytest

from app.estimate import ComposedItem, project_items, rank_hits
from app.providers import Page, public_url

JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")
PI_PAGE = "https://www.raspberrypi.com/documentation/computers/processors.html"


async def test_estimate_from_a_description_labels_every_item_with_code_assigned_provenance(api):
    client, _ = api
    response = await client.post("/v1/bom", json={"description": "Raspberry Pi 5 board"})
    assert response.status_code == 200, response.text
    bom = response.json()
    assert bom["status"] == "completed" and bom["stop_reason"] == "finished"
    assert bom["provider"] == "curated_fixture" and bom["mode"] == "live"
    assert bom["product"]["name"] == "Raspberry Pi 5" and bom["product"]["brand"] == "Raspberry Pi"
    assert bom["product"]["identified_from"] == ["description"]
    assert {i["name"] for i in bom["items"]} == {
        "Broadcom BCM2712",
        "RP1 I/O controller",
        "LPDDR4X-4267 SDRAM",
    }
    sources = {s["id"]: s for s in bom["sources"]}
    for item in bom["items"]:
        assert item["basis"] == "evidenced" and item["confidence"] == "high"
        assert item["quantity"] is None and item["parent_item_id"] is None
        ref = item["sources"][0]
        assert ref["type"] == "web_page" and ref["source_id"] in sources
        assert ref["quote"] and ref["locator"].startswith("chars ")
        assert sources[ref["source_id"]]["url"] == ref["url"]
    assert any(e["id"] == "U1" and e["ref"]["type"] == "user_input" for e in bom["evidence"])
    assert bom["usage"]["documents"] == 3 and bom["usage"]["searches"] >= 1
    assert bom["usage"]["model_calls"] == 5 and bom["usage"]["cost_minor"] == 0
    assert bom["open_questions"] and bom["disclaimer"]
    # Persisted and workspace-scoped like every other resource.
    again = await client.get(f"/v1/bom/{bom['id']}")
    assert again.status_code == 200 and again.json()["items"] == bom["items"]
    assert (await client.get("/v1/bom/bom_missing")).status_code == 404
    other = await client.get(f"/v1/bom/{bom['id']}", headers={"Authorization": "Bearer beta-token"})
    assert other.status_code == 404
    # Stored pages are private: only the source metadata is exposed.
    source = (await client.get(f"/v1/sources/{bom['items'][0]['sources'][0]['source_id']}")).json()
    assert "_body" not in source and source["content_hash"]


async def test_estimate_accepts_link_and_multipart_photo_and_records_inputs(api):
    client, _ = api
    response = await client.post(
        "/v1/bom",
        data={"description": "Raspberry Pi 5", "url": PI_PAGE, "limits": '{"max_searches": 0}'},
        files={"image": ("board.jpg", JPEG, "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    bom = response.json()
    assert bom["status"] == "completed"
    assert bom["product"]["identified_from"] == ["description", "url", "image"]
    assert bom["inputs"]["url"] == PI_PAGE and bom["inputs"]["description"] == "Raspberry Pi 5"
    assert bom["inputs"]["image"]["media_type"] == "image/jpeg"
    assert bom["inputs"]["image"]["bytes"] == len(JPEG)
    assert bom["limits"]["max_searches"] == 0 and bom["usage"]["searches"] == 0
    # Only the linked page was read, so exactly its component is listed.
    assert [i["name"] for i in bom["items"]] == ["Broadcom BCM2712"]
    kinds = {s["kind"] for s in bom["sources"]}
    assert "upload" in kinds and any(s["url"] == PI_PAGE for s in bom["sources"])
    assert any("photos" in q for q in bom["open_questions"])
    # Inline base64 JSON works too and must match the declared media type.
    inline = await client.post(
        "/v1/bom",
        json={
            "description": "Raspberry Pi 5",
            "image": {"data": base64.b64encode(JPEG).decode(), "media_type": "image/jpeg"},
            "limits": {"max_searches": 0, "max_documents": 0},
        },
    )
    assert inline.status_code == 200 and inline.json()["inputs"]["image"]["sha256"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"description": "x", "image": {"data": "not base64!!", "media_type": "image/png"}},
        {
            "description": "x",
            "image": {"data": base64.b64encode(JPEG).decode(), "media_type": "image/png"},
        },
        {"description": "x", "url": "http://127.0.0.1/secret"},
        {"description": "x", "image_url": "file:///etc/passwd"},
        {"description": "x", "limits": {"max_items": 0}},
        {"description": "x", "unknown": True},
    ],
)
async def test_invalid_estimate_requests_are_rejected(api, body):
    client, _ = api
    response = await client.post("/v1/bom", json=body)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "invalid_input"


async def test_unknown_product_estimate_is_honest_about_gaps(api):
    client, _ = api
    response = await client.post("/v1/bom", json={"description": "Unlisted gadget 314159"})
    assert response.status_code == 200
    bom = response.json()
    assert bom["status"] == "completed" and bom["items"] == []
    assert bom["product"]["name"] == "Unlisted gadget 314159"
    assert bom["product"]["ambiguity"]
    assert any("No curated evidence" in q for q in bom["open_questions"])
    assert any("No web documents" in q for q in bom["open_questions"])


def test_project_items_lets_code_not_the_model_decide_provenance():
    web = {
        "type": "web_page",
        "source_id": "src_1",
        "url": "https://a.org/p",
        "title": None,
        "quote": "q",
        "locator": "chars 0:1",
    }
    unverified = {
        "type": "web_page_unverified",
        "source_id": "src_1",
        "url": "https://a.org/p",
        "title": None,
        "claimed_quote": "z",
        "note": "n",
    }
    photo = {"type": "image_analysis", "source_id": "src_2", "note": "seen"}
    registry = {"E1": {"ref": web}, "E2": {"ref": unverified}, "V1": {"ref": photo}}

    def composed(name, ids, **extra):
        base = {
            "name": name,
            "category": "component",
            "quantity": None,
            "unit": None,
            "material": None,
            "manufacturer": None,
            "part_number": None,
            "parent_name": None,
            "notes": None,
            "evidence_ids": ids,
            "general_knowledge": False,
            "confidence": "high",
        }
        return ComposedItem.model_validate(base | extra)

    items, unknown = project_items(
        [
            composed("Chip", ["E1"], manufacturer="Acme"),
            composed("Battery", ["E2", "E999"], general_knowledge=True, confidence="medium"),
            composed("Enclosure", ["V1"]),
            composed("Main PCB", [], general_knowledge=True),
            composed("chip", ["E1"], notes="duplicate row"),
            composed("Ribbon cable", ["E1"], parent_name="Chip", confidence="low"),
            composed("Overflow", ["E1"]),
        ],
        registry,
        5,
    )
    by_name = {i["name"]: i for i in items}
    assert unknown == ["E999"] and "Overflow" not in by_name and len(items) == 5
    assert by_name["Chip"]["basis"] == "evidenced" and by_name["Chip"]["notes"] == "duplicate row"
    assert by_name["Battery"]["basis"] == "inferred"
    assert [s["type"] for s in by_name["Battery"]["sources"]] == [
        "web_page_unverified",
        "model_knowledge",
    ]
    assert (
        by_name["Enclosure"]["basis"] == "inferred" and by_name["Enclosure"]["confidence"] == "high"
    )
    assert (
        by_name["Main PCB"]["basis"] == "guessed" and by_name["Main PCB"]["confidence"] == "medium"
    )
    assert [s["type"] for s in by_name["Main PCB"]["sources"]] == ["model_knowledge"]
    assert by_name["Ribbon cable"]["parent_item_id"] == by_name["Chip"]["id"]


def test_rank_hits_skips_video_hosts_and_prefers_teardown_and_brand_domains():
    page = lambda url: Page(url=url, title="t", snippet="s", body=None)  # noqa: E731
    ranked = rank_hits(
        [
            (page("https://youtube.com/watch?v=1"), "q"),
            (page("https://blog.org/post"), "q"),
            (page("https://www.ifixit.com/Teardown/x"), "q"),
            (page("https://sensorly.com/specs"), "q"),
            (page("https://blog.org/post"), "other"),
        ],
        "Sensorly",
    )
    assert [e["page"].url for e in ranked] == [
        "https://www.ifixit.com/Teardown/x",
        "https://sensorly.com/specs",
        "https://blog.org/post",
    ]


@pytest.mark.parametrize(
    "url, ok",
    [
        ("https://manufacturer.org/spec", True),
        ("http://127.0.0.1", False),
        ("http://[::1]/x", False),
        ("http://localhost/x", False),
        ("https://user:secret@manufacturer.org", False),
        ("http://a.internal/x", False),
        ("file:///etc/passwd", False),
        ("not a url", False),
    ],
)
def test_public_url_boundary(url, ok):
    assert public_url(url) is ok

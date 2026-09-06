"""Live-provider behaviour for the BOM estimate, with mocked HTTP: no paid calls."""

import base64
import json

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.estimate import VisionResult
from app.providers import IMAGE_TOKEN_RESERVE, LiveProvider, ProviderFailure
from tests.test_estimate import JPEG
from tests.test_providers import budget, response_data, settings

VISION = {
    "product_guess": "Sensor One",
    "brand_guess": "Sensorly",
    "category": "sensor kit",
    "visible_text": ["SENSOR ONE"],
    "visible_items": [
        {"name": "Black enclosure", "category": "component", "material": "ABS", "notes": None}
    ],
    "notes": "Clear photo.",
}


@pytest.mark.parametrize("llm_provider", ["openai", "openrouter"])
async def test_inline_images_are_sent_as_content_parts_and_reserved_flatly(llm_provider):
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data(VISION, llm_provider))

    data = base64.b64encode(JPEG).decode()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(llm_provider), client)
        allowance = budget()
        result = await provider.structured(
            VisionResult,
            "Describe the photo.",
            {"description": "kit"},
            allowance,
            images=[{"media_type": "image/jpeg", "data": data}],
            max_output=2000,
        )
    assert result.product_guess == "Sensor One"
    body = bodies[0]
    expected = f"data:image/jpeg;base64,{data}"
    if llm_provider == "openai":
        parts = body["input"][0]["content"]
        assert parts[0]["type"] == "input_text" and json.loads(parts[0]["text"]) == {
            "description": "kit"
        }
        assert parts[1] == {"type": "input_image", "image_url": expected, "detail": "auto"}
        assert body["max_output_tokens"] == 2000
    else:
        parts = body["messages"][1]["content"]
        assert parts[0] == {"type": "text", "text": json.dumps({"description": "kit"})}
        assert parts[1] == {"type": "image_url", "image_url": {"url": expected}}
        assert body["max_tokens"] == 2000
    # The image never enters the byte-count reservation; it is reserved at a flat rate and the
    # provider's reported usage replaces the reservation afterwards.
    assert IMAGE_TOKEN_RESERVE == 4000 and allowance.usage["input_tokens"] == 100


async def test_image_urls_must_be_public():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response_data(VISION)))
    ) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings(), client).structured(
                VisionResult, "x", {}, budget(), images=[{"url": "http://127.0.0.1/cam.jpg"}]
            )
    assert caught.value.code == "invalid_input"


async def test_search_pages_and_fetch_page_use_tavily_and_reject_private_or_empty_sources():
    calls = []

    def handle(request):
        data = json.loads(request.content)
        calls.append((request.url.path, data))
        if request.url.path == "/search":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://ifixit.com/teardown",
                            "title": "Teardown",
                            "content": "snippet",
                            "raw_content": "Full page text with the BCM2712 processor.",
                        },
                        {"url": "https://blog.org/no-body", "title": "No body", "content": "s"},
                        {"url": "http://10.0.0.1/private", "title": "Private", "raw_content": "x"},
                        "garbage",
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "results": [
                    {"url": data["urls"][0], "raw_content": "A long enough extracted page body."}
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        allowance = budget()
        pages = await provider.search_pages("Sensor One teardown", 5, allowance)
        assert [p.url for p in pages] == ["https://ifixit.com/teardown", "https://blog.org/no-body"]
        assert pages[0].body.startswith("Full page") and pages[1].body is None
        assert calls[0][1]["include_raw_content"] == "text" and calls[0][1]["max_results"] == 5
        page = await provider.fetch_page("https://manufacturer.org/spec", allowance)
        assert page.body.startswith("A long enough") and calls[1][0] == "/extract"
        assert allowance.usage["searches"] == 1 and allowance.usage["documents"] == 1
        with pytest.raises(ProviderFailure) as caught:
            await provider.fetch_page("http://localhost/x", allowance)
        assert caught.value.code == "invalid_input"


async def test_fetch_page_empty_extraction_is_a_provider_failure():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"results": []}))
    ) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings(), client).fetch_page(
                "https://manufacturer.org/spec", budget()
            )
    assert caught.value.code == "source_unavailable"


def test_paid_openrouter_models_require_billing_rates():
    base = {
        "_env_file": None,
        "research_provider": "live",
        "llm_provider": "openrouter",
        "tavily_api_key": "t",
        "openrouter_api_key": "r",
    }
    with pytest.raises(ValidationError, match="must be openrouter/free"):
        Settings(**base, openrouter_model="openai/gpt-4o-mini")
    with pytest.raises(ValidationError, match="must be openrouter/free"):
        Settings(
            **base,
            openrouter_model="openai/gpt-4o-mini",
            input_token_cost_per_million_minor=15,
        )
    paid = Settings(
        **base,
        openrouter_model="openai/gpt-4o-mini",
        openrouter_verifier_model="openai/gpt-4o-mini",
        input_token_cost_per_million_minor=15,
        output_token_cost_per_million_minor=60,
    )
    assert paid.openrouter_paid_allowed
    # Automatic routers stay free-only even with rates configured.
    with pytest.raises(ValidationError, match="must be openrouter/free"):
        Settings(
            **base,
            openrouter_model="openrouter/auto",
            input_token_cost_per_million_minor=15,
            output_token_cost_per_million_minor=60,
        )


async def test_paid_openrouter_price_ceilings_follow_configured_rates():
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data(VISION, "openrouter"))

    config = Settings(
        _env_file=None,
        research_provider="live",
        llm_provider="openrouter",
        tavily_api_key="t",
        openrouter_api_key="r",
        openrouter_model="openai/gpt-4o-mini",
        openrouter_verifier_model="openai/gpt-4o-mini",
        input_token_cost_per_million_minor=15,
        output_token_cost_per_million_minor=60,
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await LiveProvider(config, client).structured(VisionResult, "x", {}, budget())
    assert bodies[0]["model"] == "openai/gpt-4o-mini"
    assert bodies[0]["provider"] == {
        "require_parameters": True,
        "max_price": {"prompt": 0.15, "completion": 0.6, "request": 0},
    }

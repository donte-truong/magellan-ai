import json

import httpx
import pytest

from app.config import Settings
from app.providers import Budget, BudgetExceeded, LiveProvider, ProviderFailure
from app.schemas import RunLimits, RunUsage


def response_data(payload, llm_provider="openai"):
    if llm_provider == "openrouter":
        return {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(payload)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 100},
        }
    return {
        "status": "completed",
        "usage": {"input_tokens": 100, "output_tokens": 100},
        "output": [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(payload)}]}
        ],
    }


def budget(**limits):
    return Budget(RunLimits(**limits).model_dump(), RunUsage().model_dump(exclude_none=True))


def settings(llm_provider="openai", **overrides):
    return Settings(
        _env_file=None,
        research_provider="live",
        llm_provider=llm_provider,
        tavily_api_key="test",
        openai_api_key="test",
        openai_model="test-model",
        openrouter_api_key="router-test",
        openrouter_model="test/extractor:free",
        openrouter_verifier_model="test/verifier:free",
        **overrides,
    )


@pytest.mark.parametrize("llm_provider", ["openai", "openrouter"])
async def test_live_provider_fetches_raw_text_and_checks_quotes_and_entailment(llm_provider):
    calls = []
    body = "Widget uses copper and a battery."

    def handle(request):
        data = json.loads(request.content)
        calls.append((str(request.url), data))
        if request.url.host == "api.tavily.com":
            assert data["include_raw_content"] == "text" and not data["include_answer"]
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://example.org/snippet",
                            "content": "Snippet is not evidence",
                        },
                        {"url": "https://example.org/spec", "title": "Widget", "raw_content": body},
                    ]
                },
            )
        if llm_provider == "openai":
            assert request.url.host == "api.openai.com"
            assert data["store"] is False and data["text"]["format"]["strict"] is True
            assert data["model"] == "test-model"
            name = data["text"]["format"]["name"]
        else:
            assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
            assert request.headers["Authorization"] == "Bearer router-test"
            assert data["provider"] == {
                "require_parameters": True,
                "max_price": {"prompt": 0, "completion": 0, "request": 0},
            }
            name = data["response_format"]["json_schema"]["name"]
            assert data["model"] == (
                "test/extractor:free" if name == "extraction" else "test/verifier:free"
            )
        if name == "extraction":

            def finding(label, quote):
                return {
                    "label": label,
                    "kind": "component",
                    "predicate": "PART_OF",
                    "object_label": None,
                    "object_kind": None,
                    "part_number": None,
                    "manufacturer": None,
                    "quote": quote,
                    "scope_type": "product",
                    "rationale": "Test claim",
                    "quantity": 1,
                    "unit": "ea",
                }

            return httpx.Response(
                200,
                json=response_data(
                    {
                        "findings": [
                            finding("battery", body),
                            finding("made up", "A nonexistent quote"),
                            finding("unrelated", body),
                        ]
                    },
                    llm_provider,
                ),
            )
        return httpx.Response(
            200,
            json=response_data(
                {
                    "findings": [
                        {
                            "index": 0,
                            "entailed": True,
                            "scope_matches": True,
                            "quantity_supported": False,
                            "share_supported": False,
                            "reason": "stated",
                        },
                        {
                            "index": 2,
                            "entailed": False,
                            "scope_matches": True,
                            "quantity_supported": False,
                            "share_supported": False,
                            "reason": "stated",
                        },
                    ]
                },
                llm_provider,
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(llm_provider), client)
        assert provider.name == f"tavily_{llm_provider}"
        allowance = budget()
        documents = [
            d
            async for d in provider.research(
                {"label": "Widget", "tier": 0}, "Widget", None, allowance
            )
        ]
    assert len(documents) == 1 and len(calls) == 3
    findings = documents[0].findings
    assert findings[0].rejection is None and findings[0].quantity is None
    assert findings[1].rejection == "span_not_found"
    assert findings[2].rejection == "entailment_failed"
    assert allowance.usage["searches"] == allowance.usage["documents"] == 1
    assert allowance.usage["input_tokens"] == allowance.usage["output_tokens"] == 200


async def test_live_provider_enforces_budget_before_network_request():
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"results": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        with pytest.raises(BudgetExceeded, match="max_searches"):
            async for _ in provider.research(
                {"label": "test"}, "test", None, budget(max_searches=0)
            ):
                pass
    assert calls == []


@pytest.mark.parametrize("failure", ["timeout", "http_error", "malformed"])
async def test_provider_errors_are_stable_and_do_not_leak_response_bodies(failure):
    def handle(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("secret provider error", request=request)
        return httpx.Response(503 if failure == "http_error" else 200, text="secret provider error")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        with pytest.raises(ProviderFailure) as error:
            async for _ in provider.research({"label": "test"}, "test", None, budget()):
                pass
    assert "secret" not in error.value.message
    assert error.value.code == (
        "provider_timeout" if failure == "timeout" else "source_unavailable"
    )


@pytest.mark.parametrize("llm_provider", ["openai", "openrouter"])
async def test_location_verification_does_not_invent_coordinates(llm_provider):
    def handle(request):
        data = json.loads(request.content)
        if request.url.host == "api.tavily.com":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://example.org/plant",
                            "raw_content": "Test Plant is in France.",
                        }
                    ]
                },
            )
        name = (
            data["text"]["format"]["name"]
            if llm_provider == "openai"
            else data["response_format"]["json_schema"]["name"]
        )
        if llm_provider == "openrouter":
            assert data["model"] == (
                "test/extractor:free" if name == "locationextraction" else "test/verifier:free"
            )
        if name == "locationextraction":
            return httpx.Response(
                200,
                json=response_data(
                    {
                        "quote": "Test Plant is in France.",
                        "location": {"country_iso2": "FR", "lat": 48.8, "lon": 2.3},
                    },
                    llm_provider,
                ),
            )
        return httpx.Response(
            200,
            json=response_data(
                {"identity_and_country_supported": True, "coordinates_supported": False},
                llm_provider,
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(llm_provider), client)
        document = await provider.locate({"label": "Test Plant"}, budget())
    assert document.geography["country_iso2"] == "FR"
    assert document.geography["lat"] is None and document.geography["lon"] is None


async def test_rate_limits_are_retried_with_bounded_waits_then_fail_closed(monkeypatch):
    import app.providers as providers

    monkeypatch.setattr(providers, "RATE_LIMIT_WAIT_SECONDS", 0.0)
    monkeypatch.setattr(providers, "RATE_LIMIT_MAX_WAIT_SECONDS", 0.0)
    calls = []

    def handle(request):
        calls.append(request)
        if len(calls) < 3:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "busy"})
        return httpx.Response(200, json={"results": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        assert await provider.search_pages("Widget", 3, budget()) == []
    assert len(calls) == 3
    calls.clear()

    def always_busy(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "busy"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(always_busy)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings(), client).search_pages("Widget", 3, budget())
    assert caught.value.code == "source_unavailable" and len(calls) == 4


async def test_verification_sends_quote_windows_instead_of_the_whole_page():
    bodies = []
    filler = "Boilerplate navigation text. " * 400
    page = filler + "Widget contains a battery made by Acme." + filler

    def handle(request):
        data = json.loads(request.content)
        if request.url.host == "api.tavily.com":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"url": "https://example.org/spec", "title": "Widget", "raw_content": page}
                    ]
                },
            )
        bodies.append(data)
        name = data["text"]["format"]["name"]
        if name == "extraction":
            finding = {
                "label": "battery",
                "kind": "component",
                "predicate": "PART_OF",
                "object_label": None,
                "object_kind": None,
                "part_number": None,
                "manufacturer": None,
                "quote": "Widget contains a battery made by Acme.",
                "scope_type": "product",
                "rationale": "stated",
                "quantity": None,
                "unit": None,
            }
            return httpx.Response(200, json=response_data({"findings": [finding]}))
        return httpx.Response(
            200,
            json=response_data(
                {
                    "findings": [
                        {
                            "index": 0,
                            "entailed": True,
                            "scope_matches": True,
                            "quantity_supported": False,
                            "share_supported": False,
                            "reason": "stated",
                        }
                    ]
                }
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        docs = [
            d
            async for d in provider.research(
                {"label": "Widget", "tier": 0}, "Widget", None, budget()
            )
        ]
    assert docs[0].findings[0].rejection is None
    verification = json.loads(bodies[1]["input"])
    assert "document" not in verification
    context = verification["claims"][0]["context"]
    assert "Widget contains a battery made by Acme." in context and len(context) < 1000
    assert len(json.loads(bodies[0]["input"])["document"]) > len(context)


async def test_provider_calls_have_a_hard_deadline(monkeypatch):
    import asyncio

    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200, json={"results": []})

    config = settings(provider_call_deadline_seconds=10)
    monkeypatch.setattr(config, "provider_call_deadline_seconds", 1, raising=False)
    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
        provider = LiveProvider(config, client)
        with pytest.raises(ProviderFailure) as caught:
            await provider.search_pages("Widget", 3, budget())
    assert caught.value.code == "provider_timeout"


async def test_static_gates_skip_verification_for_claims_that_can_never_commit():
    calls = []

    def handle(request):
        if request.url.host == "api.tavily.com":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://example.org/spec",
                            "title": "Widget",
                            "raw_content": "Widget Pro has a USB 3.0 port. Gadget contains tin.",
                        }
                    ]
                },
            )
        data = json.loads(request.content)
        calls.append(data["text"]["format"]["name"])
        base = {
            "object_label": None,
            "object_kind": None,
            "part_number": None,
            "manufacturer": None,
            "rationale": "stated",
            "quantity": None,
            "unit": None,
            "scope_type": "product",
        }
        findings = [
            # An interface feature and a claim about another product: rejected before verification.
            {
                **base,
                "label": "USB 3.0 port",
                "kind": "component",
                "predicate": "PART_OF",
                "quote": "Widget Pro has a USB 3.0 port",
            },
            {
                **base,
                "label": "tin",
                "kind": "material",
                "predicate": "INPUT_TO",
                "object_label": "Gadget",
                "object_kind": "product",
                "quote": "Gadget contains tin",
            },
        ]
        return httpx.Response(200, json=response_data({"findings": findings}))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(settings(), client)
        docs = [
            d
            async for d in provider.research(
                {"label": "Widget", "kind": "product", "tier": 0}, "Widget", None, budget()
            )
        ]
    assert calls == ["extraction"]  # no verification call was paid for
    assert [f.rejection for f in docs[0].findings] == ["predicate_invalid", "scope_mismatch"]

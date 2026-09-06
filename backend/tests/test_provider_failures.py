"""Provider outages must be actionable without exposing their response bodies or inventing data."""

import json

import httpx
import pytest

from app.providers import Extraction, LiveProvider, ProviderFailure, retry_delay
from tests.test_providers import budget, response_data, settings


@pytest.mark.parametrize("status", [200, 429])
async def test_daily_model_quota_stops_immediately_and_records_safe_failure(status):
    calls, entries = [], []

    def handle(request):
        calls.append(json.loads(request.content))
        return httpx.Response(
            status,
            json={
                "error": {
                    "code": 429,
                    "message": "Upstream error with private credentials",
                    "metadata": {
                        "provider_name": "GMICloud",
                        "raw": '{"message":"Daily limit reached for secret-model"}',
                    },
                }
            },
        )

    allowance = budget()
    allowance.trace = entries.append
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).structured(
                Extraction, "Extract evidence.", {}, allowance, role="planner"
            )

    assert len(calls) == 1
    assert calls[0]["model"] == "test/verifier:free"
    assert caught.value.code == "provider_quota_exhausted"
    assert caught.value.http_status == status
    assert "quota" in caught.value.message and "OpenRouter" in caught.value.message
    assert len(entries) == 1
    assert entries[0] == {
        "stage": "Extraction",
        "role": "planner",
        "model": "test/verifier:free",
        "failure": "provider_quota_exhausted",
        "http_status": status,
        "usage": {"input_tokens_reserved": allowance.usage["input_tokens"]},
        "output": None,
    }
    assert allowance.usage["output_tokens"] == 0
    public_and_history = caught.value.message + json.dumps(entries)
    assert not any(secret in public_and_history for secret in ("private", "secret", "GMICloud"))


async def test_tavily_search_usage_limit_is_actionable_and_never_retried():
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.host == "api.tavily.com" and request.url.path == "/search"
        return httpx.Response(
            432,
            json={
                "detail": {
                    "error": "This request exceeds your plan's set usage limit. "
                    "Please upgrade your plan or contact private-support@example.org"
                }
            },
        )

    allowance = budget()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).search_pages(
                "Widget components", 3, allowance
            )
    assert len(calls) == 1
    assert caught.value.code == "provider_quota_exhausted" and caught.value.http_status == 432
    assert "Tavily" in caught.value.message and "search usage limit" in caught.value.message
    assert "model" not in caught.value.message and "private" not in caught.value.message
    assert allowance.usage["searches"] == 1 and allowance.usage["documents"] == 0


@pytest.mark.parametrize(
    "status, expected",
    [
        (400, "provider_request_invalid"),
        (401, "provider_auth_failed"),
        (402, "provider_quota_exhausted"),
        (403, "provider_auth_failed"),
        (404, "provider_model_unavailable"),
        (429, "provider_rate_limited"),
        (502, "provider_unavailable"),
        (503, "provider_unavailable"),
    ],
)
async def test_http_errors_have_actionable_safe_classes(status, expected, monkeypatch):
    import app.providers as providers

    monkeypatch.setattr(providers, "RATE_LIMIT_WAIT_SECONDS", 0)
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "private response body"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).structured(
                Extraction, "Extract.", {}, budget()
            )
    assert caught.value.code == expected and caught.value.http_status == status
    assert "private" not in str(caught.value)
    assert len(calls) == (1 + providers.RATE_LIMIT_RETRIES if status == 429 else 1)


@pytest.mark.parametrize(
    "error, expected",
    [
        ({"code": "insufficient_quota", "message": "secret"}, "provider_quota_exhausted"),
        ({"code": "404", "message": "secret"}, "provider_model_unavailable"),
        ({"code": 503, "message": "secret"}, "provider_unavailable"),
        ({"code": 429, "message": "secret"}, "provider_rate_limited"),
        ({"message": "secret"}, "provider_unavailable"),
    ],
)
async def test_http_200_error_envelopes_are_not_model_validation_failures(error, expected):
    calls = []

    def handle(request):
        calls.append(request)
        # Errors take precedence even if a gateway also supplied an unusable usage field.
        return httpx.Response(200, json={"error": error, "usage": "invalid"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).structured(
                Extraction, "Extract.", {}, budget()
            )
    assert caught.value.code == expected
    assert len(calls) == 1  # A 200 envelope could follow generation; never retry it automatically.
    assert "secret" not in caught.value.message


@pytest.mark.parametrize("retry_after", ["120", "Fri, 01 Jan 2100 00:00:00 GMT"])
async def test_long_retry_after_is_not_shortened_or_retried(retry_after):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(
            429, headers={"Retry-After": retry_after}, json={"error": {"message": "busy"}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).structured(
                Extraction, "Extract.", {}, budget()
            )
    assert caught.value.code == "provider_rate_limited" and len(calls) == 1


@pytest.mark.parametrize("value", [None, "invalid", "nan", "inf"])
def test_invalid_retry_after_uses_finite_default(value):
    assert retry_delay(value) == 5


async def test_transient_rate_limit_recovers_without_changing_model():
    calls = []

    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "busy"})
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        result = await LiveProvider(settings("openrouter"), client).structured(
            Extraction, "Extract.", {}, budget()
        )
    assert result.findings == []
    assert len(calls) == 2
    assert all(call["model"] == "test/extractor:free" for call in calls)
    assert all(
        call["provider"]["max_price"] == {"prompt": 0, "completion": 0, "request": 0}
        for call in calls
    )


@pytest.mark.parametrize("failure", ["timeout", "malformed", "usage"])
async def test_failed_structured_calls_are_recorded_without_untrusted_text(failure):
    entries = []

    def handle(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("secret timeout details", request=request)
        if failure == "usage":
            return httpx.Response(200, json={"usage": {"prompt_tokens": -1}})
        return httpx.Response(200, text="secret malformed response")

    allowance = budget()
    allowance.trace = entries.append
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(ProviderFailure) as caught:
            await LiveProvider(settings("openrouter"), client).structured(
                Extraction, "Extract.", {}, allowance
            )
    assert len(entries) == 1 and entries[0]["failure"] == caught.value.code
    assert entries[0]["output"] is None
    assert "secret" not in json.dumps(entries) + caught.value.message

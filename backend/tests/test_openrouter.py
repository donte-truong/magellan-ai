import json

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.providers import BudgetExceeded, Extraction, LiveProvider, ProviderFailure
from tests.test_providers import budget, response_data


def config(**overrides):
    values = {
        "_env_file": None,
        "research_provider": "live",
        "llm_provider": "openrouter",
        "tavily_api_key": "search-test",
        "openrouter_api_key": "router-test",
    }
    return Settings(**(values | overrides))


def test_openrouter_credentials_and_free_models_are_validated_independently():
    settings = config()
    assert not settings.openai_api_key.get_secret_value()
    assert settings.openrouter_model == "openrouter/free"
    for field in ["openrouter_model", "openrouter_verifier_model"]:
        with pytest.raises(ValidationError, match="must be openrouter/free"):
            config(**{field: "paid/model"})
    with pytest.raises(ValidationError, match="OPENROUTER_API_KEY"):
        config(openrouter_api_key="")
    with pytest.raises(ValidationError, match="TAVILY_API_KEY"):
        config(tavily_api_key="")
    with pytest.raises(ValidationError, match="OPENAI_API_KEY"):
        config(llm_provider="openai")
    # Fixture mode works without credentials for either model provider.
    Settings(_env_file=None, llm_provider="openrouter")


@pytest.mark.parametrize("verify", [False, True])
async def test_json_mode_includes_schema_and_defaults_verifier_to_main_model(verify):
    def handle(request):
        body = json.loads(request.content)
        assert body["model"] == "openrouter/free"
        assert body["response_format"] == {"type": "json_object"}
        assert '"additionalProperties": false' in body["messages"][0]["content"]
        assert "untrusted-document" not in body["messages"][0]["content"]
        assert json.loads(body["messages"][1]["content"]) == {"document": "untrusted-document"}
        assert body["max_tokens"] == 4000
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(config(openrouter_response_format="json_object"), client)
        allowance = budget()
        result = await provider.structured(
            Extraction,
            "Extract supported claims.",
            {"document": "untrusted-document"},
            allowance,
            verify=verify,
        )
    assert not result.findings
    assert allowance.usage["input_tokens"] == allowance.usage["output_tokens"] == 100


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"error": {"message": "sensitive provider details"}},
        {"choices": []},
        {"choices": [{"finish_reason": "length", "message": {"content": '{"findings":[]}'}}]},
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"refusal": "private", "content": '{"findings":[]}'},
                }
            ]
        },
        response_data({"made_up_schema": True}, "openrouter"),
        {"choices": [{"finish_reason": "stop", "message": {"content": "```json\n{}\n```"}}]},
        {"choices": [{"finish_reason": "stop", "message": {"content": None}}]},
        {"usage": {"prompt_tokens": -5, "completion_tokens": 1}},
    ],
)
async def test_openrouter_rejects_invalid_refused_or_truncated_outputs(payload):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    ) as client:
        provider = LiveProvider(config(), client)
        with pytest.raises(ProviderFailure) as caught:
            await provider.structured(Extraction, "Extract.", {}, budget())
    # Malformed or refused model text is classified separately from transport/usage failures.
    usage_only = "usage" in payload and "choices" not in payload
    expected = "source_unavailable" if usage_only else "model_output_invalid"
    assert caught.value.code == expected
    assert "private" not in caught.value.message and "sensitive" not in caught.value.message


@pytest.mark.parametrize("status", [401, 404, 429, 503])
async def test_openrouter_failures_do_not_fall_back_to_paid_models(status, monkeypatch):
    import app.providers as providers

    monkeypatch.setattr(providers, "RATE_LIMIT_WAIT_SECONDS", 0.0)
    monkeypatch.setattr(providers, "RATE_LIMIT_MAX_WAIT_SECONDS", 0.0)
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "private provider details"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(config(), client)
        with pytest.raises(ProviderFailure) as caught:
            await provider.structured(Extraction, "Extract.", {}, budget())
    # Only a 429 is retried (bounded, before any generation); nothing ever routes to a paid model.
    assert len(calls) == (1 + providers.RATE_LIMIT_RETRIES if status == 429 else 1)
    assert all(json.loads(c.content)["model"] == "openrouter/free" for c in calls)
    assert "private" not in caught.value.message


@pytest.mark.parametrize("limits", [{"max_input_tokens": 0}, {"max_output_tokens": 127}])
async def test_openrouter_honors_budget_before_contacting_provider(limits):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(BudgetExceeded):
            await LiveProvider(config(), client).structured(
                Extraction, "Extract.", {}, budget(**limits)
            )
    assert not calls


async def test_openrouter_missing_usage_retains_conservative_reservations():
    payload = response_data({"findings": []}, "openrouter")
    del payload["usage"]
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    ) as client:
        allowance = budget()
        await LiveProvider(config(), client).structured(Extraction, "Extract.", {}, allowance)
    assert allowance.usage["input_tokens"] > 2048
    assert allowance.usage["output_tokens"] == 4000


@pytest.mark.parametrize(
    "setting, expected",
    [("", None), ("off", {"enabled": False}), ("low", {"effort": "low", "exclude": True})],
)
async def test_reasoning_control_is_sent_only_when_configured(setting, expected):
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await LiveProvider(config(openrouter_reasoning=setting), client).structured(
            Extraction, "Extract.", {}, budget()
        )
    assert bodies[0].get("reasoning") == expected


async def test_reasoning_token_budget_takes_precedence_over_effort():
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await LiveProvider(
            config(openrouter_reasoning="low", openrouter_reasoning_max_tokens=512), client
        ).structured(Extraction, "Extract.", {}, budget())
    assert bodies[0]["reasoning"] == {"max_tokens": 512, "exclude": True}


async def test_reasoning_budgets_are_applied_per_role():
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(
            config(
                openrouter_reasoning_max_tokens=256, openrouter_reasoning_max_tokens_planner=2048
            ),
            client,
        )
        await provider.structured(Extraction, "x", {}, budget())
        await provider.structured(Extraction, "x", {}, budget(), role="planner")
    assert bodies[0]["reasoning"] == {"max_tokens": 256, "exclude": True}
    assert bodies[1]["reasoning"] == {"max_tokens": 2048, "exclude": True}


async def test_reasoning_effort_can_differ_per_role_for_mixed_model_runs():
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=response_data({"findings": []}, "openrouter"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = LiveProvider(
            config(openrouter_reasoning="off", openrouter_reasoning_verifier="low"), client
        )
        await provider.structured(Extraction, "x", {}, budget())
        await provider.structured(Extraction, "x", {}, budget(), role="verifier")
        await provider.structured(Extraction, "x", {}, budget(), role="planner")
    assert bodies[0]["reasoning"] == {"enabled": False}
    assert bodies[1]["reasoning"] == {"effort": "low", "exclude": True}
    assert bodies[2]["reasoning"] == {"enabled": False}

from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "production", "test"] = "development"
    database_url: str = "sqlite:///./magellan.db"
    # Provisioned token -> workspace mapping. Tokens never enter the database or logs.
    workspace_tokens: dict[str, str] = Field(default_factory=lambda: {"dev-token": "demo"})
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    research_provider: Literal["fixture", "live"] = "fixture"
    # Curated fixture depth: 1 reproduces the original three-component example; 2 adds the
    # BCM2712's parts so multi-hop chains and harvesting can be exercised without keys.
    fixture_depth: int = Field(default=1, ge=1, le=2)
    tavily_api_key: SecretStr = SecretStr("")
    llm_provider: Literal["openai", "openrouter"] = "openai"
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
    # Model roles: extraction (volume), verifier and planner (judgment). A missing planner
    # model falls back to the verifier model, which falls back to the extraction model.
    openai_verifier_model: str = ""
    openai_planner_model: str = ""
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_model: str = "openrouter/free"
    openrouter_verifier_model: str = ""
    openrouter_planner_model: str = ""
    openrouter_response_format: Literal["json_schema", "json_object"] = "json_schema"
    # Reasoning control for models that support OpenRouter's `reasoning` parameter: "" omits it,
    # "off" disables thinking, or an effort level (minimal/low/medium/high) with reasoning tokens
    # excluded from the response. Hidden reasoning otherwise competes with the JSON for max_tokens.
    openrouter_reasoning: Literal["", "off", "minimal", "low", "medium", "high"] = ""
    # Reasoning token budget for models whose thinking cannot be disabled (takes precedence
    # over the effort level). Hidden reasoning otherwise competes with the JSON for max_tokens.
    openrouter_reasoning_max_tokens: int | None = Field(default=None, ge=1, le=32000)
    # Per-role overrides: planning deserves thinking, extraction is literal quoting.
    openrouter_reasoning_max_tokens_planner: int | None = Field(default=None, ge=1, le=32000)
    openrouter_reasoning_max_tokens_verifier: int | None = Field(default=None, ge=1, le=32000)
    openrouter_reasoning_max_tokens_extraction: int | None = Field(default=None, ge=1, le=32000)
    # Hard wall-clock deadline per provider call; keep-alive bytes can defeat the read timeout.
    provider_call_deadline_seconds: int = Field(default=180, ge=10, le=900)
    # Documents analyzed concurrently within one research task.
    research_concurrency: int = Field(default=3, ge=1, le=8)
    # Pause a tier-1 branch after this many consecutive tasks without a verified finding (0 = never).
    branch_stagnation_tasks: int = Field(default=2, ge=0, le=10)
    # Model-assisted entity resolution for paraphrase duplicates the deterministic rules cannot
    # see: "merge" records a model-resolved alias (entity.merged), "flag" only emits
    # entity.review_needed, "off" skips the call. Identifier conflicts are never overridden.
    model_resolution: Literal["merge", "flag", "off"] = "merge"
    provider_timeout_seconds: float = Field(default=30, gt=0, le=60)
    worker_slots: int = Field(default=3, ge=1, le=16)
    worker_poll_seconds: float = Field(default=0.5, gt=0, le=30)
    worker_lease_seconds: int = Field(default=120, ge=90)
    embedded_worker: bool = True
    auto_create_schema: bool = True
    event_retention: int = Field(default=5000, ge=10)
    production_data_path: str | None = None
    # Operator-provided billing estimates; never assume that unavailable prices are zero.
    input_token_cost_per_million_minor: float | None = Field(default=None, ge=0)
    output_token_cost_per_million_minor: float | None = Field(default=None, ge=0)
    search_cost_minor: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_deployment(self):
        if not self.workspace_tokens or any(
            not k or not v for k, v in self.workspace_tokens.items()
        ):
            raise ValueError("Configure nonempty workspace tokens and workspace names")
        if self.environment == "production":
            if "dev-token" in self.workspace_tokens:
                raise ValueError("Production requires explicitly provisioned workspace tokens")
            if self.auto_create_schema or self.embedded_worker:
                raise ValueError("Production requires migrations and a separate worker")
        if self.research_provider == "live":
            if not self.tavily_api_key.get_secret_value().strip():
                raise ValueError("Live research requires TAVILY_API_KEY")
            if self.llm_provider == "openai":
                if (
                    not self.openai_api_key.get_secret_value().strip()
                    or not self.openai_model.strip()
                ):
                    raise ValueError("OpenAI research requires OPENAI_API_KEY and OPENAI_MODEL")
            else:
                if not self.openrouter_api_key.get_secret_value().strip():
                    raise ValueError("OpenRouter research requires OPENROUTER_API_KEY")
                for name, model in [
                    ("OPENROUTER_MODEL", self.openrouter_model),
                    (
                        "OPENROUTER_VERIFIER_MODEL",
                        self.openrouter_verifier_model or self.openrouter_model,
                    ),
                    (
                        "OPENROUTER_PLANNER_MODEL",
                        self.openrouter_planner_model
                        or self.openrouter_verifier_model
                        or self.openrouter_model,
                    ),
                ]:
                    free = model == "openrouter/free" or ("/" in model and model.endswith(":free"))
                    # Paid vendor/model IDs are allowed only with explicit billing ceilings, which
                    # become the router's max_price; automatic openrouter/* routers stay free-only.
                    paid = (
                        self.openrouter_paid_allowed
                        and "/" in model
                        and not model.startswith("openrouter/")
                    )
                    if not (free or paid):
                        raise ValueError(
                            f"{name} must be openrouter/free or a model ID ending in :free; a paid "
                            "vendor/model ID additionally requires INPUT_TOKEN_COST_PER_MILLION_MINOR "
                            "and OUTPUT_TOKEN_COST_PER_MILLION_MINOR"
                        )
        return self

    def reasoning_budget_for(self, role):
        return {
            "planner": self.openrouter_reasoning_max_tokens_planner,
            "verifier": self.openrouter_reasoning_max_tokens_verifier,
            "extraction": self.openrouter_reasoning_max_tokens_extraction,
        }.get(role) or self.openrouter_reasoning_max_tokens

    def model_for(self, role):
        """Resolve the configured model ID for a role on the active model provider."""
        if self.llm_provider == "openrouter":
            base, verifier, planner = (
                self.openrouter_model,
                self.openrouter_verifier_model,
                self.openrouter_planner_model,
            )
        else:
            base, verifier, planner = (
                self.openai_model,
                self.openai_verifier_model,
                self.openai_planner_model,
            )
        verifier = verifier or base
        return {"extraction": base, "verifier": verifier, "planner": planner or verifier}[role]

    @property
    def openrouter_paid_allowed(self):
        return (
            self.input_token_cost_per_million_minor is not None
            and self.output_token_cost_per_million_minor is not None
        )

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
    tavily_api_key: SecretStr = SecretStr("")
    llm_provider: Literal["openai", "openrouter"] = "openai"
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_model: str = "openrouter/free"
    openrouter_verifier_model: str = ""
    openrouter_response_format: Literal["json_schema", "json_object"] = "json_schema"
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

    @property
    def openrouter_paid_allowed(self):
        return (
            self.input_token_cost_per_million_minor is not None
            and self.output_token_cost_per_million_minor is not None
        )

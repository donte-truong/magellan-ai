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
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
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
        if self.research_provider == "live" and not (
            self.tavily_api_key.get_secret_value()
            and self.openai_api_key.get_secret_value()
            and self.openai_model
        ):
            raise ValueError("Live research requires TAVILY_API_KEY, OPENAI_API_KEY, OPENAI_MODEL")
        return self

from functools import lru_cache
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # App
    app_name: str = Field(default="webagent-backend", alias="APP_NAME")
    env: str = Field(default="development", alias="ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=8000, alias="PORT")

    # CORS
    cors_origins: List[str] = Field(default_factory=lambda: ["http://localhost:5173"], alias="CORS_ORIGINS")

    # LLM
    openai_api_key: Optional[str] = Field(default=None, alias="OPENAI_API_KEY")
    openai_model: str = Field(default="nemotron-30b", alias="OPENAI_MODEL")
    openai_base_url: Optional[str] = Field(default="http://inference.sprit3dan-labs.net/nemotron-30b/v1/", alias="OPENAI_BASE_URL")

    # Auth / multitenancy
    jwt_secret: str = Field(default="change-me", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    require_auth: bool = Field(default=False, alias="REQUIRE_AUTH")

    # Web Push (VAPID)
    web_push_enabled: bool = Field(default=False, alias="WEB_PUSH_ENABLED")
    web_push_vapid_public_key: Optional[str] = Field(default=None, alias="WEB_PUSH_VAPID_PUBLIC_KEY")
    web_push_vapid_private_key: Optional[str] = Field(default=None, alias="WEB_PUSH_VAPID_PRIVATE_KEY")
    web_push_vapid_subject: Optional[str] = Field(default="mailto:admin@example.com", alias="WEB_PUSH_VAPID_SUBJECT")

    # Agent behavior

    max_tool_rounds: int = Field(default=1, alias="MAX_TOOL_ROUNDS")
    request_timeout_seconds: int = Field(default=60, alias="REQUEST_TIMEOUT_SECONDS")
    compaction_trigger_total_tokens: int = Field(default=64_000, alias="COMPACTION_TRIGGER_TOTAL_TOKENS")
    compaction_target_total_tokens: int = Field(default=24_000, alias="COMPACTION_TARGET_TOTAL_TOKENS")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value):
        if value is None:
            return ["http://localhost:5173"]
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        if isinstance(value, list):
            return value
        raise ValueError("CORS_ORIGINS must be a comma-separated string or list")

    @field_validator("env")
    @classmethod
    def normalize_env(cls, value: str) -> str:
        return value.strip().lower()

    @property
    def is_dev(self) -> bool:
        return self.env in {"dev", "development", "local"}

    @property
    def is_prod(self) -> bool:
        return self.env in {"prod", "production"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
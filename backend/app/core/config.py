from functools import lru_cache
from typing import List, Optional

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),
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
    openai_base_url: Optional[str] = Field(default=None, alias="OPENAI_BASE_URL")

    # Auth / multitenancy
    jwt_secret: str = Field(default="change-me", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    require_auth: bool = Field(default=False, alias="REQUIRE_AUTH")

    # Web Push (VAPID)
    web_push_enabled: bool = Field(default=False, alias="WEB_PUSH_ENABLED")
    web_push_vapid_public_key: Optional[str] = Field(default=None, alias="WEB_PUSH_VAPID_PUBLIC_KEY")
    web_push_vapid_private_key: Optional[str] = Field(default=None, alias="WEB_PUSH_VAPID_PRIVATE_KEY")
    web_push_vapid_subject: Optional[str] = Field(default="mailto:admin@example.com", alias="WEB_PUSH_VAPID_SUBJECT")

    # A2A (Agent-to-Agent delegation)
    a2a_enabled: bool = Field(default=False, alias="A2A_ENABLED")
    a2a_agent_id: Optional[str] = Field(default="webagent", alias="A2A_AGENT_ID")
    a2a_transport_backend: str = Field(default="nats", alias="A2A_TRANSPORT_BACKEND")
    a2a_discovery_base_url: Optional[str] = Field(default="http://a2a-discovery:8080", alias="A2A_DISCOVERY_BASE_URL")
    a2a_require_auth: bool = Field(default=False, alias="A2A_REQUIRE_AUTH")
    a2a_shared_secret: Optional[str] = Field(default="change-me-a2a-secret", alias="A2A_SHARED_SECRET")
    a2a_clock_skew_seconds: int = Field(default=30, alias="A2A_CLOCK_SKEW_SECONDS")
    a2a_nonce_ttl_seconds: int = Field(default=300, alias="A2A_NONCE_TTL_SECONDS")
    # NATS JetStream transport
    a2a_nats_url: Optional[str] = Field(default="nats://localhost:4222", alias="A2A_NATS_URL")
    a2a_stream_name: str = Field(default="a2a", alias="A2A_STREAM_NAME")
    a2a_subject_prefix: str = Field(default="a2a", alias="A2A_SUBJECT_PREFIX")
    a2a_consumer_name: str = Field(default="webagent", alias="A2A_CONSUMER_NAME")
    a2a_inbound_agent_pattern: str = Field(default="", alias="A2A_INBOUND_AGENT_PATTERN")
    a2a_max_deliver: int = Field(default=5, alias="A2A_MAX_DELIVER")
    a2a_ack_wait_seconds: int = Field(default=30, alias="A2A_ACK_WAIT_SECONDS")
    a2a_execution_timeout_seconds: int = Field(default=120, alias="A2A_EXECUTION_TIMEOUT_SECONDS")

    # Agent behavior

    max_tool_rounds: int = Field(default=1, alias="MAX_TOOL_ROUNDS")
    request_timeout_seconds: int = Field(default=60, alias="REQUEST_TIMEOUT_SECONDS")
    compaction_trigger_total_tokens: int = Field(default=64_000, alias="COMPACTION_TRIGGER_TOTAL_TOKENS")
    compaction_target_total_tokens: int = Field(default=24_000, alias="COMPACTION_TARGET_TOTAL_TOKENS")

    @model_validator(mode="after")
    def validate_a2a_settings(self) -> "Settings":
        if not self.a2a_agent_id:
            self.a2a_agent_id = "webagent"
        if not self.a2a_inbound_agent_pattern:
            self.a2a_inbound_agent_pattern = str(self.a2a_agent_id)
        if not self.a2a_discovery_base_url:
            self.a2a_discovery_base_url = "http://a2a-discovery:8080"
        if not self.a2a_shared_secret:
            self.a2a_shared_secret = "change-me-a2a-secret"
        return self

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
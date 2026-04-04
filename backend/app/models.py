from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_ID_LEN = 128
MAX_TEXT_LEN = 100_000
MAX_REASONING_LEN = 100_000
MAX_MESSAGES = 500
MAX_TOOL_CALLS = 100


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ToolFunction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_ID_LEN)
    arguments: str = Field(default="{}", max_length=MAX_TEXT_LEN)


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=MAX_ID_LEN)
    type: Literal["function"] = "function"
    function: ToolFunction


class ToolDefinitionFunction(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1, max_length=MAX_ID_LEN)
    description: str | None = Field(default=None, max_length=2_000)
    parameters: dict[str, Any] | None = None


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["function"] = "function"
    function: ToolDefinitionFunction


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(default="", max_length=MAX_TEXT_LEN)
    name: str | None = Field(default=None, min_length=1, max_length=MAX_ID_LEN)
    tool_call_id: str | None = Field(default=None, min_length=1, max_length=MAX_ID_LEN)
    tool_calls: list[ToolCall] | None = Field(default=None, max_length=MAX_TOOL_CALLS)
    reasoning: str | None = Field(default=None, max_length=MAX_REASONING_LEN)
    timestamp: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def validate_role_fields(self) -> "ChatMessage":
        if self.role == "tool" and not self.tool_call_id:
            raise ValueError("tool messages must include tool_call_id")
        if self.role == "assistant" and self.tool_calls is not None and len(self.tool_calls) == 0:
            raise ValueError("tool_calls cannot be empty")
        return self


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    tenant_id: str = Field(alias="tenantId", min_length=1, max_length=MAX_ID_LEN)
    user_id: str = Field(alias="userId", min_length=1, max_length=MAX_ID_LEN)
    agent_id: str = Field(alias="agentId", min_length=1, max_length=MAX_ID_LEN)
    session_id: str = Field(alias="sessionId", min_length=1, max_length=MAX_ID_LEN)

    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    model: str | None = Field(default=None, min_length=1, max_length=256)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, alias="maxTokens", ge=1)
    stream: bool = True
    tools: list[ToolDefinition] | None = Field(default=None, max_length=MAX_TOOL_CALLS)
    metadata: dict[str, Any] | None = None

    @field_validator("tenant_id", "user_id", "agent_id", "session_id")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")
        if any(ch not in allowed for ch in value):
            raise ValueError("identifier contains invalid characters")
        return value


class TokenUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_tokens: int = Field(alias="inputTokens", ge=0)
    output_tokens: int = Field(alias="outputTokens", ge=0)
    total_tokens: int = Field(alias="totalTokens", ge=0)


class ToolEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    tool_call_id: str = Field(alias="toolCallId", min_length=1, max_length=MAX_ID_LEN)
    name: str = Field(min_length=1, max_length=MAX_ID_LEN)
    ok: bool
    result: Any | None = None
    error: str | None = None
    content: str
    duration_ms: int = Field(alias="durationMs", ge=0)


class CompactionReport(BaseModel):
    model_config = ConfigDict(extra="allow")

    triggered: bool = False
    strategy: str = "none"
    threshold_tokens: int = Field(alias="thresholdTokens", ge=0)
    target_tokens: int = Field(alias="targetTokens", ge=0)
    estimated_tokens_before: int = Field(alias="estimatedTokensBefore", ge=0)
    estimated_tokens_after: int = Field(alias="estimatedTokensAfter", ge=0)
    dropped_messages: int = Field(alias="droppedMessages", ge=0)
    summary: str | None = None


class AgentResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    request_id: str = Field(alias="requestId", min_length=1)
    id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    created_at: datetime = Field(alias="createdAt")
    message: ChatMessage
    usage: TokenUsage | None = None
    generated_messages: list[ChatMessage] = Field(alias="generatedMessages", default_factory=list)
    tool_events: list[ToolEvent] = Field(alias="toolEvents", default_factory=list)
    compaction: CompactionReport | None = None


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    request_id: str = Field(alias="requestId", min_length=1)
    error: str
    details: list[dict[str, Any]] | None = None
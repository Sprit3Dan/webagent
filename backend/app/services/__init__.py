"""Backend services package exports."""

from .llm_client import (
    get_async_openai_client,
    get_openai_client,
    resolve_model,
)
from .tools import (
    execute_tool_call,
    execute_tool_calls,
    list_tool_definitions,
    register_builtin_tools,
    register_tool,
    to_tool_message,
)
from .compaction import (
    CompactionResult,
    compact_session_messages,
)

__all__ = [
    "get_async_openai_client",
    "get_openai_client",
    "resolve_model",
    "execute_tool_call",
    "execute_tool_calls",
    "list_tool_definitions",
    "register_builtin_tools",
    "register_tool",
    "to_tool_message",
    "CompactionResult",
    "compact_session_messages",
]
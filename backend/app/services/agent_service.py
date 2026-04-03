from __future__ import annotations

from typing import Any, Iterable

from ..models import ChatMessage


def _message_to_dict(message: ChatMessage | dict[str, Any]) -> dict[str, Any]:
    if isinstance(message, ChatMessage):
        return message.model_dump(exclude_none=True)
    if isinstance(message, dict):
        return dict(message)
    raise TypeError("message must be ChatMessage or dict")


def to_openai_message(message: ChatMessage | dict[str, Any]) -> dict[str, Any]:
    """
    Convert one internal message into OpenAI Chat Completions format.

    Keeps only fields accepted by OpenAI chat messages:
    - role
    - content
    - name
    - tool_call_id
    - tool_calls
    """
    raw = _message_to_dict(message)

    out: dict[str, Any] = {
        "role": raw.get("role"),
        "content": raw.get("content", ""),
    }

    if raw.get("name"):
        out["name"] = raw["name"]

    if raw.get("tool_call_id"):
        out["tool_call_id"] = raw["tool_call_id"]

    tool_calls = raw.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        normalized_calls: list[dict[str, Any]] = []
        for call in tool_calls:
            if hasattr(call, "model_dump"):
                normalized_calls.append(call.model_dump(exclude_none=True))
            elif isinstance(call, dict):
                normalized_calls.append(dict(call))
        if normalized_calls:
            out["tool_calls"] = normalized_calls

    return out


def to_openai_messages(
    messages: Iterable[ChatMessage | dict[str, Any]],
    *,
    max_messages: int | None = None,
) -> list[dict[str, Any]]:
    """
    Convert a message sequence into OpenAI Chat Completions format.

    Args:
        messages: Internal messages (Pydantic models or dicts).
        max_messages: Optional tail window size to limit prompt length.

    Returns:
        List of OpenAI-compatible message dicts.
    """
    materialized = list(messages)
    if max_messages is not None and max_messages > 0:
        materialized = materialized[-max_messages:]

    return [to_openai_message(m) for m in materialized]
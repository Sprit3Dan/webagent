from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Sequence

from ..models import ChatMessage


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_message(msg: ChatMessage | dict[str, Any]) -> ChatMessage:
    if isinstance(msg, ChatMessage):
        return msg
    return ChatMessage.model_validate(msg)


def _message_to_dict(msg: ChatMessage) -> dict[str, Any]:
    return msg.model_dump(exclude_none=True)


def _first_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        iv = int(value)
        return iv if iv >= 0 else None
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return int(text)
    return None


def _extract_from_mapping(data: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _first_int(data.get(key))
        if value is not None:
            return value
    return None


def _extract_observed_prompt_tokens(
    messages: list[ChatMessage],
    observed_prompt_tokens: int | None = None,
) -> int | None:
    """
    Resolve prompt token count from observed model output only.

    Priority:
    1) explicit arg
    2) newest message extras/metadata with common token keys
    """
    direct = _first_int(observed_prompt_tokens)
    if direct is not None:
        return direct

    token_keys = (
        "promptTokens",
        "prompt_tokens",
        "inputTokens",
        "input_tokens",
        "observedPromptTokens",
        "observed_prompt_tokens",
    )

    for msg in reversed(messages):
        raw = _message_to_dict(msg)

        from_root = _extract_from_mapping(raw, token_keys)
        if from_root is not None:
            return from_root

        usage = raw.get("usage")
        if isinstance(usage, dict):
            from_usage = _extract_from_mapping(usage, token_keys)
            if from_usage is not None:
                return from_usage

        metadata = raw.get("metadata")
        if isinstance(metadata, dict):
            from_meta = _extract_from_mapping(metadata, token_keys)
            if from_meta is not None:
                return from_meta

    return None


def _has_declared_tool_call(message: ChatMessage, tool_call_id: str) -> bool:
    if message.role != "assistant" or not message.tool_calls:
        return False
    return any(tc.id == tool_call_id for tc in message.tool_calls)


def _align_legal_tool_boundary(messages: list[ChatMessage]) -> list[ChatMessage]:
    """
    Drop leading orphan tool messages (tool_call_id not declared in visible slice).
    """
    if not messages:
        return messages

    declared: set[str] = set()
    start = 0

    for i, msg in enumerate(messages):
        if msg.role == "assistant" and msg.tool_calls:
            for tc in msg.tool_calls:
                declared.add(tc.id)
            continue

        if msg.role == "tool" and msg.tool_call_id and msg.tool_call_id not in declared:
            start = i + 1
            declared.clear()
            for prev in messages[start : i + 1]:
                if prev.role == "assistant" and prev.tool_calls:
                    for tc in prev.tool_calls:
                        declared.add(tc.id)

    return messages[start:]


def _excerpt(text: str, max_len: int = 180) -> str:
    clean = " ".join((text or "").split())
    if len(clean) <= max_len:
        return clean
    return clean[: max_len - 1] + "…"


def _build_summary(dropped: list[ChatMessage], max_items: int = 24) -> str:
    if not dropped:
        return ""

    lines: list[str] = [
        "Session was compacted using observed prompt-token budget.",
        "Compressed earlier context:",
    ]
    shown = 0

    for msg in dropped:
        if msg.role not in {"user", "assistant", "tool", "system"}:
            continue
        if shown >= max_items:
            break
        content = _excerpt(msg.content or "")
        if msg.role == "tool" and msg.name:
            lines.append(f"- tool[{msg.name}]: {content}")
        else:
            lines.append(f"- {msg.role}: {content}")
        shown += 1

    remaining = len(dropped) - shown
    if remaining > 0:
        lines.append(f"- … and {remaining} more earlier messages.")

    return "\n".join(lines).strip()


def _project_tokens_by_count(
    observed_prompt_tokens: int,
    original_count: int,
    new_count: int,
) -> int:
    if original_count <= 0:
        return 0
    ratio = max(0.0, min(1.0, new_count / original_count))
    return int(round(observed_prompt_tokens * ratio))


@dataclass(slots=True)
class CompactionResult:
    messages: list[ChatMessage]
    report: dict[str, Any]


def compact_session_messages(
    messages: Sequence[ChatMessage | dict[str, Any]],
    *,
    observed_prompt_tokens: int | None = None,
    trigger_tokens: int = 64_000,
    target_tokens: int = 24_000,
    min_tail_messages: int = 24,
) -> CompactionResult:
    """
    Compaction strategy based on observed model prompt tokens.

    Key policy:
    - Never estimate via local tokenizer heuristics.
    - Compact only when observed prompt tokens exceed trigger_tokens.
    - Preserve system messages + recent tail, drop oldest non-system first.
    - Add a synthetic system summary for dropped history.
    """
    normalized = [_normalize_message(m) for m in messages]
    observed = _extract_observed_prompt_tokens(normalized, observed_prompt_tokens)

    if observed is None:
        return CompactionResult(
            messages=normalized,
            report={
                "triggered": False,
                "strategy": "observed-unavailable",
                "thresholdTokens": int(trigger_tokens),
                "targetTokens": int(target_tokens),
                "estimatedTokensBefore": 0,
                "estimatedTokensAfter": 0,
                "droppedMessages": 0,
                "summary": None,
            },
        )

    if observed <= trigger_tokens:
        return CompactionResult(
            messages=normalized,
            report={
                "triggered": False,
                "strategy": "none",
                "thresholdTokens": int(trigger_tokens),
                "targetTokens": int(target_tokens),
                "estimatedTokensBefore": int(observed),
                "estimatedTokensAfter": int(observed),
                "droppedMessages": 0,
                "summary": None,
            },
        )

    system_msgs = [m for m in normalized if m.role == "system"]
    non_system = [m for m in normalized if m.role != "system"]

    tail_count = max(1, min_tail_messages)
    tail = non_system[-tail_count:] if len(non_system) > tail_count else list(non_system)
    head = non_system[: max(0, len(non_system) - len(tail))]

    original_count = max(1, len(normalized))
    dropped: list[ChatMessage] = []

    def build_kept() -> list[ChatMessage]:
        return list(system_msgs) + list(head) + list(tail)

    kept = build_kept()

    while _project_tokens_by_count(observed, original_count, len(kept)) > target_tokens and head:
        dropped.append(head.pop(0))
        kept = build_kept()

    summary_text = _build_summary(dropped)
    if dropped and summary_text:
        summary_msg = ChatMessage(
            role="system",
            content=summary_text,
            timestamp=_utc_now(),
        )
        kept = list(system_msgs) + [summary_msg] + list(head) + list(tail)

    prefix_system = [m for m in kept if m.role == "system"]
    suffix_non_system = [m for m in kept if m.role != "system"]
    suffix_non_system = _align_legal_tool_boundary(suffix_non_system)
    compacted = prefix_system + suffix_non_system

    projected_after = _project_tokens_by_count(observed, original_count, len(compacted))

    return CompactionResult(
        messages=compacted,
        report={
            "triggered": True,
            "strategy": "observed-summary+truncate",
            "thresholdTokens": int(trigger_tokens),
            "targetTokens": int(target_tokens),
            "estimatedTokensBefore": int(observed),
            "estimatedTokensAfter": int(projected_after),
            "droppedMessages": int(len(dropped)),
            "summary": summary_text or None,
        },
    )
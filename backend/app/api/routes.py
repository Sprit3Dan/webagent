from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError

from ..core.config import Settings, get_settings
from ..core.security import build_auth_context, enforce_tenant_match
from ..models import AgentRequest, ChatMessage
from ..services.agent_service import to_openai_messages
from ..services.compaction import compact_session_messages
from ..services.llm_client import get_async_openai_client, resolve_model
from ..services.tools import execute_tool_calls, list_tool_definitions, to_tool_message

router = APIRouter(tags=["agent"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts).strip()
    return str(value)


def _tool_call_to_dict(call: Any) -> dict[str, Any]:
    if hasattr(call, "model_dump"):
        raw = call.model_dump(exclude_none=True)
    elif isinstance(call, dict):
        raw = dict(call)
    else:
        raw = {}

    fn = raw.get("function") or {}
    return {
        "id": str(raw.get("id") or ""),
        "type": "function",
        "function": {
            "name": str(fn.get("name") or ""),
            "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str) else json.dumps(fn or {}),
        },
    }


def _extract_reasoning(message_obj: Any) -> str | None:
    reasoning = getattr(message_obj, "reasoning", None)
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning.strip()

    # Some providers attach extra fields in model_extra / additional kwargs.
    model_extra = getattr(message_obj, "model_extra", None)
    if isinstance(model_extra, dict):
        candidate = model_extra.get("reasoning")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

    return None


def _merge_tools(
    request_tools: list[Any] | None,
    builtin_tools: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    for tool in builtin_tools:
        name = ((tool or {}).get("function") or {}).get("name")
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            merged.append(tool)

    for tool in request_tools or []:
        if hasattr(tool, "model_dump"):
            tool_dict = tool.model_dump(exclude_none=True)
        else:
            tool_dict = dict(tool)
        name = ((tool_dict or {}).get("function") or {}).get("name")
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            merged.append(tool_dict)

    return merged


@router.get("/health")
async def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "timestamp": _iso_now(),
    }


@router.get("/tools")
async def tools() -> dict[str, Any]:
    return {"tools": list_tool_definitions()}


@router.post("/agent/respond")
async def agent_respond(
    payload: AgentRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    request_id = str(uuid4())

    auth = build_auth_context(
        request,
        require_tenant=False,
        require_user=False,
        require_auth=settings.require_auth,
        allow_header_fallback=True,
        jwt_secret=settings.jwt_secret,
        jwt_algorithm=settings.jwt_algorithm,
    )

    enforce_tenant_match(auth, payload.tenant_id)
    if auth.user_id and auth.user_id != payload.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User scope mismatch",
        )

    model_name = resolve_model(payload.model, settings)
    client = get_async_openai_client(settings)

    working_messages: list[ChatMessage] = list(payload.messages)
    generated_messages: list[ChatMessage] = []
    tool_events: list[dict[str, Any]] = []
    usage: dict[str, int] | None = None
    final_assistant: ChatMessage | None = None

    compaction_report: dict[str, Any] = {
        "triggered": False,
        "strategy": "observed-pending",
        "thresholdTokens": int(settings.compaction_trigger_total_tokens),
        "targetTokens": int(settings.compaction_target_total_tokens),
        "estimatedTokensBefore": 0,
        "estimatedTokensAfter": 0,
        "droppedMessages": 0,
        "summary": None,
    }
    compaction_restarted = False

    merged_tools = _merge_tools(payload.tools, list_tool_definitions())

    for round_idx in range(settings.max_tool_rounds + 1):
        call_input_messages = list(working_messages)
        openai_messages = to_openai_messages(
            working_messages,
            max_messages=settings.max_context_messages,
        )

        kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": openai_messages,
        }
        if payload.temperature is not None:
            kwargs["temperature"] = payload.temperature
        if payload.max_tokens is not None:
            kwargs["max_tokens"] = payload.max_tokens
        if merged_tools:
            kwargs["tools"] = merged_tools
            kwargs["tool_choice"] = "auto"

        completion = await client.chat.completions.create(**kwargs)
        if not completion.choices:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="LLM returned no choices",
            )

        message_obj = completion.choices[0].message
        assistant_tool_calls = [
            _tool_call_to_dict(call)
            for call in (getattr(message_obj, "tool_calls", None) or [])
        ]

        try:
            assistant_msg = ChatMessage.model_validate(
                {
                    "role": "assistant",
                    "content": _safe_content(getattr(message_obj, "content", "")),
                    "tool_calls": assistant_tool_calls or None,
                    "reasoning": _extract_reasoning(message_obj),
                    "timestamp": datetime.now(timezone.utc),
                }
            )
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Invalid assistant message from LLM: {exc}",
            ) from exc

        working_messages.append(assistant_msg)
        generated_messages.append(assistant_msg)
        final_assistant = assistant_msg

        prompt_tokens = getattr(getattr(completion, "usage", None), "prompt_tokens", 0) or 0
        completion_tokens = getattr(getattr(completion, "usage", None), "completion_tokens", 0) or 0
        usage = {
            "inputTokens": int(prompt_tokens),
            "outputTokens": int(completion_tokens),
            "totalTokens": int(prompt_tokens) + int(completion_tokens),
        }

        if round_idx == 0 and not compaction_restarted:
            compaction_report["estimatedTokensBefore"] = int(prompt_tokens)
            compaction_report["estimatedTokensAfter"] = int(prompt_tokens)
            compaction_report["strategy"] = "none"

        if (
            round_idx == 0
            and not compaction_restarted
            and int(prompt_tokens) > int(settings.compaction_trigger_total_tokens)
        ):
            compaction_result = compact_session_messages(
                call_input_messages,
                observed_prompt_tokens=int(prompt_tokens),
                trigger_tokens=settings.compaction_trigger_total_tokens,
                target_tokens=settings.compaction_target_total_tokens,
            )
            compaction_report = compaction_result.report
            if compaction_result.report.get("triggered"):
                working_messages = compaction_result.messages
                generated_messages = []
                tool_events = []
                usage = None
                final_assistant = None
                compaction_restarted = True
                continue

        if not assistant_tool_calls or round_idx >= settings.max_tool_rounds:
            break

        execution_context = {
            "tenantId": payload.tenant_id,
            "userId": payload.user_id,
            "agentId": payload.agent_id,
            "sessionId": payload.session_id,
            "metadata": payload.metadata or {},
        }

        results = await execute_tool_calls(assistant_tool_calls, context=execution_context)

        for result in results:
            tool_events.append(result)
            tool_msg_dict = to_tool_message(result)
            tool_msg = ChatMessage.model_validate(tool_msg_dict)
            working_messages.append(tool_msg)
            generated_messages.append(tool_msg)

    if final_assistant is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent execution produced no assistant message",
        )

    return {
        "requestId": request_id,
        "id": str(uuid4()),
        "model": model_name,
        "createdAt": _iso_now(),
        "message": final_assistant.model_dump(by_alias=True, mode="json", exclude_none=True),
        "usage": usage,
        "generatedMessages": [
            msg.model_dump(by_alias=True, mode="json", exclude_none=True) for msg in generated_messages
        ],
        "toolEvents": tool_events,
        "compaction": compaction_report,
    }
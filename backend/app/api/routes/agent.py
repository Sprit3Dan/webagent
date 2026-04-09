from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ...core.config import Settings, get_settings
from ...core.security import build_auth_context, enforce_tenant_match
from ...models import AgentRequest, ChatMessage
from ...services.agent_service import to_openai_messages
from ...services.llm_client import get_async_openai_client, resolve_model
from ...services.orchestrator import run_local_agent

router = APIRouter(tags=["agent"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sse_event(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _metadata_openai_base_url(payload: AgentRequest) -> str | None:
    metadata = payload.metadata if isinstance(payload.metadata, dict) else {}
    llm_provider = metadata.get("llmProvider")
    if not isinstance(llm_provider, dict):
        return None
    base_url = llm_provider.get("baseUrl")
    if not isinstance(base_url, str):
        return None
    cleaned = base_url.strip()
    return cleaned or None


def _merge_tool_call_deltas(
    existing_calls: list[dict[str, Any]] | None,
    delta_calls: list[Any] | None,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = [dict(item) for item in (existing_calls or [])]

    for idx, delta_call in enumerate(delta_calls or []):
        if hasattr(delta_call, "model_dump"):
            raw = delta_call.model_dump(exclude_none=True)
        elif isinstance(delta_call, dict):
            raw = dict(delta_call)
        else:
            raw = {}

        while len(merged) <= idx:
            merged.append({"id": "", "type": "function", "function": {"name": "", "arguments": ""}})

        current = merged[idx]
        if not isinstance(current, dict):
            current = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}

        if raw.get("id"):
            current["id"] = str(raw.get("id") or "")

        current["type"] = "function"

        fn_raw = raw.get("function")
        if not isinstance(fn_raw, dict):
            fn_raw = {}

        fn_current = current.get("function")
        if not isinstance(fn_current, dict):
            fn_current = {}

        name = fn_raw.get("name")
        if isinstance(name, str) and name:
            fn_current["name"] = name

        args_piece = fn_raw.get("arguments")
        if isinstance(args_piece, str):
            prev_args = fn_current.get("arguments")
            if isinstance(prev_args, str):
                fn_current["arguments"] = prev_args + args_piece
            else:
                fn_current["arguments"] = args_piece

        current["function"] = fn_current
        merged[idx] = current

    normalized: list[dict[str, Any]] = []
    for call in merged:
        fn_any = call.get("function")
        fn: dict[str, Any] = fn_any if isinstance(fn_any, dict) else {}
        name_value = fn.get("name")
        args_value = fn.get("arguments")
        normalized.append({
            "id": str(call.get("id") or ""),
            "type": "function",
            "function": {
                "name": str(name_value) if isinstance(name_value, str) else "",
                "arguments": args_value if isinstance(args_value, str) else "",
            },
        })

    return normalized


@router.post("/agent/respond")
async def agent_respond(
    payload: AgentRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return await run_local_agent(payload, request, settings)


@router.post("/agent/respond/sse")
async def agent_respond_sse(
    payload: AgentRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
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
    request_base_url = _metadata_openai_base_url(payload)
    client = get_async_openai_client(settings, openai_base_url_override=request_base_url)

    openai_messages = to_openai_messages(list(payload.messages))

    merged_tools = [
        tool.model_dump(exclude_none=True) if hasattr(tool, "model_dump") else dict(tool)
        for tool in (payload.tools or [])
    ]

    kwargs: dict[str, Any] = {
        "model": model_name,
        "messages": openai_messages,
        "stream": True,
    }
    if payload.temperature is not None:
        kwargs["temperature"] = payload.temperature
    if payload.max_tokens is not None:
        kwargs["max_tokens"] = payload.max_tokens
    if merged_tools:
        kwargs["tools"] = merged_tools
        kwargs["tool_choice"] = "auto"
    kwargs["stream_options"] = {"include_usage": True}

    async def event_stream():
        assistant_content_parts: list[str] = []
        assistant_reasoning_parts: list[str] = []
        assistant_tool_calls: list[dict[str, Any]] = []
        usage: dict[str, int] | None = None

        yield _sse_event(
            "meta",
            {
                "requestId": request_id,
                "id": str(uuid4()),
                "model": model_name,
                "createdAt": _iso_now(),
            },
        )

        try:
            stream = await client.chat.completions.create(**kwargs)

            async for chunk in stream:
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    prompt_tokens = getattr(chunk_usage, "prompt_tokens", 0) or 0
                    completion_tokens = getattr(chunk_usage, "completion_tokens", 0) or 0
                    usage = {
                        "inputTokens": int(prompt_tokens),
                        "outputTokens": int(completion_tokens),
                        "totalTokens": int(prompt_tokens) + int(completion_tokens),
                    }

                choices = getattr(chunk, "choices", None) or []
                if not choices:
                    continue

                delta = getattr(choices[0], "delta", None)
                if delta is None:
                    continue

                delta_content = getattr(delta, "content", None)
                if isinstance(delta_content, str) and delta_content:
                    assistant_content_parts.append(delta_content)
                    yield _sse_event("delta", {"type": "content", "text": delta_content})
                elif isinstance(delta_content, list):
                    text_parts: list[str] = []
                    for part in delta_content:
                        if isinstance(part, str):
                            text_parts.append(part)
                        elif isinstance(part, dict):
                            text_val = part.get("text")
                            if isinstance(text_val, str) and text_val:
                                text_parts.append(text_val)
                    if text_parts:
                        joined = "".join(text_parts)
                        assistant_content_parts.append(joined)
                        yield _sse_event("delta", {"type": "content", "text": joined})

                delta_reasoning = getattr(delta, "reasoning", None)
                if isinstance(delta_reasoning, str) and delta_reasoning:
                    assistant_reasoning_parts.append(delta_reasoning)
                    yield _sse_event("delta", {"type": "reasoning", "text": delta_reasoning})

                delta_tool_calls = getattr(delta, "tool_calls", None) or []
                if delta_tool_calls:
                    assistant_tool_calls = _merge_tool_call_deltas(assistant_tool_calls, delta_tool_calls)
                    yield _sse_event("delta", {"type": "tool_calls", "toolCalls": assistant_tool_calls})

            assistant_msg = ChatMessage.model_validate({
                "role": "assistant",
                "content": "".join(assistant_content_parts),
                "tool_calls": assistant_tool_calls or None,
                "reasoning": "".join(assistant_reasoning_parts) or None,
                "timestamp": datetime.now(timezone.utc),
            })

            assistant_payload = assistant_msg.model_dump(by_alias=True, mode="json", exclude_none=True)
            yield _sse_event("message", assistant_payload)

            yield _sse_event(
                "done",
                {
                    "message": assistant_payload,
                    "usage": usage,
                    "compaction": {
                        "triggered": False,
                        "strategy": "none",
                        "thresholdTokens": int(settings.compaction_trigger_total_tokens),
                        "targetTokens": int(settings.compaction_target_total_tokens),
                        "estimatedTokensBefore": int(usage["inputTokens"]) if usage else 0,
                        "estimatedTokensAfter": int(usage["inputTokens"]) if usage else 0,
                        "droppedMessages": 0,
                        "summary": None,
                    },
                },
            )
        except ValidationError as exc:
            yield _sse_event("error", {"error": f"Invalid assistant message from LLM: {exc}"})
            yield _sse_event("done", {"message": None, "usage": usage, "compaction": None})
        except Exception as exc:
            yield _sse_event("error", {"error": str(exc) or "streaming failed"})
            yield _sse_event("done", {"message": None, "usage": usage, "compaction": None})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ..core.config import Settings, get_settings
from ..core.security import build_auth_context, enforce_tenant_match
from ..models import AgentRequest, ChatMessage
from ..services.agent_service import to_openai_messages
from ..services.compaction import compact_session_messages
from ..services.llm_client import get_async_openai_client, resolve_model
from ..services.push import (
    register_subscription,
    registry as push_registry,
    send_web_push_to_registry,
    unregister_subscription,
)


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
        normalized.append(
            {
                "id": str(call.get("id") or ""),
                "type": "function",
                "function": {
                    "name": str(name_value) if isinstance(name_value, str) else "",
                    "arguments": args_value if isinstance(args_value, str) else "",
                },
            }
        )

    return normalized


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


def _sse_event(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _bootstrap_root() -> Path:
    return Path(__file__).resolve().parents[1] / "static" / "bootstrap"


def _read_text_or_default(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return default


def _read_json_or_default(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else dict(default)
    except Exception:
        return dict(default)


def _load_context_bootstrap_files() -> list[dict[str, str]]:
    context_dir = _bootstrap_root() / "context"
    names = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    files: list[dict[str, str]] = []

    for name in names:
        content = _read_text_or_default(context_dir / name, "")
        files.append({"name": name, "content": content})

    return files


def _load_skills_bootstrap_payload() -> dict[str, Any]:
    skills_file = _bootstrap_root() / "skills" / "default-skills.json"
    fallback = {"version": 1, "skills": []}
    parsed = _read_json_or_default(skills_file, fallback)
    if "version" not in parsed:
        parsed["version"] = 1
    if not isinstance(parsed.get("skills"), list):
        parsed["skills"] = []
    return parsed


@router.get("/health")
async def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "timestamp": _iso_now(),
    }


@router.get("/tools")
async def tools() -> dict[str, Any]:
    return {"tools": []}


def _require_web_push_enabled(settings: Settings) -> None:
    if not settings.web_push_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Web Push is disabled",
        )


def _require_web_push_credentials(settings: Settings) -> None:
    if not settings.web_push_vapid_private_key or not settings.web_push_vapid_subject:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Web Push credentials are not configured",
        )


@router.get("/push/config")
async def push_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "enabled": bool(settings.web_push_enabled),
        "vapidPublicKey": settings.web_push_vapid_public_key,
    }


@router.post("/push/subscribe")
async def push_subscribe(
    payload: dict[str, Any],
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _require_web_push_enabled(settings)

    subscription_raw = payload.get("subscription")
    subscription = subscription_raw if isinstance(subscription_raw, dict) else payload
    if not isinstance(subscription, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="subscription payload must be an object",
        )

    tenant_id = payload.get("tenantId") or request.headers.get("x-tenant-id")
    user_id = payload.get("userId") or request.headers.get("x-user-id")
    agent_id = payload.get("agentId") or request.headers.get("x-agent-id")
    session_id = payload.get("sessionId")

    try:
        stored = register_subscription(
            subscription,
            tenant_id=str(tenant_id) if tenant_id else None,
            user_id=str(user_id) if user_id else None,
            agent_id=str(agent_id) if agent_id else None,
            session_id=str(session_id) if session_id else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return {
        "ok": True,
        "subscription": stored.to_dict(),
        "count": push_registry().count(),
        "createdAt": _iso_now(),
    }


@router.post("/push/unsubscribe")
async def push_unsubscribe(
    payload: dict[str, Any],
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _require_web_push_enabled(settings)

    endpoint = str(payload.get("endpoint") or "").strip()
    if not endpoint:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="endpoint is required",
        )

    removed = unregister_subscription(endpoint)
    return {
        "ok": removed,
        "removed": removed,
        "count": push_registry().count(),
        "createdAt": _iso_now(),
    }


@router.post("/push/heartbeat")
async def push_heartbeat(
    payload: dict[str, Any] | None = None,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _require_web_push_enabled(settings)
    _require_web_push_credentials(settings)

    body = payload if isinstance(payload, dict) else {}
    message = body.get("payload")
    if not isinstance(message, dict):
        message = {
            "type": "heartbeat",
            "createdAt": _iso_now(),
            "requestId": str(uuid4()),
        }

    result = await send_web_push_to_registry(
        message,
        vapid_private_key=str(settings.web_push_vapid_private_key or ""),
        vapid_subject=str(settings.web_push_vapid_subject or ""),
        ttl=int(body.get("ttl") or 60),
        tenant_id=str(body.get("tenantId")) if body.get("tenantId") else None,
        user_id=str(body.get("userId")) if body.get("userId") else None,
        agent_id=str(body.get("agentId")) if body.get("agentId") else None,
        session_id=str(body.get("sessionId")) if body.get("sessionId") else None,
    )

    return {
        "ok": bool(result.get("ok")),
        "sent": int(result.get("sent") or 0),
        "failed": int(result.get("failed") or 0),
        "results": result.get("results") or [],
        "createdAt": _iso_now(),
    }


@router.get("/context/bootstrap")
async def context_bootstrap() -> dict[str, Any]:
    return {
        "version": 1,
        "generatedAt": _iso_now(),
        "files": _load_context_bootstrap_files(),
    }





@router.get("/skills/bootstrap")
async def skills_bootstrap() -> dict[str, Any]:
    payload = _load_skills_bootstrap_payload()
    return {
        "version": int(payload.get("version") or 1),
        "generatedAt": _iso_now(),
        "skills": payload.get("skills") if isinstance(payload.get("skills"), list) else [],
    }


async def _run_agent_response(
    payload: AgentRequest,
    request: Request,
    settings: Settings,
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
    request_base_url = _metadata_openai_base_url(payload)
    client = get_async_openai_client(
        settings,
        openai_base_url_override=request_base_url,
    )

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

    merged_tools = [
        tool.model_dump(exclude_none=True) if hasattr(tool, "model_dump") else dict(tool)
        for tool in (payload.tools or [])
    ]

    for round_idx in range(settings.max_tool_rounds + 1):
        call_input_messages = list(working_messages)
        openai_messages = to_openai_messages(
            working_messages,
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

        # Backend tool execution is disabled.
        # Return assistant tool calls to the client for frontend execution.
        break

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


@router.post("/agent/respond")
async def agent_respond(
    payload: AgentRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return await _run_agent_response(payload, request, settings)


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
    client = get_async_openai_client(
        settings,
        openai_base_url_override=request_base_url,
    )

    openai_messages = to_openai_messages(
        list(payload.messages),
    )

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

            assistant_msg = ChatMessage.model_validate(
                {
                    "role": "assistant",
                    "content": "".join(assistant_content_parts),
                    "tool_calls": assistant_tool_calls or None,
                    "reasoning": "".join(assistant_reasoning_parts) or None,
                    "timestamp": datetime.now(timezone.utc),
                }
            )

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
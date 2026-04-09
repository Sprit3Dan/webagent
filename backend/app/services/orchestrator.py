"""
Backend orchestration layer.

Public API:
  - run_local_agent()        — direct agent execution (non-delegated)
  - run_inbound_delegation() — execute a task received from a peer agent
  - run_outbound_delegation()— dispatch a task to a peer agent
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request, status
from pydantic import ValidationError

from ..core.config import Settings
from ..core.security import build_auth_context, enforce_tenant_match
from ..models import AgentRequest, ChatMessage
from ..services.agent_service import to_openai_messages
from ..services.compaction import compact_session_messages
from ..services.llm_client import get_async_openai_client, resolve_model

logger = logging.getLogger(__name__)


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
            "arguments": fn.get("arguments")
            if isinstance(fn.get("arguments"), str)
            else json.dumps(fn or {}),
        },
    }


def _extract_reasoning(message_obj: Any) -> str | None:
    reasoning = getattr(message_obj, "reasoning", None)
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning.strip()
    model_extra = getattr(message_obj, "model_extra", None)
    if isinstance(model_extra, dict):
        candidate = model_extra.get("reasoning")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


# ── Local agent execution ─────────────────────────────────────────────────────


async def run_local_agent(
    payload: AgentRequest,
    request: Request,
    settings: Settings,
) -> dict[str, Any]:
    """
    Execute a local (non-delegated) agent request.

    This is the primary path for POST /agent/respond. Route handlers should
    remain thin and delegate here.

    Refactor safety clause: this function must remain behaviorally equivalent
    to the original _run_agent_response. All existing route tests must pass.
    """
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

    # Per-request LLM base URL override via metadata
    metadata = payload.metadata if isinstance(payload.metadata, dict) else {}
    llm_provider = metadata.get("llmProvider")
    request_base_url: str | None = None
    if isinstance(llm_provider, dict):
        raw_url = llm_provider.get("baseUrl")
        if isinstance(raw_url, str) and raw_url.strip():
            request_base_url = raw_url.strip()

    client = get_async_openai_client(settings, openai_base_url_override=request_base_url)

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
        openai_messages = to_openai_messages(working_messages)

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
            msg.model_dump(by_alias=True, mode="json", exclude_none=True)
            for msg in generated_messages
        ],
        "toolEvents": tool_events,
        "compaction": compaction_report,
    }


# ── Inbound delegation (target side) ─────────────────────────────────────────


async def run_inbound_delegation(
    envelope: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    """
    Execute a task received from a peer agent via the inbound-delegation consumer.

    Called by the NATS consumer handler after envelope validation passes.
    Publishes status updates (received → running → done|failed) back to origin.
    """
    from .a2a_protocol import build_status_event
    from .a2a_transport import get_transport
    from .delegation_store import get_delegation_store

    delegation_id = str(envelope.get("delegation_id") or "")
    message_id = str(envelope.get("message_id") or "")
    from_agent = str(envelope.get("from_agent") or "")
    correlation_id = str(envelope.get("correlation_id") or "") or None
    payload = envelope.get("payload") or {}
    task = payload.get("task") or {}

    store = get_delegation_store()
    transport = get_transport()
    self_agent_id = str(settings.a2a_agent_id or "")

    store.create(
        delegation_id=delegation_id,
        target_agent=self_agent_id,
        from_agent=from_agent,
        task=task,
    )

    async def _publish_status(
        new_status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        if transport is None:
            return
        event = build_status_event(
            delegation_id=delegation_id,
            status=new_status,
            from_agent=self_agent_id,
            result=result,
            error=error,
            correlation_id=correlation_id,
        )
        try:
            await transport.publish_status(from_agent, event)
        except Exception as exc:
            logger.error(
                "run_inbound_delegation: failed to publish status delegation_id=%s status=%s: %s",
                delegation_id, new_status, exc,
            )

    await _publish_status("received")
    store.transition(delegation_id, "received", message_id=message_id)

    await _publish_status("running")
    store.transition(delegation_id, "running")

    try:
        task_messages = task.get("messages") or []
        if not task_messages:
            task_text = task.get("text") or task.get("task") or json.dumps(task)
            task_messages = [{"role": "user", "content": task_text}]

        chat_messages = [ChatMessage.model_validate(m) for m in task_messages]
        result_content = await _execute_task_messages(chat_messages, settings)

        result_dict = {"content": result_content}
        store.transition(delegation_id, "done", result=result_dict)
        await _publish_status("done", result=result_dict)

        logger.info(
            "run_inbound_delegation: completed delegation_id=%s from=%s",
            delegation_id, from_agent,
        )
        return {"status": "done", "result": result_dict}

    except Exception as exc:
        error_str = str(exc)
        store.transition(delegation_id, "failed", error=error_str)
        await _publish_status("failed", error=error_str)
        logger.error(
            "run_inbound_delegation: failed delegation_id=%s: %s",
            delegation_id, exc, exc_info=True,
        )
        return {"status": "failed", "error": error_str}


async def _execute_task_messages(
    messages: list[ChatMessage],
    settings: Settings,
) -> str:
    """Run messages through LLM and return the text content of the final assistant response."""
    model_name = resolve_model(None, settings)
    client = get_async_openai_client(settings)
    openai_messages = to_openai_messages(messages)

    completion = await client.chat.completions.create(
        model=model_name,
        messages=openai_messages,
    )
    if not completion.choices:
        raise RuntimeError("LLM returned no choices for inbound delegation")

    return _safe_content(getattr(completion.choices[0].message, "content", ""))


# ── Outbound delegation (origin side) ────────────────────────────────────────


async def run_outbound_delegation(
    *,
    delegation_id: str,
    from_agent: str,
    target_agent: str,
    task: dict[str, Any],
    intent: str | None = None,
    settings: Settings,
) -> dict[str, Any]:
    """
    Resolve route, build envelope, publish to target, return dispatch receipt.

    Route selection order:
      1. Explicit target_agent (if provided)
      2. Capability-tag match from discovery (filtered by intent)
      3. Raises 502 if neither resolves

    Raises HTTPException on transport or routing failure.
    """
    from .a2a_protocol import MSG_DELEGATE, build_envelope
    from .a2a_transport import get_transport
    from .delegation_store import get_delegation_store
    from .discovery_client import get_discovery_client
    from uuid import uuid4 as _uuid4
    correlation_id = str(_uuid4())

    store = get_delegation_store()
    transport = get_transport()

    if transport is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="A2A transport not initialized",
        )

    # Route resolution
    resolved_target = target_agent.strip() if target_agent else ""
    if not resolved_target:
        discovery = get_discovery_client()
        if discovery:
            route = await discovery.discover_route(intent=intent)
            if route:
                resolved_target = str(route.get("agentId") or "")
        if not resolved_target:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not resolve target agent via discovery",
            )

    store.create(
        delegation_id=delegation_id,
        target_agent=resolved_target,
        from_agent=from_agent,
        task=task,
    )

    logger.info(
        "run_outbound_delegation: delegation_id=%s from=%s to=%s",
        delegation_id, from_agent, resolved_target,
    )

    envelope = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent=from_agent,
        to_agent=resolved_target,
        delegation_id=delegation_id,
        payload={"task": task, "intent": intent},
        secret=settings.a2a_shared_secret if settings.a2a_require_auth else None,
        correlation_id=correlation_id,
    )

    try:
        await transport.publish_delegation(resolved_target, envelope)
    except Exception as exc:
        store.transition(delegation_id, "failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to publish delegation envelope: {exc}",
        ) from exc

    store.transition(delegation_id, "dispatched")

    return {
        "delegationId": delegation_id,
        "targetAgent": resolved_target,
        "status": "dispatched",
        "messageId": str(envelope.get("message_id") or ""),
        "createdAt": _iso_now(),
    }

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from ...core.config import Settings, get_settings

router = APIRouter(tags=["a2a"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sse_event(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _require_a2a_enabled(settings: Settings) -> None:
    if not settings.a2a_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="A2A is disabled (set A2A_ENABLED=true to enable)",
        )


@router.post("/agent/delegate")
async def agent_delegate(
    payload: dict[str, Any],
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """
    Delegate a task to a peer agent.

    Body: task (required), targetAgent (optional), intent (optional).
    Returns a dispatch receipt with delegationId and initial status.
    Poll GET /a2a/delegations/{delegationId} for progress.
    """
    _require_a2a_enabled(settings)

    from ...services.orchestrator import run_outbound_delegation

    task = payload.get("task")
    if not task:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="task is required",
        )

    target_agent = str(payload.get("targetAgent") or "")
    intent_raw = payload.get("intent")
    intent = str(intent_raw).strip() if intent_raw else None
    task_dict: dict[str, Any] = task if isinstance(task, dict) else {"text": str(task)}
    delegation_id = str(uuid4())

    return await run_outbound_delegation(
        delegation_id=delegation_id,
        from_agent=str(settings.a2a_agent_id),
        target_agent=target_agent,
        task=task_dict,
        intent=intent,
        settings=settings,
    )


@router.get("/a2a/health")
async def a2a_health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    _require_a2a_enabled(settings)

    from ...services.a2a_transport import get_transport
    from ...services.delegation_store import get_delegation_store
    from ...services.discovery_client import get_discovery_client

    transport = get_transport()
    discovery = get_discovery_client()
    store = get_delegation_store()

    return {
        "ok": True,
        "a2aEnabled": True,
        "agentId": settings.a2a_agent_id,
        "transport": {
            "backend": settings.a2a_transport_backend,
            "connected": transport is not None,
            "natsUrl": settings.a2a_nats_url,
        },
        "discovery": {
            "connected": discovery is not None,
            "baseUrl": settings.a2a_discovery_base_url,
        },
        "store": {
            "delegations": store.count(),
        },
        "timestamp": _iso_now(),
    }


@router.get("/a2a/delegations/{delegation_id}/stream")
async def stream_delegation_status(
    delegation_id: str,
    poll_interval_ms: int = 500,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """
    SSE stream for live delegation status updates.

    Emits an 'update' event on every status change, then 'done' on terminal state.
    """
    _require_a2a_enabled(settings)

    from ...services.delegation_store import TERMINAL_STATUSES, get_delegation_store

    interval = max(0.1, min(5.0, poll_interval_ms / 1000))

    async def event_stream():
        store = get_delegation_store()
        last_status: str | None = None

        if store.get(delegation_id) is None:
            yield _sse_event("error", {"error": f"delegation {delegation_id!r} not found"})
            return

        while True:
            record = store.get(delegation_id)
            if record is None:
                yield _sse_event("error", {"error": "delegation record disappeared"})
                return

            if record.status != last_status:
                last_status = record.status
                yield _sse_event("update", record.to_dict())

            if record.status in TERMINAL_STATUSES:
                yield _sse_event("done", record.to_dict())
                return

            await asyncio.sleep(interval)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/a2a/delegations/{delegation_id}")
async def get_delegation(
    delegation_id: str,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _require_a2a_enabled(settings)

    from ...services.delegation_store import get_delegation_store

    record = get_delegation_store().get(delegation_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Delegation {delegation_id!r} not found",
        )
    return record.to_dict()


@router.get("/a2a/delegations")
async def list_delegations(
    fromAgent: str | None = None,
    targetAgent: str | None = None,
    status_filter: str | None = None,
    limit: int = 100,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _require_a2a_enabled(settings)

    from ...services.delegation_store import get_delegation_store

    records = get_delegation_store().list_records(
        from_agent=fromAgent,
        target_agent=targetAgent,
        status=status_filter,
        limit=max(1, min(500, limit)),
    )
    return {
        "delegations": [r.to_dict() for r in records],
        "count": len(records),
        "timestamp": _iso_now(),
    }

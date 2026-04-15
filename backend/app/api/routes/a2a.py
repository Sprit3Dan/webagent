from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, NoReturn
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from ...core.config import Settings, get_settings

router = APIRouter(tags=["a2a"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _raise_deprecated_store_endpoint(endpoint: str) -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail=(
            f"{endpoint} is deprecated. Backend delegation storage was removed. "
            "Delegation state must be read from frontend IndexedDB and push updates."
        ),
    )


@router.post("/agent/delegate")
async def agent_delegate(
    payload: dict[str, Any],
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """
    Delegate a task to a peer agent.

    Body: task (required), targetAgent (optional), intent (optional).
    Returns a dispatch receipt with delegationId and initial status.
    """
    from ...services.discovery_client import get_discovery_client
    from ...services.orchestrator import run_outbound_delegation

    task = payload.get("task")
    if not task:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="task is required",
        )

    explicit_target = str(payload.get("targetAgent") or "").strip()
    intent_raw = payload.get("intent")
    intent = str(intent_raw).strip() if intent_raw else None
    task_dict: dict[str, Any] = task if isinstance(task, dict) else {"text": str(task)}
    delegation_id = str(uuid4())

    caller_agent_id = str(
        payload.get("agentId")
        or request.headers.get("x-agent-id")
        or ""
    ).strip()
    if not caller_agent_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="agentId is required",
        )

    target_agent = explicit_target

    if explicit_target:
        discovery = get_discovery_client()
        if discovery is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Discovery client is not initialized",
            )

        raw_candidates = await discovery.list_registration_candidates(
            target_agent=explicit_target,
            intent=None,
            capabilities=None,
        )
        allowed_candidates = [
            c
            for c in raw_candidates
            if (
                str(c.get("agent_id") or c.get("agentId") or "").strip() != "webagent"
                and not str(c.get("agent_id") or c.get("agentId") or "").strip().startswith("webagent-")
            )
        ]
        matched = any(
            str(c.get("agent_id") or c.get("agentId") or "").strip() == explicit_target
            for c in allowed_candidates
        )
        if not matched:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="targetAgent is not an allowed discovery candidate",
            )

    return await run_outbound_delegation(
        delegation_id=delegation_id,
        from_agent=caller_agent_id,
        target_agent=target_agent,
        task=task_dict,
        intent=intent,
        settings=settings,
    )


@router.get("/a2a/health")
async def a2a_health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    from ...services.a2a_transport import get_transport
    from ...services.discovery_client import get_discovery_client

    transport = get_transport()
    discovery = get_discovery_client()

    return {
        "ok": True,
        "a2aEnabled": True,
        "agentId": settings.a2a_agent_id,
        "transport": {
            "backend": settings.a2a_transport_backend,
            "connected": transport is not None,
            "natsUrl": settings.a2a_nats_url,
            "streamName": settings.a2a_stream_name,
            "subjectPrefix": settings.a2a_subject_prefix,
            "consumerName": settings.a2a_consumer_name,
            "inboundAgentPattern": settings.a2a_inbound_agent_pattern,
            "maxDeliver": settings.a2a_max_deliver,
            "ackWaitSeconds": settings.a2a_ack_wait_seconds,
        },
        "discovery": {
            "connected": discovery is not None,
            "baseUrl": settings.a2a_discovery_base_url,
        },
        "auth": {
            "requireAuth": settings.a2a_require_auth,
            "clockSkewSeconds": settings.a2a_clock_skew_seconds,
            "nonceTtlSeconds": settings.a2a_nonce_ttl_seconds,
            "sharedSecretConfigured": bool(settings.a2a_shared_secret),
        },
        "execution": {
            "timeoutSeconds": settings.a2a_execution_timeout_seconds,
        },
        "store": {
            "delegations": None,
            "deprecated": True,
        },
        "timestamp": _iso_now(),
    }


@router.get("/a2a/discovery/candidates")
async def list_discovery_candidates(
    targetAgent: str | None = None,
    intent: str | None = None,
    capabilities: str | None = None,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    from ...services.discovery_client import get_discovery_client

    if not settings.a2a_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="A2A is disabled",
        )

    discovery = get_discovery_client()
    if discovery is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Discovery client is not initialized",
        )

    target = str(targetAgent or "").strip() or None
    hint = str(intent or "").strip() or None
    cap_list = [
        part.strip()
        for part in str(capabilities or "").split(",")
        if part.strip()
    ] or None

    candidates = await discovery.list_registration_candidates(
        target_agent=target,
        intent=hint,
        capabilities=cap_list,
    )
    filtered_candidates = [
        c
        for c in candidates
        if (
            str(c.get("agent_id") or c.get("agentId") or "").strip() != "webagent"
            and not str(c.get("agent_id") or c.get("agentId") or "").strip().startswith("webagent-")
        )
    ]

    return {
        "candidates": filtered_candidates,
        "count": len(filtered_candidates),
        "targetAgent": target,
        "intent": hint,
        "capabilities": cap_list or [],
        "timestamp": _iso_now(),
    }


@router.get("/a2a/discovery/specialists")
async def list_discovery_specialists(
    targetAgent: str | None = None,
    intent: str | None = None,
    capabilities: str | None = None,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _ = targetAgent, intent, capabilities, settings
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail=(
            "/api/a2a/discovery/specialists is deprecated. "
            "Use /api/a2a/discovery/candidates."
        ),
    )


@router.get("/a2a/ws/status")
async def a2a_ws_status(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    from ...services.a2a_ws import get_a2a_ws_hub

    hub = get_a2a_ws_hub()
    connections = await hub.list_connections()
    return {
        "ok": True,
        "enabled": bool(settings.a2a_enabled),
        "connections": connections,
        "count": len(connections),
        "timestamp": _iso_now(),
    }


@router.websocket("/a2a/ws")
async def a2a_ws_endpoint(
    websocket: WebSocket,
    tenantId: str | None = None,
    userId: str | None = None,
    agentId: str | None = None,
    sessionId: str | None = None,
) -> None:
    from ...services.a2a_ws import get_a2a_ws_hub

    hub = get_a2a_ws_hub()
    connection = await hub.connect(
        websocket,
        tenant_id=str(tenantId) if tenantId else None,
        user_id=str(userId) if userId else None,
        agent_id=str(agentId) if agentId else None,
        session_id=str(sessionId) if sessionId else None,
        accept=True,
    )

    await websocket.send_json(
        {
            "type": "a2a.ws.connected",
            "connectionId": connection.connection_id,
            "agentId": connection.agent_id,
            "timestamp": _iso_now(),
        }
    )

    try:
        while True:
            message = await websocket.receive_text()
            if str(message).strip().lower() == "ping":
                await websocket.send_json({"type": "pong", "timestamp": _iso_now()})
    except WebSocketDisconnect:
        await hub.remove(connection.connection_id)
    except Exception:
        await hub.remove(connection.connection_id)


@router.get("/a2a/delegations/{delegation_id}/stream")
async def stream_delegation_status(
    delegation_id: str,
    poll_interval_ms: int = 500,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _ = delegation_id, poll_interval_ms, settings
    _raise_deprecated_store_endpoint("/api/a2a/delegations/{delegation_id}/stream")


@router.get("/a2a/delegations/{delegation_id}")
async def get_delegation(
    delegation_id: str,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _ = delegation_id, settings
    _raise_deprecated_store_endpoint("/api/a2a/delegations/{delegation_id}")


@router.get("/a2a/delegations")
async def list_delegations(
    fromAgent: str | None = None,
    targetAgent: str | None = None,
    status_filter: str | None = None,
    limit: int = 100,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    _ = fromAgent, targetAgent, status_filter, limit, settings
    _raise_deprecated_store_endpoint("/api/a2a/delegations")
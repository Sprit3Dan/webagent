from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ...core.config import Settings, get_settings
from ...services.push import (
    register_subscription,
    registry as push_registry,
    send_web_push_to_registry,
    unregister_subscription,
)

router = APIRouter(tags=["push"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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

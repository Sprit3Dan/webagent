from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, cast
import importlib

WebPushFn = Callable[..., Any]

try:
    _pywebpush = importlib.import_module("pywebpush")
    WebPushException = cast(type[Exception], getattr(_pywebpush, "WebPushException"))
    webpush = cast(WebPushFn | None, getattr(_pywebpush, "webpush", None))
except Exception:  # pragma: no cover - dependency may be absent in dev until installed
    WebPushException = Exception
    webpush: WebPushFn | None = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utc_now().isoformat()


def _safe_str(value: Any) -> str:
    return str(value or "").strip()


def _extract_status_code(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    if response is None:
        return None
    code = getattr(response, "status_code", None)
    return int(code) if isinstance(code, int) else None


@dataclass
class PushSubscription:
    endpoint: str
    p256dh: str
    auth: str
    tenant_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    created_at: str = field(default_factory=_iso_now)
    updated_at: str = field(default_factory=_iso_now)

    def to_subscription_info(self) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "keys": {
                "p256dh": self.p256dh,
                "auth": self.auth,
            },
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "keys": {
                "p256dh": self.p256dh,
                "auth": self.auth,
            },
            "tenantId": self.tenant_id,
            "userId": self.user_id,
            "agentId": self.agent_id,
            "sessionId": self.session_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class InMemoryPushSubscriptionRegistry:
    def __init__(self) -> None:
        self._items: dict[str, PushSubscription] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _parse_subscription_payload(
        payload: dict[str, Any],
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
    ) -> PushSubscription:
        endpoint = _safe_str(payload.get("endpoint"))
        keys_raw = payload.get("keys")
        keys: dict[str, Any] = keys_raw if isinstance(keys_raw, dict) else {}
        p256dh = _safe_str(keys.get("p256dh"))
        auth = _safe_str(keys.get("auth"))

        if not endpoint:
            raise ValueError("push subscription endpoint is required")
        if not p256dh or not auth:
            raise ValueError("push subscription keys.p256dh and keys.auth are required")

        return PushSubscription(
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            tenant_id=_safe_str(tenant_id) or None,
            user_id=_safe_str(user_id) or None,
            agent_id=_safe_str(agent_id) or None,
            session_id=_safe_str(session_id) or None,
        )

    def upsert(
        self,
        payload: dict[str, Any],
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
    ) -> PushSubscription:
        sub = self._parse_subscription_payload(
            payload,
            tenant_id=tenant_id,
            user_id=user_id,
            agent_id=agent_id,
            session_id=session_id,
        )

        with self._lock:
            existing = self._items.get(sub.endpoint)
            if existing:
                existing.p256dh = sub.p256dh
                existing.auth = sub.auth
                existing.tenant_id = sub.tenant_id
                existing.user_id = sub.user_id
                existing.agent_id = sub.agent_id
                existing.session_id = sub.session_id
                existing.updated_at = _iso_now()
                return existing

            self._items[sub.endpoint] = sub
            return sub

    def remove(self, endpoint: str) -> bool:
        key = _safe_str(endpoint)
        if not key:
            return False
        with self._lock:
            return self._items.pop(key, None) is not None

    def list(
        self,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
    ) -> list[PushSubscription]:
        with self._lock:
            out = list(self._items.values())

        def _match(sub: PushSubscription) -> bool:
            if tenant_id and sub.tenant_id != tenant_id:
                return False
            if user_id and sub.user_id != user_id:
                return False
            if agent_id and sub.agent_id != agent_id:
                return False
            if session_id and sub.session_id != session_id:
                return False
            return True

        return [s for s in out if _match(s)]

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def count(self) -> int:
        with self._lock:
            return len(self._items)


_registry = InMemoryPushSubscriptionRegistry()


def registry() -> InMemoryPushSubscriptionRegistry:
    return _registry


def register_subscription(
    payload: dict[str, Any],
    *,
    tenant_id: str | None = None,
    user_id: str | None = None,
    agent_id: str | None = None,
    session_id: str | None = None,
) -> PushSubscription:
    return _registry.upsert(
        payload,
        tenant_id=tenant_id,
        user_id=user_id,
        agent_id=agent_id,
        session_id=session_id,
    )


def unregister_subscription(endpoint: str) -> bool:
    return _registry.remove(endpoint)


async def send_web_push(
    subscription: PushSubscription,
    payload: dict[str, Any] | str,
    *,
    vapid_private_key: str,
    vapid_subject: str,
    ttl: int = 60,
) -> dict[str, Any]:
    if not _safe_str(vapid_private_key):
        raise ValueError("vapid_private_key is required")
    if not _safe_str(vapid_subject):
        raise ValueError("vapid_subject is required")

    body = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    def _send_sync() -> dict[str, Any]:
        if webpush is None:
            return {
                "ok": False,
                "endpoint": subscription.endpoint,
                "status": None,
                "error": "pywebpush is not installed",
            }
        try:
            webpush(
                subscription_info=subscription.to_subscription_info(),
                data=body,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": vapid_subject},
                ttl=max(0, int(ttl)),
            )
            return {
                "ok": True,
                "endpoint": subscription.endpoint,
                "status": 201,
            }
        except WebPushException as exc:
            status = _extract_status_code(exc)
            return {
                "ok": False,
                "endpoint": subscription.endpoint,
                "status": status,
                "error": str(exc),
            }
        except Exception as exc:
            return {
                "ok": False,
                "endpoint": subscription.endpoint,
                "status": None,
                "error": str(exc),
            }

    return await asyncio.to_thread(_send_sync)


async def send_web_push_to_registry(
    payload: dict[str, Any] | str,
    *,
    vapid_private_key: str,
    vapid_subject: str,
    ttl: int = 60,
    tenant_id: str | None = None,
    user_id: str | None = None,
    agent_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    targets = _registry.list(
        tenant_id=tenant_id,
        user_id=user_id,
        agent_id=agent_id,
        session_id=session_id,
    )
    if not targets:
        return {
            "ok": True,
            "sent": 0,
            "failed": 0,
            "results": [],
        }

    results = await asyncio.gather(
        *[
            send_web_push(
                sub,
                payload,
                vapid_private_key=vapid_private_key,
                vapid_subject=vapid_subject,
                ttl=ttl,
            )
            for sub in targets
        ]
    )

    # Remove stale subscriptions that are gone/invalid.
    for item in results:
        status = item.get("status")
        endpoint = _safe_str(item.get("endpoint"))
        if endpoint and status in {404, 410}:
            _registry.remove(endpoint)

    sent = sum(1 for item in results if item.get("ok"))
    failed = len(results) - sent

    return {
        "ok": failed == 0,
        "sent": sent,
        "failed": failed,
        "results": results,
    }


async def publish_a2a_push_update(
    *,
    delegation_id: str,
    status: str,
    from_agent: str | None = None,
    target_agent: str | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    tenant_id: str | None = None,
    user_id: str | None = None,
    agent_id: str | None = None,
    session_id: str | None = None,
    vapid_private_key: str,
    vapid_subject: str,
    ttl: int = 60,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "a2a.delegation.update",
        "delegationId": _safe_str(delegation_id),
        "status": _safe_str(status),
        "fromAgent": _safe_str(from_agent) or None,
        "targetAgent": _safe_str(target_agent) or None,
        "result": result,
        "error": _safe_str(error) or None,
        "updatedAt": _iso_now(),
    }

    delivery = await send_web_push_to_registry(
        payload,
        vapid_private_key=vapid_private_key,
        vapid_subject=vapid_subject,
        ttl=ttl,
        tenant_id=_safe_str(tenant_id) or None,
        user_id=_safe_str(user_id) or None,
        agent_id=_safe_str(agent_id) or None,
        session_id=_safe_str(session_id) or None,
    )

    return {
        "ok": bool(delivery.get("ok")),
        "payload": payload,
        "delivery": delivery,
    }
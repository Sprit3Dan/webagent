from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket

logger = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_str(value: Any) -> str:
    return str(value or "").strip()


@dataclass
class _HubConnection:
    connection_id: str
    websocket: WebSocket
    tenant_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    created_at: str = field(default_factory=_iso_now)
    updated_at: str = field(default_factory=_iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "connectionId": self.connection_id,
            "tenantId": self.tenant_id,
            "userId": self.user_id,
            "agentId": self.agent_id,
            "sessionId": self.session_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class A2AWebSocketHub:
    """
    In-memory WebSocket hub for agent-scoped realtime A2A updates.

    Matching rules:
    - If a filter is provided (tenant/user/agent/session), connection value must match exactly.
    - If a filter is omitted, it is ignored.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._connections: dict[str, _HubConnection] = {}

    async def connect(
        self,
        websocket: WebSocket,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
        accept: bool = True,
    ) -> _HubConnection:
        if accept:
            await websocket.accept()

        conn = _HubConnection(
            connection_id=str(uuid4()),
            websocket=websocket,
            tenant_id=_safe_str(tenant_id) or None,
            user_id=_safe_str(user_id) or None,
            agent_id=_safe_str(agent_id) or None,
            session_id=_safe_str(session_id) or None,
        )

        async with self._lock:
            self._connections[conn.connection_id] = conn

        logger.debug(
            "a2a_ws: connected id=%s tenant=%s user=%s agent=%s session=%s",
            conn.connection_id,
            conn.tenant_id or "<none>",
            conn.user_id or "<none>",
            conn.agent_id or "<none>",
            conn.session_id or "<none>",
        )
        return conn

    async def disconnect(self, connection_id: str) -> bool:
        key = _safe_str(connection_id)
        if not key:
            return False

        async with self._lock:
            conn = self._connections.pop(key, None)

        if conn is None:
            return False

        try:
            await conn.websocket.close()
        except Exception:
            pass

        logger.debug("a2a_ws: disconnected id=%s", key)
        return True

    async def remove(self, connection_id: str) -> bool:
        key = _safe_str(connection_id)
        if not key:
            return False

        async with self._lock:
            removed = self._connections.pop(key, None) is not None

        if removed:
            logger.debug("a2a_ws: removed id=%s", key)
        return removed

    async def count(self) -> int:
        async with self._lock:
            return len(self._connections)

    async def list_connections(self) -> list[dict[str, Any]]:
        async with self._lock:
            items = [conn.to_dict() for conn in self._connections.values()]
        items.sort(key=lambda x: (x.get("createdAt") or "", x.get("connectionId") or ""))
        return items

    async def broadcast_json(
        self,
        payload: dict[str, Any],
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        t = _safe_str(tenant_id) or None
        u = _safe_str(user_id) or None
        a = _safe_str(agent_id) or None
        s = _safe_str(session_id) or None

        async with self._lock:
            snapshot = list(self._connections.items())

        async def _send_one(item: tuple[str, _HubConnection]) -> tuple[str, bool, str | None]:
            conn_id, conn = item
            if not self._matches(conn, tenant_id=t, user_id=u, agent_id=a, session_id=s):
                return conn_id, False, None

            try:
                await conn.websocket.send_json(payload)
                conn.updated_at = _iso_now()
                return conn_id, True, None
            except Exception as exc:
                return conn_id, False, str(exc)

        results = await asyncio.gather(*[_send_one(item) for item in snapshot], return_exceptions=False)

        stale_ids: list[str] = []
        sent = 0
        failed = 0
        errors: list[dict[str, Any]] = []

        for conn_id, delivered, err in results:
            if delivered:
                sent += 1
                continue

            if err is None:
                continue

            failed += 1
            stale_ids.append(conn_id)
            errors.append({"connectionId": conn_id, "error": err})

        if stale_ids:
            async with self._lock:
                for cid in stale_ids:
                    self._connections.pop(cid, None)

        return {
            "ok": failed == 0,
            "sent": sent,
            "failed": failed,
            "results": errors,
            "timestamp": _iso_now(),
        }

    async def publish_a2a_update(
        self,
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

        delivery = await self.broadcast_json(
            payload,
            tenant_id=tenant_id,
            user_id=user_id,
            agent_id=_safe_str(agent_id) or _safe_str(target_agent) or None,
            session_id=session_id,
        )

        return {
            "ok": bool(delivery.get("ok")),
            "payload": payload,
            "delivery": delivery,
        }

    @staticmethod
    def _matches(
        conn: _HubConnection,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
    ) -> bool:
        if tenant_id and conn.tenant_id != tenant_id:
            return False
        if user_id and conn.user_id != user_id:
            return False
        if agent_id and conn.agent_id != agent_id:
            return False
        if session_id and conn.session_id != session_id:
            return False
        return True


_hub: Optional[A2AWebSocketHub] = None


def get_a2a_ws_hub() -> A2AWebSocketHub:
    global _hub
    if _hub is None:
        _hub = A2AWebSocketHub()
    return _hub
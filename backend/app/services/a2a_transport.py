"""
NATS JetStream transport adapter for A2A delegation.

Each backend instance runs two durable consumers:
  1. inbound-delegation consumer: <prefix>.delegations.<self_agent_id>
  2. inbound-status consumer:     <prefix>.status.<self_agent_id>

Target subjects for outbound:
  - delegation: <prefix>.delegations.<target_agent_id>
  - status:     <prefix>.status.<origin_agent_id>
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

DelegationHandler = Callable[[dict[str, Any]], Awaitable[None]]
StatusHandler = Callable[[dict[str, Any]], Awaitable[None]]


class A2ATransport:
    def __init__(
        self,
        *,
        nats_url: str,
        stream_name: str,
        subject_prefix: str,
        self_agent_id: str,
        consumer_name: str,
        max_deliver: int = 5,
        ack_wait_seconds: int = 30,
    ) -> None:
        self._nats_url = nats_url
        self._stream_name = stream_name
        self._subject_prefix = subject_prefix.rstrip(".")
        self._agent_id = self_agent_id
        self._consumer_name = consumer_name
        self._max_deliver = max_deliver
        self._ack_wait_ns = ack_wait_seconds * 10**9  # NATS expects nanoseconds

        self._nc: Any = None   # nats.aio.client.Client
        self._js: Any = None   # JetStream context
        self._consumer_tasks: list[asyncio.Task] = []  # type: ignore[type-arg]

    # ── subject helpers ─────────────────────────────────────────────────────

    @property
    def delegation_subject(self) -> str:
        return f"{self._subject_prefix}.delegations.{self._agent_id}"

    @property
    def status_subject(self) -> str:
        return f"{self._subject_prefix}.status.{self._agent_id}"

    def _delegation_subject_for(self, agent_id: str) -> str:
        return f"{self._subject_prefix}.delegations.{agent_id}"

    def _status_subject_for(self, agent_id: str) -> str:
        return f"{self._subject_prefix}.status.{agent_id}"

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        try:
            import nats
            from nats.js.api import StreamConfig
        except ImportError as exc:
            raise RuntimeError(
                "nats-py is not installed. Add nats-py to requirements.txt."
            ) from exc

        self._nc = await nats.connect(
            self._nats_url,
            reconnect_time_wait=2,
            max_reconnect_attempts=-1,  # unlimited
            reconnected_cb=self._on_reconnect,
            disconnected_cb=self._on_disconnect,
            error_cb=self._on_error,
        )
        self._js = self._nc.jetstream()
        logger.info("a2a_transport: connected to NATS at %s", self._nats_url)

        # Ensure stream exists (add_stream is idempotent when config matches)
        try:
            await self._js.add_stream(
                StreamConfig(
                    name=self._stream_name,
                    subjects=[
                        f"{self._subject_prefix}.delegations.*",
                        f"{self._subject_prefix}.status.*",
                    ],
                )
            )
            logger.info("a2a_transport: stream %r ready", self._stream_name)
        except Exception as exc:
            logger.warning("a2a_transport: stream setup warning (may already exist): %s", exc)

    async def start_consumers(
        self,
        *,
        delegation_handler: DelegationHandler,
        status_handler: StatusHandler,
    ) -> None:
        """Start both durable pull-subscribe consumers as background tasks."""
        delegation_task = asyncio.create_task(
            self._consume_loop(
                subject=self.delegation_subject,
                durable_name=f"{self._consumer_name}-delegation",
                handler=delegation_handler,
            ),
            name=f"a2a-delegation-{self._agent_id}",
        )
        status_task = asyncio.create_task(
            self._consume_loop(
                subject=self.status_subject,
                durable_name=f"{self._consumer_name}-status",
                handler=status_handler,
            ),
            name=f"a2a-status-{self._agent_id}",
        )
        self._consumer_tasks = [delegation_task, status_task]
        logger.info(
            "a2a_transport: started consumers agent=%s delegation=%s status=%s",
            self._agent_id,
            self.delegation_subject,
            self.status_subject,
        )

    async def disconnect(self) -> None:
        for task in self._consumer_tasks:
            task.cancel()
        if self._consumer_tasks:
            await asyncio.gather(*self._consumer_tasks, return_exceptions=True)
        if self._nc:
            try:
                await self._nc.drain()
            except Exception as exc:
                logger.warning("a2a_transport: drain error: %s", exc)
        logger.info("a2a_transport: disconnected")

    # ── consumers ────────────────────────────────────────────────────────────

    async def _consume_loop(
        self,
        *,
        subject: str,
        durable_name: str,
        handler: DelegationHandler | StatusHandler,
    ) -> None:
        while True:
            try:
                sub = await self._js.pull_subscribe(subject, durable_name)
                logger.info("a2a_transport: pull consumer ready on %s", subject)
                while True:
                    try:
                        msgs = await sub.fetch(batch=10, timeout=5.0)
                        for msg in msgs:
                            await self._handle_message(msg, handler, subject)
                    except asyncio.CancelledError:
                        raise
                    except Exception as fetch_exc:
                        exc_name = type(fetch_exc).__name__
                        if "Timeout" in exc_name or "timeout" in str(fetch_exc).lower():
                            continue  # normal — no messages available
                        logger.warning(
                            "a2a_transport: fetch error on %s: %s", subject, fetch_exc
                        )
                        await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                logger.info("a2a_transport: consumer cancelled for %s", subject)
                return
            except Exception as exc:
                logger.error(
                    "a2a_transport: consumer loop error on %s: %s — retrying in 5s",
                    subject, exc,
                )
                await asyncio.sleep(5)

    async def _handle_message(
        self,
        msg: Any,
        handler: DelegationHandler | StatusHandler,
        subject: str,
    ) -> None:
        try:
            envelope = json.loads(msg.data)
        except (json.JSONDecodeError, Exception) as exc:
            logger.error(
                "a2a_transport: invalid message on %s (not JSON): %s", subject, exc
            )
            await msg.nak()
            return

        try:
            await handler(envelope)
            await msg.ack()
        except Exception as exc:
            logger.error(
                "a2a_transport: handler error on %s delegation_id=%s: %s",
                subject,
                envelope.get("delegation_id"),
                exc,
                exc_info=True,
            )
            await msg.nak()

    # ── publish ──────────────────────────────────────────────────────────────

    async def publish_delegation(
        self,
        target_agent_id: str,
        envelope: dict[str, Any],
    ) -> None:
        subject = self._delegation_subject_for(target_agent_id)
        data = json.dumps(envelope, default=str).encode("utf-8")
        await self._js.publish(subject, data)
        logger.debug(
            "a2a_transport: published delegation delegation_id=%s to %s",
            envelope.get("delegation_id"),
            subject,
        )

    async def publish_status(
        self,
        origin_agent_id: str,
        status_envelope: dict[str, Any],
    ) -> None:
        subject = self._status_subject_for(origin_agent_id)
        data = json.dumps(status_envelope, default=str).encode("utf-8")
        await self._js.publish(subject, data)
        logger.debug(
            "a2a_transport: published status delegation_id=%s status=%s to %s",
            status_envelope.get("delegation_id"),
            (status_envelope.get("payload") or {}).get("status"),
            subject,
        )

    # ── NATS callbacks ───────────────────────────────────────────────────────

    async def _on_reconnect(self) -> None:
        logger.warning("a2a_transport: reconnected to NATS")
        try:
            from .metrics import record_transport_reconnect
            record_transport_reconnect()
        except Exception:
            pass

    async def _on_disconnect(self) -> None:
        logger.warning("a2a_transport: disconnected from NATS")

    async def _on_error(self, exc: Exception) -> None:
        logger.error("a2a_transport: NATS error: %s", exc)


# Module-level singleton
_transport: Optional[A2ATransport] = None


def get_transport() -> Optional[A2ATransport]:
    return _transport


def init_transport(**kwargs: Any) -> A2ATransport:
    global _transport
    _transport = A2ATransport(**kwargs)
    return _transport

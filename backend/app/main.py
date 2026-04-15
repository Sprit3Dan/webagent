from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api.routes import router as api_router
from .core.config import Settings, get_settings
from .services.tools import register_builtin_tools

logger = logging.getLogger(__name__)


def _a2a_event_summary(event: dict[str, Any]) -> dict[str, Any]:
    payload_raw = event.get("payload")
    payload = payload_raw if isinstance(payload_raw, dict) else {}
    result = payload.get("result")
    content = str(payload.get("content") or event.get("content") or "").strip()

    return {
        "delegation_id": str(event.get("delegation_id") or "").strip(),
        "event_id": str(event.get("event_id") or "").strip(),
        "message_id": str(event.get("message_id") or "").strip(),
        "message_type": str(event.get("message_type") or "").strip().lower(),
        "status": str(event.get("status") or "").strip().lower(),
        "from_agent": str(event.get("from_agent") or "").strip(),
        "to_agent": str(event.get("to_agent") or event.get("target_agent") or "").strip(),
        "correlation_id": str(event.get("correlation_id") or "").strip(),
        "payload_keys": sorted(payload.keys()),
        "has_task": isinstance(payload.get("task"), dict),
        "has_result_dict": isinstance(result, dict),
        "result_type": type(result).__name__ if result is not None else "none",
        "content_len": len(content),
    }


async def _a2a_startup(settings: Settings) -> None:
    from .services.a2a_protocol import validate_envelope
    from .services.a2a_transport import init_transport
    from .services.discovery_client import init_discovery_client
    from .services.orchestrator import run_inbound_delegation

    # Init discovery client
    discovery = init_discovery_client(
        str(settings.a2a_discovery_base_url),
        timeout_seconds=5.0,
        retries=3,
    )

    # Register self with discovery
    try:
        await discovery.register_agent(
            agent_id=str(settings.a2a_agent_id),
            ttl=120,
        )
        logger.info("a2a: registered with discovery as %s", settings.a2a_agent_id)
    except Exception as exc:
        logger.warning("a2a: registration failed (continuing without discovery): %s", exc)

    # Init and connect NATS transport
    transport = init_transport(
        nats_url=str(settings.a2a_nats_url),
        stream_name=settings.a2a_stream_name,
        subject_prefix=settings.a2a_subject_prefix,
        self_agent_id=str(settings.a2a_agent_id),
        consumer_name=settings.a2a_consumer_name,
        inbound_agent_pattern=settings.a2a_inbound_agent_pattern,
        max_deliver=settings.a2a_max_deliver,
        ack_wait_seconds=settings.a2a_ack_wait_seconds,
    )
    logger.info(
        "a2a: transport config backend=%s nats_url=%s stream=%s prefix=%s agent_id=%s inbound_selector=%s consumer=%s",
        settings.a2a_transport_backend,
        settings.a2a_nats_url,
        settings.a2a_stream_name,
        settings.a2a_subject_prefix,
        settings.a2a_agent_id,
        settings.a2a_inbound_agent_pattern,
        settings.a2a_consumer_name,
    )

    try:
        await transport.connect()
    except Exception as exc:
        logger.error("a2a: transport connect failed: %s — A2A will be unavailable", exc)
        return

    # Inbound delegation consumer handler
    async def _delegation_handler(envelope: dict[str, Any]) -> None:
        try:
            configured_agent_id = str(settings.a2a_agent_id or "").strip()
            validation_agent_id = configured_agent_id
            if "-" in configured_agent_id:
                base_agent_id = configured_agent_id.split("-", 1)[0].strip()
                if base_agent_id:
                    validation_agent_id = base_agent_id

            to_agent = str(envelope.get("to_agent") or "").strip()
            is_for_self = (
                to_agent == configured_agent_id
                or to_agent == "*"
                or (
                    bool(validation_agent_id)
                    and to_agent.startswith(f"{validation_agent_id}-")
                )
            )
            if not is_for_self:
                logger.debug(
                    "a2a: envelope ignored summary=%s self_agent_id=%s",
                    _a2a_event_summary(envelope),
                    configured_agent_id or "<missing>",
                )
                return

            validate_envelope(
                envelope,
                self_agent_id=validation_agent_id,
                require_auth=settings.a2a_require_auth,
                shared_secret=settings.a2a_shared_secret,
                clock_skew_seconds=settings.a2a_clock_skew_seconds,
                nonce_ttl_seconds=settings.a2a_nonce_ttl_seconds,
            )
        except ValueError as exc:
            logger.error(
                "a2a: envelope validation failed delegation_id=%s: %s",
                envelope.get("delegation_id"), exc,
            )
            try:
                from .services.metrics import record_envelope_validation_failure
                record_envelope_validation_failure(str(exc))
            except Exception:
                pass
            return

        delegation_id = str(envelope.get("delegation_id") or "").strip()
        from_agent = str(envelope.get("from_agent") or "").strip()
        to_agent = str(envelope.get("to_agent") or "").strip()
        message_type = str(envelope.get("message_type") or "").strip().lower()
        payload_raw = envelope.get("payload")
        payload = payload_raw if isinstance(payload_raw, dict) else {}
        content = str(envelope.get("content") or "").strip()

        logger.debug(
            "a2a: inbound envelope accepted summary=%s",
            _a2a_event_summary(envelope),
        )

        task_payload = payload.get("task")
        has_structured_task = isinstance(task_payload, dict)

        # Structured delegation requests are executed locally.
        # Terminal replies from peer agents may still use delegation_request
        # but without payload.task, and should be pushed as done updates.
        if message_type == "delegation_request" and has_structured_task:
            await run_inbound_delegation(envelope, settings)
            return

        if not delegation_id:
            logger.warning("a2a: reply envelope missing delegation_id, skipping push passthrough")
            return

        result_raw = payload.get("result")
        payload_content = str(payload.get("content") or "").strip()
        result_dict = (
            result_raw
            if isinstance(result_raw, dict)
            else {"content": payload_content or content}
        )

        envelope_payload_raw = envelope.get("payload")
        envelope_payload = (
            envelope_payload_raw if isinstance(envelope_payload_raw, dict) else {}
        )
        reply_context: dict[str, Any] = {}
        reply_task = envelope_payload.get("task")
        if isinstance(reply_task, dict):
            reply_context["task"] = reply_task
        reply_intent = envelope_payload.get("intent")
        if isinstance(reply_intent, str) and reply_intent.strip():
            reply_context["intent"] = reply_intent.strip()
        correlation_id = str(envelope.get("correlation_id") or "").strip()
        if correlation_id:
            reply_context["correlationId"] = correlation_id

        target = to_agent or str(settings.a2a_agent_id or "")
        ws_sent = 0

        try:
            from .services.a2a_ws import get_a2a_ws_hub

            ws_result = await get_a2a_ws_hub().publish_a2a_update(
                delegation_id=delegation_id,
                status="done",
                from_agent=from_agent,
                target_agent=target,
                result=result_dict,
                error=None,
                context=reply_context or None,
                agent_id=target,
            )
            delivery = ws_result.get("delivery") if isinstance(ws_result, dict) else {}
            ws_sent = int((delivery or {}).get("sent") or 0)
            logger.debug(
                "a2a: reply ws publish delegation_id=%s target_agent=%s sent=%s failed=%s",
                delegation_id,
                target,
                ws_sent,
                int((delivery or {}).get("failed") or 0),
            )
        except Exception as exc:
            logger.warning(
                "a2a: failed to publish ws update for reply delegation_id=%s: %s",
                delegation_id,
                exc,
            )

        if ws_sent > 0:
            return

        if (
            settings.web_push_enabled
            and settings.web_push_vapid_private_key
            and settings.web_push_vapid_subject
        ):
            try:
                from .services.push import publish_a2a_push_update

                logger.debug(
                    "a2a: reply push start summary=%s result_content_len=%s",
                    _a2a_event_summary(envelope),
                    len(str(result_dict.get("content") or "")),
                )

                push_result = await publish_a2a_push_update(
                    delegation_id=delegation_id,
                    status="done",
                    from_agent=from_agent,
                    target_agent=target,
                    result=result_dict,
                    error=None,
                    context=reply_context or None,
                    agent_id=target,
                    vapid_private_key=str(settings.web_push_vapid_private_key or ""),
                    vapid_subject=str(settings.web_push_vapid_subject or ""),
                    ttl=60,
                )
                delivery = push_result.get("delivery") if isinstance(push_result, dict) else {}

                logger.debug(
                    "a2a: reply push done delegation_id=%s target_agent=%s sent=%s failed=%s",
                    delegation_id,
                    target,
                    int((delivery or {}).get("sent") or 0),
                    int((delivery or {}).get("failed") or 0),
                )
            except Exception as exc:
                logger.warning(
                    "a2a: failed to publish push passthrough for reply delegation_id=%s: %s",
                    delegation_id, exc,
                )

    # Inbound status consumer handler — push-only passthrough.
    async def _status_handler(event: dict[str, Any]) -> None:
        delegation_id = str(event.get("delegation_id") or "").strip()
        raw_status = str(event.get("status") or "").strip().lower()
        new_status = "done" if raw_status == "completed" else raw_status
        from_agent = str(event.get("from_agent") or "").strip()
        to_agent = str(event.get("to_agent") or event.get("target_agent") or "").strip()
        payload_raw = event.get("payload")
        payload = payload_raw if isinstance(payload_raw, dict) else {}
        result = payload.get("result")
        error = payload.get("error")
        content = str(payload.get("content") or event.get("content") or "").strip()

        normalized_result: dict[str, Any] | None = None
        if isinstance(result, dict):
            normalized_result = result
        elif isinstance(result, str) and result.strip():
            normalized_result = {"content": result.strip()}
        elif content:
            normalized_result = {"content": content}

        status_context: dict[str, Any] = {}
        status_task = payload.get("task")
        if isinstance(status_task, dict):
            status_context["task"] = status_task
        status_intent = payload.get("intent")
        if isinstance(status_intent, str) and status_intent.strip():
            status_context["intent"] = status_intent.strip()
        correlation_id = str(event.get("correlation_id") or "").strip()
        if correlation_id:
            status_context["correlationId"] = correlation_id

        logger.debug(
            "a2a: status received summary=%s normalized_status=%s",
            _a2a_event_summary(event),
            new_status,
        )

        if not delegation_id or not new_status:
            logger.warning("a2a: status passthrough missing delegation_id or status, skipping")
            return

        allowed_statuses = {"created", "dispatched", "received", "running", "done", "failed", "timeout"}
        if new_status not in allowed_statuses:
            logger.warning(
                "a2a: status passthrough unknown status delegation_id=%s status=%s",
                delegation_id, new_status,
            )
            return

        target = to_agent or str(settings.a2a_agent_id or "")
        ws_sent = 0

        try:
            from .services.a2a_ws import get_a2a_ws_hub

            ws_result = await get_a2a_ws_hub().publish_a2a_update(
                delegation_id=delegation_id,
                status=new_status,
                from_agent=from_agent,
                target_agent=target,
                result=normalized_result,
                error=error if isinstance(error, str) else None,
                context=status_context or None,
                agent_id=target,
            )
            delivery = ws_result.get("delivery") if isinstance(ws_result, dict) else {}
            ws_sent = int((delivery or {}).get("sent") or 0)
            logger.debug(
                "a2a: status ws publish delegation_id=%s status=%s target=%s sent=%s failed=%s",
                delegation_id,
                new_status,
                target,
                ws_sent,
                int((delivery or {}).get("failed") or 0),
            )
        except Exception as exc:
            logger.warning(
                "a2a: status ws publish failed delegation_id=%s status=%s: %s",
                delegation_id,
                new_status,
                exc,
            )

        if ws_sent > 0:
            return

        if not (
            settings.web_push_enabled
            and settings.web_push_vapid_private_key
            and settings.web_push_vapid_subject
        ):
            return

        try:
            from .services.push import publish_a2a_push_update

            logger.debug(
                "a2a: status push start delegation_id=%s status=%s target=%s has_result=%s result_content_len=%s has_error=%s",
                delegation_id,
                new_status,
                target,
                isinstance(normalized_result, dict),
                len(str((normalized_result or {}).get("content") or "")) if isinstance(normalized_result, dict) else 0,
                isinstance(error, str) and bool(error),
            )
            push_result = await publish_a2a_push_update(
                delegation_id=delegation_id,
                status=new_status,
                from_agent=from_agent,
                target_agent=target,
                result=normalized_result,
                error=error if isinstance(error, str) else None,
                context=status_context or None,
                agent_id=target,
                vapid_private_key=str(settings.web_push_vapid_private_key or ""),
                vapid_subject=str(settings.web_push_vapid_subject or ""),
                ttl=60,
            )
            delivery = push_result.get("delivery") if isinstance(push_result, dict) else {}
            logger.debug(
                "a2a: status push done delegation_id=%s status=%s target=%s sent=%s failed=%s",
                delegation_id,
                new_status,
                target,
                int((delivery or {}).get("sent") or 0),
                int((delivery or {}).get("failed") or 0),
            )
        except Exception as exc:
            logger.warning(
                "a2a: status passthrough push failed delegation_id=%s status=%s: %s",
                delegation_id, new_status, exc,
            )

    await transport.start_consumers(
        delegation_handler=_delegation_handler,
        status_handler=_status_handler,
    )

    # Registration refresh loop (TTL=120, refresh every 60s = TTL/2)
    async def _registration_refresh() -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await discovery.register_agent(
                    agent_id=str(settings.a2a_agent_id),
                    ttl=120,
                )
                logger.debug("a2a: registration refreshed for %s", settings.a2a_agent_id)
            except Exception as exc:
                logger.warning("a2a: registration refresh failed: %s", exc)

    asyncio.create_task(_registration_refresh(), name="a2a-registration-refresh")


    logger.info(
        "a2a: startup complete agent_id=%s inbound_selector=%s transport_backend=%s",
        settings.a2a_agent_id,
        settings.a2a_inbound_agent_pattern,
        settings.a2a_transport_backend,
    )


async def _a2a_shutdown(settings: Settings) -> None:
    from .services.a2a_transport import get_transport
    from .services.discovery_client import get_discovery_client

    discovery = get_discovery_client()
    if discovery:
        try:
            await discovery.deregister_agent(str(settings.a2a_agent_id))
            logger.info("a2a: deregistered from discovery")
        except Exception as exc:
            logger.warning("a2a: deregistration failed: %s", exc)

    transport = get_transport()
    if transport:
        try:
            await transport.disconnect()
        except Exception as exc:
            logger.warning("a2a: transport disconnect failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    register_builtin_tools(include_if_exists=True)

    await _a2a_startup(settings)

    yield

    await _a2a_shutdown(settings)


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router, prefix="/api")

    project_root = Path(__file__).resolve().parents[2]
    frontend_dist = project_root / "frontend" / "dist"
    spa_index = frontend_dist / "index.html"

    @app.get("/", tags=["meta"], response_model=None)
    async def root():
        if spa_index.exists():
            return FileResponse(spa_index)
        return JSONResponse(
            {
                "service": settings.app_name,
                "status": "ok",
                "frontend": "not_built",
                "hint": "Build frontend to frontend/dist to enable SPA serving.",
            }
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        if (
            full_path.startswith("api/")
            or full_path in {"api", "docs", "redoc", "openapi.json"}
        ):
            return JSONResponse({"detail": "Not Found"}, status_code=404)

        if not frontend_dist.exists() or not spa_index.exists():
            return JSONResponse({"detail": "Frontend not built"}, status_code=404)

        requested = frontend_dist / full_path
        if requested.is_file():
            return FileResponse(requested)

        return FileResponse(spa_index)

    return app


app = create_app()

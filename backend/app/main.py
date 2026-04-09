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


async def _a2a_startup(settings: Settings) -> None:
    from .services.a2a_protocol import validate_envelope
    from .services.a2a_transport import init_transport
    from .services.delegation_store import get_delegation_store
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
        max_deliver=settings.a2a_max_deliver,
        ack_wait_seconds=settings.a2a_ack_wait_seconds,
    )

    try:
        await transport.connect()
    except Exception as exc:
        logger.error("a2a: transport connect failed: %s — A2A will be unavailable", exc)
        return

    # Inbound delegation consumer handler
    async def _delegation_handler(envelope: dict[str, Any]) -> None:
        try:
            validate_envelope(
                envelope,
                self_agent_id=str(settings.a2a_agent_id),
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
        await run_inbound_delegation(envelope, settings)

    # Inbound status consumer handler — accepts nanobot flat format:
    # {"event_id": ..., "delegation_id": ..., "status": ..., "from_agent": ..., "payload": {...}}
    async def _status_handler(event: dict[str, Any]) -> None:
        delegation_id = str(event.get("delegation_id") or "")
        # event_id is nanobot's field; message_id is webagent's — accept both
        message_id = str(event.get("event_id") or event.get("message_id") or "")
        new_status = str(event.get("status") or "")
        payload = event.get("payload") or {}
        result = payload.get("result")
        error = payload.get("error")

        if not delegation_id or not new_status:
            logger.warning("a2a: status event missing delegation_id or status, skipping")
            return

        store = get_delegation_store()
        store.transition(
            delegation_id, new_status,
            message_id=message_id,
            result=result,
            error=error,
        )
        logger.info(
            "a2a: status update delegation_id=%s status=%s event_id=%s",
            delegation_id, new_status, message_id,
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

    # Timeout watchdog: transitions stuck delegations to "timeout"
    timeout_seconds = settings.a2a_execution_timeout_seconds

    async def _timeout_watchdog() -> None:
        from .services.delegation_store import TERMINAL_STATUSES
        import time as _time
        while True:
            await asyncio.sleep(30)
            try:
                store = get_delegation_store()
                now = _time.time()
                for record in store.list_records(limit=10_000):
                    if record.status in TERMINAL_STATUSES:
                        continue
                    age = now - record.created_at.timestamp()
                    if age > timeout_seconds:
                        store.transition(record.delegation_id, "timeout")
                        logger.warning(
                            "a2a: watchdog timed out delegation_id=%s age=%.0fs",
                            record.delegation_id, age,
                        )
            except Exception as exc:
                logger.error("a2a: timeout watchdog error: %s", exc)

    asyncio.create_task(_timeout_watchdog(), name="a2a-timeout-watchdog")
    logger.info("a2a: startup complete agent_id=%s", settings.a2a_agent_id)


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

    if settings.a2a_enabled:
        await _a2a_startup(settings)

    yield

    if settings.a2a_enabled:
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

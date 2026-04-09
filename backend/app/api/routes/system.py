from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import PlainTextResponse

from ...core.config import Settings, get_settings

router = APIRouter(tags=["system"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


@router.get("/metrics")
async def prometheus_metrics() -> PlainTextResponse:
    """Prometheus text-format metrics scrape endpoint."""
    try:
        from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
        return PlainTextResponse(
            content=generate_latest().decode("utf-8"),
            media_type=CONTENT_TYPE_LATEST,
        )
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="prometheus_client is not installed",
        )

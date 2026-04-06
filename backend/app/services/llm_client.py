from __future__ import annotations

from functools import lru_cache
from typing import Any

from openai import AsyncOpenAI, OpenAI

from ..core.config import Settings, get_settings


def _client_kwargs(
    settings: Settings,
    *,
    openai_base_url_override: str | None = None,
) -> dict[str, Any]:
    effective_base_url = (openai_base_url_override or "").strip() or settings.openai_base_url
    api_key = settings.openai_api_key

    # OpenAI-compatible backends behind custom base_url often do not require an API key.
    # The OpenAI SDK still expects one, so provide a harmless placeholder in that case.
    if not api_key and effective_base_url:
        api_key = "not-needed"

    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not configured. Set it in environment or .env before starting the API."
        )

    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "timeout": settings.request_timeout_seconds,
    }

    if effective_base_url:
        kwargs["base_url"] = effective_base_url

    return kwargs


@lru_cache(maxsize=1)
def _cached_openai_client() -> OpenAI:
    settings = get_settings()
    return OpenAI(**_client_kwargs(settings))


@lru_cache(maxsize=1)
def _cached_async_openai_client() -> AsyncOpenAI:
    settings = get_settings()
    return AsyncOpenAI(**_client_kwargs(settings))


def get_openai_client(
    settings: Settings | None = None,
    *,
    openai_base_url_override: str | None = None,
) -> OpenAI:
    """
    Return a sync OpenAI client.

    - Uses a cached singleton when called without explicit settings and no base URL override.
    - Creates an uncached instance when explicit settings are provided or a base URL override is set.
    """
    if settings is None and not (openai_base_url_override or "").strip():
        return _cached_openai_client()

    cfg = settings or get_settings()
    return OpenAI(
        **_client_kwargs(
            cfg,
            openai_base_url_override=openai_base_url_override,
        )
    )


def get_async_openai_client(
    settings: Settings | None = None,
    *,
    openai_base_url_override: str | None = None,
) -> AsyncOpenAI:
    """
    Return an async OpenAI client.

    - Uses a cached singleton when called without explicit settings and no base URL override.
    - Creates an uncached instance when explicit settings are provided or a base URL override is set.
    """
    if settings is None and not (openai_base_url_override or "").strip():
        return _cached_async_openai_client()

    cfg = settings or get_settings()
    return AsyncOpenAI(
        **_client_kwargs(
            cfg,
            openai_base_url_override=openai_base_url_override,
        )
    )


def resolve_model(request_model: str | None, settings: Settings | None = None) -> str:
    """
    Resolve effective model name for an agent turn.
    """
    cfg = settings or get_settings()
    return (request_model or cfg.openai_model).strip()
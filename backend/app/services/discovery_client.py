"""
Discovery client: register/discover agents via the discovery service.

Lifecycle (managed by main.py):
  - register_agent() called on app startup
  - refresh every TTL/2 via background task
  - deregister_agent() called on graceful shutdown
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_ROUTE_TTL = 60  # seconds


def _pick_least_loaded(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """
    Return the candidate with the lowest load score.

    Checks ``load`` then ``activeCount`` fields; defaults to 0 when absent so
    a candidate without load info is treated as equally unloaded and the first
    such candidate wins (stable sort).
    """
    if not candidates:
        return None

    def _load(c: dict[str, Any]) -> float:
        val = c.get("load") if "load" in c else c.get("activeCount", 0)
        try:
            return float(val or 0)
        except (TypeError, ValueError):
            return 0.0

    return min(candidates, key=_load)


class DiscoveryClient:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 5.0,
        retries: int = 3,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._retries = retries
        # Route TTL cache: key -> {"route": dict, "cached_at": float, "ttl": int}
        self._route_cache: dict[str, dict[str, Any]] = {}

    async def register_agent(
        self,
        *,
        agent_id: str,
        capabilities: list[str] | None = None,
        endpoint: str | None = None,
        metadata: dict[str, Any] | None = None,
        ttl: int = 120,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"agentId": agent_id, "ttl": ttl}
        if capabilities:
            payload["capabilities"] = capabilities
        if endpoint:
            payload["endpoint"] = endpoint
        if metadata:
            payload["metadata"] = metadata
        return await self._post("/register", payload)

    async def deregister_agent(self, agent_id: str) -> dict[str, Any]:
        return await self._post("/deregister", {"agentId": agent_id})

    async def discover_route(
        self,
        *,
        target_agent: str | None = None,
        intent: str | None = None,
        capabilities: list[str] | None = None,
    ) -> Optional[dict[str, Any]]:
        """
        Resolve a single best-match route for the given target/intent/capabilities.

        If the discovery service returns multiple candidates, the least-loaded one
        (lowest ``load`` or ``activeCount`` field) is selected as the tiebreak.
        Returns cached result within TTL; None on failure.
        """
        cache_key = f"{target_agent}:{intent}:{capabilities}"
        cached = self._route_cache.get(cache_key)
        if cached:
            age = time.time() - cached["cached_at"]
            if age < cached["ttl"]:
                return cached["route"]

        params: dict[str, str] = {}
        if target_agent:
            params["agentId"] = target_agent
        if intent:
            params["intent"] = intent
        if capabilities:
            params["capabilities"] = ",".join(capabilities)

        try:
            result = await self._get("/discover", params=params)

            # Discovery may return one route or a candidates array.
            candidates: list[dict[str, Any]] = []
            if isinstance(result.get("candidates"), list):
                candidates = [c for c in result["candidates"] if isinstance(c, dict)]
            elif isinstance(result.get("route"), dict):
                candidates = [result["route"]]
            elif isinstance(result, dict) and result.get("agentId"):
                candidates = [result]

            route = _pick_least_loaded(candidates) if candidates else None

            self._route_cache[cache_key] = {
                "route": route,
                "cached_at": time.time(),
                "ttl": int(result.get("ttl") or _DEFAULT_ROUTE_TTL),
            }
            return route
        except Exception as exc:
            logger.warning("discovery: discover_route failed: %s", exc)
            return None

    async def get_agent(self, agent_id: str) -> Optional[dict[str, Any]]:
        try:
            return await self._get(f"/agent/{agent_id}")
        except Exception as exc:
            logger.warning("discovery: get_agent(%s) failed: %s", agent_id, exc)
            return None

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(self._retries):
            try:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    res = await client.post(url, json=payload)
                    res.raise_for_status()
                    return res.json()
            except Exception as exc:
                last_exc = exc
                if attempt < self._retries - 1:
                    await asyncio.sleep(0.5 * (attempt + 1))
        raise RuntimeError(
            f"Discovery POST {path} failed after {self._retries} attempts: {last_exc}"
        ) from last_exc

    async def _get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(self._retries):
            try:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    res = await client.get(url, params=params)
                    res.raise_for_status()
                    return res.json()
            except Exception as exc:
                last_exc = exc
                if attempt < self._retries - 1:
                    await asyncio.sleep(0.5 * (attempt + 1))
        raise RuntimeError(
            f"Discovery GET {path} failed after {self._retries} attempts: {last_exc}"
        ) from last_exc


# Module-level singleton
_discovery_client: Optional[DiscoveryClient] = None


def get_discovery_client() -> Optional[DiscoveryClient]:
    return _discovery_client


def init_discovery_client(base_url: str, **kwargs: Any) -> DiscoveryClient:
    global _discovery_client
    _discovery_client = DiscoveryClient(base_url, **kwargs)
    return _discovery_client

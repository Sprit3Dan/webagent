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
from urllib.parse import urlsplit

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


def _normalize_candidate(candidate: dict[str, Any]) -> dict[str, Any] | None:
    route_raw = candidate.get("route")
    route_dict: dict[str, Any] = route_raw if isinstance(route_raw, dict) else {}

    merged: dict[str, Any] = dict(route_dict)
    merged.update(candidate)

    agent_id = str(
        merged.get("agent_id")
        or merged.get("agentId")
        or candidate.get("agent_id")
        or candidate.get("agentId")
        or ""
    ).strip()
    if not agent_id:
        return None

    normalized = dict(candidate)
    normalized["agent_id"] = agent_id
    normalized["agentId"] = agent_id

    if route_dict.get("base_url") and not normalized.get("base_url"):
        normalized["base_url"] = route_dict["base_url"]
    if route_dict.get("host") and not normalized.get("host"):
        normalized["host"] = route_dict["host"]
    if route_dict.get("port") and not normalized.get("port"):
        normalized["port"] = route_dict["port"]
    if route_dict.get("service_name") and not normalized.get("service_name"):
        normalized["service_name"] = route_dict["service_name"]

    return normalized


def _normalize_registration_candidate(
    *,
    key: str,
    record: dict[str, Any],
) -> dict[str, Any] | None:
    agent_id = str(record.get("agent_id") or key or "").strip()
    if not agent_id:
        return None

    address_raw = record.get("address")
    route_raw = record.get("route")
    address: dict[str, Any] = address_raw if isinstance(address_raw, dict) else {}
    route: dict[str, Any] = route_raw if isinstance(route_raw, dict) else {}

    base_url = str(route.get("base_url") or address.get("base_url") or "").strip()
    host = str(route.get("host") or "").strip()
    port = route.get("port")

    if base_url and (not host or not port):
        try:
            parsed = urlsplit(base_url)
            host = host or str(parsed.hostname or "").strip()
            port = port or parsed.port
        except Exception:
            pass

    normalized: dict[str, Any] = {
        "agent_id": agent_id,
        "agentId": agent_id,
        "transport": record.get("transport"),
        "protocol": record.get("protocol"),
        "registered_at": record.get("registered_at"),
        "capabilities": record.get("capabilities") if isinstance(record.get("capabilities"), dict) else {},
    }

    if base_url:
        normalized["base_url"] = base_url
    if host:
        normalized["host"] = host
    if port:
        normalized["port"] = port
    if route.get("service_name"):
        normalized["service_name"] = route["service_name"]

    return normalized


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
        payload: dict[str, Any] = {
            "agent_id": agent_id,
            "transport": "nats",
            "protocol": "a2a",
        }
        if endpoint:
            payload["address"] = {"base_url": endpoint}
        if capabilities:
            payload["capabilities"] = {
                "skills": [{"name": c} for c in capabilities]
            }
        if metadata:
            payload["metadata"] = metadata
        if ttl > 0:
            payload["ttl"] = ttl
        return await self._post("/register", payload)

    async def deregister_agent(self, agent_id: str) -> dict[str, Any]:
        payload = {"agent_id": agent_id}
        paths = ("/deregister", "/unregister")
        for path in paths:
            try:
                return await self._post(path, payload)
            except Exception as exc:
                logger.debug("discovery: %s failed for %s: %s", path, agent_id, exc)

        logger.info(
            "discovery: no deregister endpoint; skipping deregistration for %s",
            agent_id,
        )
        return {
            "ok": True,
            "deregistered": False,
            "skipped": True,
            "agent_id": agent_id,
            "reason": "endpoint_unavailable",
        }

    async def discover_candidates(
        self,
        *,
        target_agent: str | None = None,
        intent: str | None = None,
        capabilities: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Resolve matching discovery candidates for the given target/intent/capabilities.

        Returns normalized candidate route dicts from /discover only.
        """
        params: dict[str, str] = {}
        if target_agent:
            params["target_agent"] = target_agent
        if intent:
            params["intent"] = intent
        if capabilities:
            params["capabilities"] = ",".join(capabilities)

        normalized: list[dict[str, Any]] = []
        try:
            result = await self._get("/discover", params=params)

            raw_candidates: list[dict[str, Any]] = []
            if isinstance(result.get("candidates"), list):
                raw_candidates = [c for c in result["candidates"] if isinstance(c, dict)]
            elif isinstance(result.get("route"), dict):
                raw_candidates = [result["route"]]
            elif isinstance(result, dict) and (
                result.get("agent_id")
                or result.get("agentId")
                or result.get("base_url")
            ):
                raw_candidates = [result]

            for raw in raw_candidates:
                candidate = _normalize_candidate(raw)
                if candidate:
                    normalized.append(candidate)

            if normalized:
                return normalized
        except Exception as exc:
            logger.warning("discovery: discover_candidates failed: %s", exc)

        fallback_candidates = await self.list_registration_candidates(
            target_agent=target_agent,
            intent=intent,
            capabilities=capabilities,
        )
        if fallback_candidates:
            return fallback_candidates

        return []

    async def list_registration_candidates(
        self,
        *,
        target_agent: str | None = None,
        intent: str | None = None,
        capabilities: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        List candidates from discovery registrations and normalize to route-like dicts.
        """
        try:
            result = await self._get("/registrations")
        except Exception as exc:
            logger.warning("discovery: list_registration_candidates failed: %s", exc)
            return []

        raw_items = result.get("items")
        if not isinstance(raw_items, dict):
            return []

        intent_lc = str(intent or "").strip().lower()
        capability_needles = [str(item).strip().lower() for item in (capabilities or []) if str(item).strip()]

        candidates: list[dict[str, Any]] = []
        for key, raw in raw_items.items():
            if not isinstance(raw, dict):
                continue

            candidate = _normalize_registration_candidate(key=str(key), record=raw)
            if not candidate:
                continue

            agent_id = str(candidate.get("agent_id") or "")
            if target_agent and agent_id != str(target_agent).strip():
                continue

            capabilities_raw = candidate.get("capabilities")
            caps: dict[str, Any] = capabilities_raw if isinstance(capabilities_raw, dict) else {}
            skills_raw = caps.get("skills")
            skills: list[dict[str, Any]] = [s for s in skills_raw if isinstance(s, dict)] if isinstance(skills_raw, list) else []

            skill_names = " ".join(str(s.get("name") or "") for s in skills)
            tag_chunks: list[str] = []
            for s in skills:
                tags_raw = s.get("tags")
                tags: list[str] = [str(tag) for tag in tags_raw if isinstance(tag, str)] if isinstance(tags_raw, list) else []
                if tags:
                    tag_chunks.append(" ".join(tags))
            skill_tags = " ".join(tag_chunks)

            skill_text = " ".join(
                [
                    str(agent_id),
                    str(caps.get("description") or ""),
                    skill_names,
                    skill_tags,
                ]
            ).lower()

            if intent_lc and intent_lc not in skill_text:
                continue

            if capability_needles and not all(needle in skill_text for needle in capability_needles):
                continue

            candidates.append(candidate)

        return candidates

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
            params["target_agent"] = target_agent
        if intent:
            params["intent"] = intent
        if capabilities:
            params["capabilities"] = ",".join(capabilities)

        try:
            result = await self._get("/discover", params=params)
            candidates = await self.discover_candidates(
                target_agent=target_agent,
                intent=intent,
                capabilities=capabilities,
            )
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

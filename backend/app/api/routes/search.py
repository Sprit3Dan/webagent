from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote_plus

import httpx
from fastapi import APIRouter, HTTPException, status

router = APIRouter(tags=["search"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_search_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _format_search_items(items: list[dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in items:
        url = str(item.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)

        title = _normalize_search_text(item.get("title") or url)
        snippet = _normalize_search_text(item.get("snippet") or "")
        out.append({
            "title": title,
            "url": url,
            "snippet": snippet,
            "source": str(item.get("source") or "duckduckgo"),
        })
        if len(out) >= top_k:
            break

    return out


async def _ddg_search(query: str, top_k: int) -> list[dict[str, Any]]:
    try:
        from ddgs import DDGS  # type: ignore

        def _run() -> list[dict[str, Any]]:
            ddgs = DDGS(timeout=10)
            raw = ddgs.text(query, max_results=top_k)
            if not raw:
                return []
            return [
                {
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "snippet": r.get("body", ""),
                    "source": "duckduckgo",
                }
                for r in raw
            ]

        return await __import__("asyncio").to_thread(_run)
    except Exception:
        return []


async def _ddg_instant_fallback(query: str, top_k: int) -> list[dict[str, Any]]:
    url = f"https://api.duckduckgo.com/?q={quote_plus(query)}&format=json&no_html=1&skip_disambig=1"
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(url, headers={"accept": "application/json"})
        res.raise_for_status()
        data = res.json()

    items: list[dict[str, Any]] = []

    abstract = _normalize_search_text(data.get("AbstractText") or data.get("Answer") or "")
    abstract_url = str(data.get("AbstractURL") or "").strip()
    if abstract and abstract_url:
        items.append({
            "title": _normalize_search_text(data.get("Heading") or "Instant Answer"),
            "url": abstract_url,
            "snippet": abstract,
            "source": "duckduckgo_instant",
        })

    def _visit_related(related: list[Any]) -> None:
        for node in related:
            if len(items) >= top_k:
                return
            if isinstance(node, dict) and isinstance(node.get("Topics"), list):
                _visit_related(node["Topics"])
                continue
            if not isinstance(node, dict):
                continue

            link = str(node.get("FirstURL") or "").strip()
            text = _normalize_search_text(node.get("Text") or "")
            if not link or not text:
                continue

            parts = text.split(" - ")
            title = _normalize_search_text(parts[0] if parts else link)
            snippet = _normalize_search_text(" - ".join(parts[1:]) if len(parts) > 1 else text)
            items.append({
                "title": title,
                "url": link,
                "snippet": snippet,
                "source": "duckduckgo_instant",
            })

    related_topics = data.get("RelatedTopics")
    if isinstance(related_topics, list):
        _visit_related(related_topics)

    return items


@router.post("/web/search")
async def web_search(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    query = _normalize_search_text(body.get("query") or "")
    if not query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="query is required",
        )

    top_k = max(1, min(10, int(body.get("topK") or body.get("count") or 5)))

    items = await _ddg_search(query, top_k)
    if not items:
        try:
            items = await _ddg_instant_fallback(query, top_k)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"DuckDuckGo search failed: {exc}",
            ) from exc

    results = _format_search_items(items, top_k)

    return {
        "ok": True,
        "query": query,
        "count": len(results),
        "results": results,
        "source": "duckduckgo",
        "fetchedAt": _iso_now(),
    }

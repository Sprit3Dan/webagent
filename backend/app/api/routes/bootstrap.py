from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["bootstrap"])


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bootstrap_root() -> Path:
    return Path(__file__).resolve().parents[2] / "static" / "bootstrap"


def _read_text_or_default(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return default


def _read_json_or_default(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else dict(default)
    except Exception:
        return dict(default)


def _load_context_bootstrap_files() -> list[dict[str, str]]:
    context_dir = _bootstrap_root() / "context"
    names = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    return [
        {"name": name, "content": _read_text_or_default(context_dir / name, "")}
        for name in names
    ]


def _load_skills_bootstrap_payload() -> dict[str, Any]:
    skills_file = _bootstrap_root() / "skills" / "default-skills.json"
    fallback: dict[str, Any] = {"version": 1, "skills": []}
    parsed = _read_json_or_default(skills_file, fallback)
    if "version" not in parsed:
        parsed["version"] = 1
    if not isinstance(parsed.get("skills"), list):
        parsed["skills"] = []
    return parsed


@router.get("/context/bootstrap")
async def context_bootstrap() -> dict[str, Any]:
    return {
        "version": 1,
        "generatedAt": _iso_now(),
        "files": _load_context_bootstrap_files(),
    }


@router.get("/skills/bootstrap")
async def skills_bootstrap() -> dict[str, Any]:
    payload = _load_skills_bootstrap_payload()
    return {
        "version": int(payload.get("version") or 1),
        "generatedAt": _iso_now(),
        "skills": payload.get("skills") if isinstance(payload.get("skills"), list) else [],
    }

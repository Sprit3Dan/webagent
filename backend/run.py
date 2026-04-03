from __future__ import annotations

import importlib
import os
import sys

import uvicorn


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    app_module = os.getenv("APP_MODULE", "app.main:app")
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    reload_enabled = _env_bool("RELOAD", default=True)

    module_name = app_module.split(":", 1)[0]
    try:
        importlib.import_module(module_name)
    except Exception as exc:
        print(f"Failed to import module '{module_name}' from APP_MODULE='{app_module}'.", file=sys.stderr)
        print(f"Import error: {exc}", file=sys.stderr)
        print("Hint: create app/main.py with a FastAPI 'app' object.", file=sys.stderr)
        return 1

    uvicorn.run(
        app_module,
        host=host,
        port=port,
        log_level=log_level,
        reload=reload_enabled,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
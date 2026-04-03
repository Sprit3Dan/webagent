from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api.routes import router as api_router
from .core.config import get_settings
from .services.tools import register_builtin_tools


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_builtin_tools(include_if_exists=True)
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
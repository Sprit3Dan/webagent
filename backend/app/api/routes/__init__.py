from fastapi import APIRouter

from .a2a import router as a2a_router
from .agent import router as agent_router
from .bootstrap import router as bootstrap_router
from .push import router as push_router
from .search import router as search_router
from .system import router as system_router

router = APIRouter()
router.include_router(system_router)
router.include_router(bootstrap_router)
router.include_router(search_router)
router.include_router(push_router)
router.include_router(agent_router)
router.include_router(a2a_router)

__all__ = ["router"]

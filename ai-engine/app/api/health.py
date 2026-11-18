import sys
import os
import platform
import resource
from fastapi import APIRouter
from app.core.config import settings
from app.schemas.image import HealthResponse
from app.services.image_processor import image_processor
from app.engines.generative import FalAIProvider

router = APIRouter(tags=["Health"])


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Service health check returning service operational status,
    supported filter algorithms, provider status, and platform resource stats.
    """
    fal_provider = FalAIProvider()

    # Get process memory usage (resident set size) via standard library
    max_rss_mb = 0.0
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # On macOS ru_maxrss is in bytes, on Linux in kilobytes
        if sys.platform == "darwin":
            max_rss_mb = round(usage.ru_maxrss / (1024 * 1024), 2)
        else:
            max_rss_mb = round(usage.ru_maxrss / 1024, 2)
    except Exception:
        max_rss_mb = 0.0

    return HealthResponse(
        status="healthy",
        version="1.0.0",
        supported_filters=image_processor.get_supported_filters(),
        generative_provider=settings.GENERATIVE_PROVIDER,
        system={
            "platform": platform.platform(),
            "python_version": platform.python_version(),
            "max_concurrent_tasks": settings.MAX_CONCURRENT_TASKS,
            "max_timeout_sec": settings.MAX_PROCESSING_TIMEOUT_SEC,
            "fal_ai_status": fal_provider.get_status(),
            "process_rss_mb": max_rss_mb
        }
    )

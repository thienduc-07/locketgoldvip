import time
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from app.schemas.image import FilterProcessResponse, FilterType
from app.services.image_processor import image_processor
from app.services.image_validator import ImageValidationError

router = APIRouter(prefix="/api/v1/filters", tags=["Filters"])


@router.get("", response_model=List[Dict[str, Any]])
async def list_filters():
    """
    Returns the comprehensive catalog of all 6 supported filters,
    including algorithm category, technical descriptions, and execution providers.
    """
    return image_processor.get_filters_metadata()


@router.post("/process", response_model=FilterProcessResponse)
async def process_filter(
    file: UploadFile = File(..., description="Uploaded image file (JPEG, PNG, WebP)"),
    filter_id: str = Form(..., description="Target filter identifier (e.g. beard, glasses, beauty_makeup, anime, cartoon, chibi_3d)"),
    intensity: float = Form(1.0, ge=0.0, le=1.0, description="Effect intensity from 0.0 to 1.0"),
    preview_mode: bool = Form(False, description="Enable low-latency preview mode (downscales input to <=512px)")
):
    """
    Processes an uploaded image through the selected computer vision / generative filter.
    Enforces MIME signature validation, dimension bounds, processing timeouts,
    and automatic memory/temp cleanup.
    """
    upload_start = time.perf_counter()
    try:
        image_bytes = await file.read()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read upload payload: {str(e)}"
        )
    upload_duration = (time.perf_counter() - upload_start) * 1000.0

    # Execute image processor orchestration
    response = await image_processor.process_image(
        image_bytes=image_bytes,
        filter_id=filter_id,
        upload_duration_ms=upload_duration,
        intensity=intensity,
        preview_mode=preview_mode
    )

    if response.status == "failed":
        # Check if client error (validation) vs server error
        err_msg = (response.error or "").lower()
        if (
            "unsupported filter id" in err_msg
            or "signature" in err_msg
            or "dimensions" in err_msg
            or "exceeds maximum" in err_msg
            or "corrupted or unreadable" in err_msg
            or "empty" in err_msg
        ):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)
        elif "timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    return response


@router.post("/preview", response_model=FilterProcessResponse)
async def preview_filter(
    file: UploadFile = File(..., description="Uploaded image file (JPEG, PNG, WebP)"),
    filter_id: str = Form(..., description="Target filter identifier"),
    intensity: float = Form(1.0, ge=0.0, le=1.0, description="Effect intensity from 0.0 to 1.0")
):
    """
    Fast preview endpoint: automatically downscales the image to <=512px
    to deliver instant visual feedback (<100ms latency).
    """
    upload_start = time.perf_counter()
    try:
        image_bytes = await file.read()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read upload payload: {str(e)}"
        )
    upload_duration = (time.perf_counter() - upload_start) * 1000.0

    response = await image_processor.process_image(
        image_bytes=image_bytes,
        filter_id=filter_id,
        upload_duration_ms=upload_duration,
        intensity=intensity,
        preview_mode=True
    )

    if response.status == "failed":
        if "Unsupported filter ID" in (response.error or "") or "signature" in (response.error or "") or "dimensions" in (response.error or ""):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    return response

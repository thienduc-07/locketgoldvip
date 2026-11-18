import time
from typing import List, Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from app.schemas.photobooth import (
    PhotoboothLayout,
    PhotoboothConfig,
    PhotoboothComposeResponse
)
from app.services.photobooth import photobooth_service

router = APIRouter(prefix="/api/v1/photobooth", tags=["Photobooth"])


@router.post("/compose", response_model=PhotoboothComposeResponse)
async def compose_photobooth(
    files: List[UploadFile] = File(..., description="Uploaded images (2 files for 2-cut, 4 files for 4-cut)"),
    layout: str = Form("4cut_strip", description="'2cut_vertical', '2cut_horizontal', '4cut_strip', '4cut_grid'"),
    background_color: str = Form("#FFFFFF", description="Hex background color (e.g. #FFFFFF, #FFD6E0, #000000)"),
    outer_margin: int = Form(36, ge=0, le=200, description="Outer border padding in pixels"),
    inner_spacing: int = Form(20, ge=0, le=100, description="Spacing between photo slots in pixels"),
    corner_radius: int = Form(0, ge=0, le=60, description="Corner radius for individual photos"),
    slot_width: int = Form(600, ge=100, le=2000, description="Width per photo cell"),
    slot_height: int = Form(450, ge=100, le=2000, description="Height per photo cell"),
    footer_space: int = Form(80, ge=0, le=300, description="Bottom footer margin for date/branding"),
    footer_text: Optional[str] = Form("LOCKET PHOTOBOOTH", description="Optional text printed in footer"),
    output_format: str = Form("jpeg", description="'jpeg' or 'png'"),
    output_quality: int = Form(92, ge=50, le=100, description="JPEG compression quality (1-100)")
):
    """
    Composes 2 or 4 photos into a classic or modern photobooth strip or grid.
    Preserves aspect ratios using smart center-weighted cropping.
    Supports customizable margins, backgrounds, typography, and format exports.
    """
    upload_start = time.perf_counter()

    # Validate layout enum string
    try:
        layout_enum = PhotoboothLayout(layout.lower())
    except ValueError:
        valid_layouts = [l.value for l in PhotoboothLayout]
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid layout '{layout}'. Must be one of: {valid_layouts}"
        )

    # Read uploaded images
    images_data: List[bytes] = []
    for f in files:
        try:
            b = await f.read()
            images_data.append(b)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to read uploaded photo: {str(e)}"
            )

    upload_duration = (time.perf_counter() - upload_start) * 1000.0

    config = PhotoboothConfig(
        layout=layout_enum,
        background_color=background_color,
        outer_margin=outer_margin,
        inner_spacing=inner_spacing,
        corner_radius=corner_radius,
        slot_width=slot_width,
        slot_height=slot_height,
        footer_space=footer_space,
        footer_text=footer_text,
        output_format=output_format,
        output_quality=output_quality
    )

    response = await photobooth_service.compose(
        images_data=images_data,
        config=config,
        upload_duration_ms=upload_duration
    )

    if response.status == "failed":
        if "requires exactly" in (response.error or "") or "validation failed" in (response.error or ""):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)
        elif "timeout" in (response.error or "").lower():
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    return response

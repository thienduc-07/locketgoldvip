from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field
from app.schemas.image import ProcessingMetrics, ImageDimensions


class PhotoboothLayout(str, Enum):
    TWO_CUT_VERTICAL = "2cut_vertical"      # 1 column x 2 rows
    TWO_CUT_HORIZONTAL = "2cut_horizontal"  # 2 columns x 1 row
    FOUR_CUT_STRIP = "4cut_strip"          # 1 column x 4 rows (classic photobooth vertical strip)
    FOUR_CUT_GRID = "4cut_grid"            # 2 columns x 2 rows (square/classic polaroid 4-cut)


class PhotoboothConfig(BaseModel):
    layout: PhotoboothLayout = Field(
        default=PhotoboothLayout.FOUR_CUT_STRIP,
        description="Layout configuration: '2cut_vertical', '2cut_horizontal', '4cut_strip', '4cut_grid'"
    )
    background_color: str = Field(
        default="#FFFFFF",
        description="Hex background color (e.g. #FFFFFF, #FFD6E0, #1E1E24, #C4B5FD)"
    )
    outer_margin: int = Field(default=36, ge=0, le=200, description="Outer border padding in pixels")
    inner_spacing: int = Field(default=20, ge=0, le=100, description="Spacing between photo slots in pixels")
    corner_radius: int = Field(default=0, ge=0, le=60, description="Corner radius for individual photos")
    slot_width: int = Field(default=600, ge=100, le=2000, description="Target width per photo cell")
    slot_height: int = Field(default=450, ge=100, le=2000, description="Target height per photo cell")
    footer_space: int = Field(default=80, ge=0, le=300, description="Bottom footer margin for date/branding")
    footer_text: Optional[str] = Field(default="LOCKET PHOTOBOOTH", description="Optional text printed in footer")
    output_format: str = Field(default="jpeg", description="'jpeg' or 'png'")
    output_quality: int = Field(default=92, ge=50, le=100, description="JPEG compression quality (1-100)")


class PhotoboothComposeResponse(BaseModel):
    status: str = Field(..., description="'success' or 'failed'")
    session_id: str = Field(..., description="Unique processing session UUID")
    layout: str = Field(..., description="Applied photobooth layout name")
    photo_count: int = Field(..., description="Number of photos composed")
    output_image: Optional[str] = Field(None, description="Base64 encoded image data URI")
    dimensions: Optional[ImageDimensions] = None
    metrics: ProcessingMetrics
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)
    error: Optional[str] = None

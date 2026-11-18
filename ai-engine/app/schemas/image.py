from enum import Enum
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field


class FilterType(str, Enum):
    # P0 Priority
    BEARD = "beard"
    GLASSES = "glasses"
    BEAUTY_MAKEUP = "beauty_makeup"

    # P1 Priority
    ANIME = "anime"
    CARTOON = "cartoon"
    CHIBI_3D = "chibi_3d"


class ProcessingMetrics(BaseModel):
    upload_duration_ms: float = Field(..., description="Time taken to read file upload in milliseconds")
    validation_duration_ms: float = Field(..., description="Time taken to validate image format & dimensions in milliseconds")
    model_init_duration_ms: float = Field(..., description="Time taken to initialize or retrieve model in milliseconds")
    inference_duration_ms: float = Field(..., description="Inference & image filtering execution time in milliseconds")
    export_duration_ms: float = Field(..., description="Image encoding & base64 export time in milliseconds")
    total_duration_ms: float = Field(..., description="Total end-to-end processing time in milliseconds")


class ImageDimensions(BaseModel):
    width: int
    height: int


class FilterProcessResponse(BaseModel):
    status: str = Field(..., description="'success' or 'failed'")
    session_id: str = Field(..., description="Unique processing session UUID")
    filter_id: str = Field(..., description="Applied filter identifier")
    output_image: Optional[str] = Field(None, description="Base64 encoded JPEG data URI")
    dimensions: Optional[ImageDimensions] = None
    metrics: ProcessingMetrics
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Filter metadata and identity evaluation")
    error: Optional[str] = None


class ProcessURLRequest(BaseModel):
    image_url: str = Field(..., description="Public or Firebase storage URL of the input image")
    filter_id: str = Field(..., description="Target filter ID (e.g. beard, glasses, beauty_makeup, anime, cartoon, chibi_3d)")
    intensity: float = Field(0.85, ge=0.0, le=1.0, description="Effect intensity")
    preview_mode: bool = Field(False, description="Preview downscale mode")


class ProcessURLResponse(BaseModel):
    status: str = Field(..., description="'success' or 'failed'")
    session_id: str = Field(..., description="Unique processing session UUID")
    filter_id: str = Field(..., description="Applied filter identifier")
    output_url: Optional[str] = Field(None, description="Direct URL to fetch processed JPEG")
    dimensions: Optional[ImageDimensions] = None
    metrics: ProcessingMetrics
    error: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    version: str
    supported_filters: List[str]
    generative_provider: str
    system: Dict[str, Any]

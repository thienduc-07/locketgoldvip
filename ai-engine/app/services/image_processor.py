import io
import time
import uuid
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image
from typing import Dict, Any, List, Optional

from app.core.config import settings
from app.core.security import concurrency_limiter, temporary_working_directory
from app.services.image_validator import ImageValidator, ImageValidationError
from app.schemas.image import FilterProcessResponse, ProcessingMetrics, ImageDimensions, FilterType
from app.engines.base import BaseFilterEngine
from app.engines.accessories import GlassesFilterEngine, BeardFilterEngine
from app.engines.beauty import BeautyMakeupFilterEngine
from app.engines.generative import CartoonFilterEngine, AnimeFilterEngine, Chibi3DFilterEngine


class ImageProcessor:
    """
    Central orchestration service for image validation, filter application,
    metrics measurement, non-blocking thread execution, timeout enforcement,
    and privacy-preserving temporary storage.
    """
    def __init__(self):
        self.engines: Dict[str, BaseFilterEngine] = {
            FilterType.GLASSES.value: GlassesFilterEngine(),
            FilterType.BEARD.value: BeardFilterEngine(),
            FilterType.BEAUTY_MAKEUP.value: BeautyMakeupFilterEngine(),
            FilterType.CARTOON.value: CartoonFilterEngine(),
            FilterType.ANIME.value: AnimeFilterEngine(),
            FilterType.CHIBI_3D.value: Chibi3DFilterEngine(),
        }
        # Dedicated thread pool for non-blocking CPU-bound computer vision executions
        self._executor = ThreadPoolExecutor(
            max_workers=settings.MAX_CONCURRENT_TASKS,
            thread_name_prefix="cv_worker"
        )

    def get_supported_filters(self) -> List[str]:
        return list(self.engines.keys())

    def get_filters_metadata(self) -> List[Dict[str, Any]]:
        """Returns structured metadata for all registered filters (for GET /api/v1/filters)."""
        result = []
        for fid, eng in self.engines.items():
            result.append({
                "id": fid,
                "name": eng.name,
                "category": eng.category,
                "description": eng.description,
                "type": "accessory" if eng.category == "accessories" else ("beauty" if eng.category == "beauty" else "generative_2d"),
                "provider": "local_cv",
                "cost_usd": 0.0,
                "preview_supported": True
            })
        return result

    async def process_image(
        self,
        image_bytes: bytes,
        filter_id: str,
        upload_duration_ms: float = 0.0,
        intensity: float = 1.0,
        preview_mode: bool = False
    ) -> FilterProcessResponse:
        session_id = str(uuid.uuid4())
        total_start = time.perf_counter()

        # Check filter support upfront
        if filter_id not in self.engines:
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return FilterProcessResponse(
                status="failed",
                session_id=session_id,
                filter_id=filter_id,
                output_image=None,
                dimensions=None,
                metrics=ProcessingMetrics(
                    upload_duration_ms=round(upload_duration_ms, 2),
                    validation_duration_ms=0.0,
                    model_init_duration_ms=0.0,
                    inference_duration_ms=0.0,
                    export_duration_ms=0.0,
                    total_duration_ms=round(total_duration, 2)
                ),
                error=f"Unsupported filter ID '{filter_id}'. Supported filters: {self.get_supported_filters()}"
            )

        # 1. Validation Phase
        val_start = time.perf_counter()
        try:
            pil_img, mime, orig_w, orig_h = ImageValidator.validate_upload(image_bytes)
        except ImageValidationError as e:
            val_duration = (time.perf_counter() - val_start) * 1000.0
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return FilterProcessResponse(
                status="failed",
                session_id=session_id,
                filter_id=filter_id,
                output_image=None,
                dimensions=None,
                metrics=ProcessingMetrics(
                    upload_duration_ms=round(upload_duration_ms, 2),
                    validation_duration_ms=round(val_duration, 2),
                    model_init_duration_ms=0.0,
                    inference_duration_ms=0.0,
                    export_duration_ms=0.0,
                    total_duration_ms=round(total_duration, 2)
                ),
                error=str(e)
            )
        val_duration = (time.perf_counter() - val_start) * 1000.0

        # Downscale for preview mode if requested (Max 512px)
        if preview_mode:
            max_preview = 512
            if max(orig_w, orig_h) > max_preview:
                scale = max_preview / max(orig_w, orig_h)
                new_w, new_h = max(1, int(orig_w * scale)), max(1, int(orig_h * scale))
                pil_img = pil_img.resize((new_w, new_h), Image.Resampling.BILINEAR)

        img_np = np.array(pil_img)

        # 2. Model Initialization / Lookup Phase
        model_init_start = time.perf_counter()
        engine = self.engines[filter_id]
        model_init_duration = (time.perf_counter() - model_init_start) * 1000.0

        # 3. Inference / Filtering Phase (Protected by Concurrency Semaphore, Non-blocking Thread & Timeout)
        async with concurrency_limiter:
            with temporary_working_directory(prefix=f"locket_{session_id[:8]}_"):
                inf_start = time.perf_counter()
                loop = asyncio.get_running_loop()
                try:
                    # Offload CPU-bound OpenCV computation to thread pool to preserve event loop responsiveness
                    task = loop.run_in_executor(
                        self._executor,
                        engine.apply,
                        img_np,
                        intensity
                    )
                    processed_np, metadata = await asyncio.wait_for(
                        task,
                        timeout=settings.MAX_PROCESSING_TIMEOUT_SEC
                    )
                except asyncio.TimeoutError:
                    inf_duration = (time.perf_counter() - inf_start) * 1000.0
                    total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
                    return FilterProcessResponse(
                        status="failed",
                        session_id=session_id,
                        filter_id=filter_id,
                        output_image=None,
                        dimensions=ImageDimensions(width=pil_img.width, height=pil_img.height),
                        metrics=ProcessingMetrics(
                            upload_duration_ms=round(upload_duration_ms, 2),
                            validation_duration_ms=round(val_duration, 2),
                            model_init_duration_ms=round(model_init_duration, 2),
                            inference_duration_ms=round(inf_duration, 2),
                            export_duration_ms=0.0,
                            total_duration_ms=round(total_duration, 2)
                        ),
                        error=f"Processing timeout exceeded ({settings.MAX_PROCESSING_TIMEOUT_SEC}s)."
                    )
                except Exception as e:
                    inf_duration = (time.perf_counter() - inf_start) * 1000.0
                    total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
                    return FilterProcessResponse(
                        status="failed",
                        session_id=session_id,
                        filter_id=filter_id,
                        output_image=None,
                        dimensions=ImageDimensions(width=pil_img.width, height=pil_img.height),
                        metrics=ProcessingMetrics(
                            upload_duration_ms=round(upload_duration_ms, 2),
                            validation_duration_ms=round(val_duration, 2),
                            model_init_duration_ms=round(model_init_duration, 2),
                            inference_duration_ms=round(inf_duration, 2),
                            export_duration_ms=0.0,
                            total_duration_ms=round(total_duration, 2)
                        ),
                        error=f"Filter processing error: {str(e)}"
                    )
                inf_duration = (time.perf_counter() - inf_start) * 1000.0

                # 4. Output Validation & Base64 Export Phase
                export_start = time.perf_counter()
                try:
                    out_pil = ImageValidator.validate_output(processed_np)
                except ImageValidationError as e:
                    export_duration = (time.perf_counter() - export_start) * 1000.0
                    total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
                    return FilterProcessResponse(
                        status="failed",
                        session_id=session_id,
                        filter_id=filter_id,
                        output_image=None,
                        dimensions=None,
                        metrics=ProcessingMetrics(
                            upload_duration_ms=round(upload_duration_ms, 2),
                            validation_duration_ms=round(val_duration, 2),
                            model_init_duration_ms=round(model_init_duration, 2),
                            inference_duration_ms=round(inf_duration, 2),
                            export_duration_ms=round(export_duration, 2),
                            total_duration_ms=round(total_duration, 2)
                        ),
                        error=f"Output validation failed: {str(e)}"
                    )

                bio_out = io.BytesIO()
                out_pil.save(bio_out, format="JPEG", quality=92, optimize=True)
                encoded_bytes = bio_out.getvalue()
                b64_str = base64.b64encode(encoded_bytes).decode("ascii")
                data_uri = f"data:image/jpeg;base64,{b64_str}"
                export_duration = (time.perf_counter() - export_start) * 1000.0

        total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms

        return FilterProcessResponse(
            status="success",
            session_id=session_id,
            filter_id=filter_id,
            output_image=data_uri,
            dimensions=ImageDimensions(width=out_pil.width, height=out_pil.height),
            metrics=ProcessingMetrics(
                upload_duration_ms=round(upload_duration_ms, 2),
                validation_duration_ms=round(val_duration, 2),
                model_init_duration_ms=round(model_init_duration, 2),
                inference_duration_ms=round(inf_duration, 2),
                export_duration_ms=round(export_duration, 2),
                total_duration_ms=round(total_duration, 2)
            ),
            metadata=metadata,
            error=None
        )


image_processor = ImageProcessor()

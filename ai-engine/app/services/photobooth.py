import io
import time
import uuid
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import List, Tuple, Dict, Any, Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageColor

from app.core.config import settings
from app.core.security import concurrency_limiter, temporary_working_directory
from app.services.image_validator import ImageValidator, ImageValidationError
from app.schemas.image import ProcessingMetrics, ImageDimensions
from app.schemas.photobooth import (
    PhotoboothLayout,
    PhotoboothConfig,
    PhotoboothComposeResponse
)


def _run_photobooth_in_worker(service: "PhotoboothService", valid_images: List[Image.Image], config: PhotoboothConfig, session_id: str) -> Image.Image:
    """
    Executes CPU-bound photobooth canvas generation inside a dedicated worker thread.
    Allocates and guarantees cleanup of temporary directories inside the thread itself,
    ensuring directory lifecycle matches thread lifetime even if caller times out.
    """
    with temporary_working_directory(prefix=f"photobooth_{session_id[:8]}_"):
        return service._compose_sync(valid_images, config)


class PhotoboothService:
    """
    Independent Photobooth Composition Engine.
    Handles aspect-ratio preserving cropping, multi-layout canvas placement,
    configurable borders/padding/backgrounds, and high-fidelity image export.
    """
    def __init__(self):
        self._executor = ThreadPoolExecutor(
            max_workers=settings.MAX_CONCURRENT_TASKS,
            thread_name_prefix="photobooth_worker"
        )

    @staticmethod
    def parse_hex_color(hex_str: str, default: Tuple[int, int, int] = (255, 255, 255)) -> Tuple[int, int, int]:
        """Safely parses CSS/hex color string to (R, G, B) tuple."""
        try:
            return ImageColor.getrgb(hex_str.strip())
        except Exception:
            return default

    @classmethod
    def crop_and_resize_cover(
        cls,
        img: Image.Image,
        target_w: int,
        target_h: int,
        corner_radius: int = 0
    ) -> Image.Image:
        """
        Crops source image to target aspect ratio using center-weighted 'cover'
        strategy, then resizes using Lanczos interpolation to prevent distortion.
        Optionally applies rounded corners via anti-aliased alpha mask.
        """
        src_w, src_h = img.size
        target_ratio = target_w / target_h
        src_ratio = src_w / src_h

        if src_ratio > target_ratio:
            # Source is wider than target: crop left & right
            crop_w = max(1, int(src_h * target_ratio))
            crop_h = src_h
            left = (src_w - crop_w) // 2
            top = 0
        else:
            # Source is taller than target: crop top & bottom
            crop_w = src_w
            crop_h = max(1, int(src_w / target_ratio))
            left = 0
            top = (src_h - crop_h) // 2

        right = left + crop_w
        bottom = top + crop_h

        cropped = img.crop((left, top, right, bottom))
        resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)

        if corner_radius > 0:
            mask = Image.new("L", (target_w, target_h), 0)
            draw = ImageDraw.Draw(mask)
            draw.rounded_rectangle((0, 0, target_w, target_h), radius=corner_radius, fill=255)
            resized.putalpha(mask)

        return resized

    def _compose_sync(
        self,
        valid_images: List[Image.Image],
        config: PhotoboothConfig
    ) -> Image.Image:
        """
        Synchronous canvas composition executed inside dedicated thread.
        Calculates canvas boundaries, grid/strip coordinates, pastes cropped slots,
        and paints typography and borders.
        """
        layout = config.layout
        num_images = len(valid_images)

        # 1. Determine Grid Dimensions and Required Photo Count
        if layout in (PhotoboothLayout.TWO_CUT_VERTICAL, PhotoboothLayout.TWO_CUT_HORIZONTAL):
            if num_images != 2:
                raise ImageValidationError(f"Layout '{layout.value}' requires exactly 2 images, received {num_images}.")
            cols = 1 if layout == PhotoboothLayout.TWO_CUT_VERTICAL else 2
            rows = 2 if layout == PhotoboothLayout.TWO_CUT_VERTICAL else 1

        elif layout == PhotoboothLayout.FOUR_CUT_STRIP:
            if num_images != 4:
                raise ImageValidationError(f"Layout '4cut_strip' requires exactly 4 images, received {num_images}.")
            cols = 1
            rows = 4

        elif layout == PhotoboothLayout.FOUR_CUT_GRID:
            if num_images != 4:
                raise ImageValidationError(f"Layout '4cut_grid' requires exactly 4 images, received {num_images}.")
            cols = 2
            rows = 2
        else:
            raise ImageValidationError(f"Unsupported layout '{layout}'.")

        # 2. Compute Total Canvas Geometry
        slot_w = config.slot_width
        slot_h = config.slot_height
        margin = config.outer_margin
        spacing = config.inner_spacing
        footer_h = config.footer_space

        canvas_w = margin * 2 + cols * slot_w + (cols - 1) * spacing
        canvas_h = margin * 2 + rows * slot_h + (rows - 1) * spacing + footer_h

        # Bounds check total canvas
        if canvas_w > settings.MAX_IMAGE_DIMENSION or canvas_h > settings.MAX_IMAGE_DIMENSION:
            raise ImageValidationError(
                f"Generated canvas dimensions ({canvas_w}x{canvas_h}) exceed max limit of {settings.MAX_IMAGE_DIMENSION}px."
            )

        # 3. Create Canvas
        bg_rgb = self.parse_hex_color(config.background_color)
        canvas = Image.new("RGB", (canvas_w, canvas_h), bg_rgb)

        # 4. Crop, Resize, and Place Each Photo
        img_idx = 0
        for r in range(rows):
            for c in range(cols):
                if img_idx >= num_images:
                    break

                x = margin + c * (slot_w + spacing)
                y = margin + r * (slot_h + spacing)

                source_img = valid_images[img_idx]
                processed_slot = self.crop_and_resize_cover(
                    source_img,
                    slot_w,
                    slot_h,
                    corner_radius=config.corner_radius
                )

                if processed_slot.mode == "RGBA":
                    canvas.paste(processed_slot, (x, y), processed_slot)
                else:
                    canvas.paste(processed_slot, (x, y))

                img_idx += 1

        # 5. Paint Footer Text / Branding if configured
        if footer_h > 0 and config.footer_text:
            draw = ImageDraw.Draw(canvas)
            # Contrast color calculation for footer text
            luminance = 0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]
            text_color = (30, 30, 35) if luminance > 128 else (240, 240, 245)

            font = ImageFont.load_default()
            footer_y = canvas_h - footer_h + (footer_h // 3)

            # Center text horizontally
            bbox = draw.textbbox((0, 0), config.footer_text, font=font)
            text_w = bbox[2] - bbox[0]
            text_x = max(margin, (canvas_w - text_w) // 2)

            draw.text((text_x, footer_y), config.footer_text, fill=text_color, font=font)

        return canvas

    async def compose(
        self,
        images_data: List[bytes],
        config: PhotoboothConfig,
        upload_duration_ms: float = 0.0
    ) -> PhotoboothComposeResponse:
        """
        Asynchronously validates image payloads and dispatches canvas rendering
        to the thread pool with strict timeout and concurrency control.
        """
        session_id = str(uuid.uuid4())
        total_start = time.perf_counter()

        # 1. Validation Phase
        val_start = time.perf_counter()
        valid_pil_images: List[Image.Image] = []

        try:
            if not images_data or len(images_data) == 0:
                raise ImageValidationError("Photobooth requires at least 2 images; none were received.")

            for idx, raw_bytes in enumerate(images_data):
                try:
                    pil_img, _, _, _ = ImageValidator.validate_upload(raw_bytes)
                    valid_pil_images.append(pil_img)
                except ImageValidationError as e:
                    raise ImageValidationError(f"Image [{idx + 1}/{len(images_data)}] validation failed: {str(e)}")

        except ImageValidationError as e:
            val_duration = (time.perf_counter() - val_start) * 1000.0
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return PhotoboothComposeResponse(
                status="failed",
                session_id=session_id,
                layout=config.layout.value,
                photo_count=len(images_data),
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

        # 2. Composition Phase (Protected by Concurrency Semaphore, Thread Pool, and Timeout)
        permit_acquired = False
        try:
            await asyncio.wait_for(concurrency_limiter.acquire(), timeout=settings.MAX_QUEUE_WAIT_SEC)
            permit_acquired = True
        except asyncio.TimeoutError:
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return PhotoboothComposeResponse(
                status="failed",
                session_id=session_id,
                layout=config.layout.value,
                photo_count=len(valid_pil_images),
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
                error="Server capacity limit reached: queue wait timeout exceeded (HTTP 503)."
            )

        inf_start = time.perf_counter()
        loop = asyncio.get_running_loop()
        try:
            future = self._executor.submit(
                _run_photobooth_in_worker,
                self,
                valid_pil_images,
                config,
                session_id
            )
            # Worker capacity permit is released ONLY when worker thread actually finishes execution
            future.add_done_callback(lambda f: concurrency_limiter.safe_release_from_thread(loop))
            permit_acquired = False  # Ownership transferred to future callback

            asyncio_task = asyncio.wrap_future(future)
            composed_canvas = await asyncio.wait_for(
                asyncio_task,
                timeout=settings.MAX_PROCESSING_TIMEOUT_SEC
            )
        except asyncio.TimeoutError:
            inf_duration = (time.perf_counter() - inf_start) * 1000.0
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return PhotoboothComposeResponse(
                status="failed",
                session_id=session_id,
                layout=config.layout.value,
                photo_count=len(valid_pil_images),
                output_image=None,
                dimensions=None,
                metrics=ProcessingMetrics(
                    upload_duration_ms=round(upload_duration_ms, 2),
                    validation_duration_ms=round(val_duration, 2),
                    model_init_duration_ms=0.0,
                    inference_duration_ms=round(inf_duration, 2),
                    export_duration_ms=0.0,
                    total_duration_ms=round(total_duration, 2)
                ),
                error=f"Photobooth composition timeout exceeded ({settings.MAX_PROCESSING_TIMEOUT_SEC}s)."
            )
        except ImageValidationError as e:
            inf_duration = (time.perf_counter() - inf_start) * 1000.0
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return PhotoboothComposeResponse(
                status="failed",
                session_id=session_id,
                layout=config.layout.value,
                photo_count=len(valid_pil_images),
                output_image=None,
                dimensions=None,
                metrics=ProcessingMetrics(
                    upload_duration_ms=round(upload_duration_ms, 2),
                    validation_duration_ms=round(val_duration, 2),
                    model_init_duration_ms=0.0,
                    inference_duration_ms=round(inf_duration, 2),
                    export_duration_ms=0.0,
                    total_duration_ms=round(total_duration, 2)
                ),
                error=str(e)
            )
        except Exception as e:
            inf_duration = (time.perf_counter() - inf_start) * 1000.0
            total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms
            return PhotoboothComposeResponse(
                status="failed",
                session_id=session_id,
                layout=config.layout.value,
                photo_count=len(valid_pil_images),
                output_image=None,
                dimensions=None,
                metrics=ProcessingMetrics(
                    upload_duration_ms=round(upload_duration_ms, 2),
                    validation_duration_ms=round(val_duration, 2),
                    model_init_duration_ms=0.0,
                    inference_duration_ms=round(inf_duration, 2),
                    export_duration_ms=0.0,
                    total_duration_ms=round(total_duration, 2)
                ),
                error=f"Composition error: {str(e)}"
            )
        finally:
            if permit_acquired:
                concurrency_limiter.release()

        inf_duration = (time.perf_counter() - inf_start) * 1000.0

        # 3. Export & Encoding Phase
        export_start = time.perf_counter()
        out_fmt = "PNG" if config.output_format.lower() == "png" else "JPEG"
        mime = "image/png" if out_fmt == "PNG" else "image/jpeg"

        bio = io.BytesIO()
        if out_fmt == "JPEG":
            composed_canvas.save(bio, format="JPEG", quality=config.output_quality, optimize=True)
        else:
            composed_canvas.save(bio, format="PNG", optimize=True)

        encoded_bytes = bio.getvalue()
        b64_str = base64.b64encode(encoded_bytes).decode("ascii")
        data_uri = f"data:{mime};base64,{b64_str}"
        export_duration = (time.perf_counter() - export_start) * 1000.0

        total_duration = (time.perf_counter() - total_start) * 1000.0 + upload_duration_ms

        return PhotoboothComposeResponse(
            status="success",
            session_id=session_id,
            layout=config.layout.value,
            photo_count=len(valid_pil_images),
            output_image=data_uri,
            dimensions=ImageDimensions(width=composed_canvas.width, height=composed_canvas.height),
            metrics=ProcessingMetrics(
                upload_duration_ms=round(upload_duration_ms, 2),
                validation_duration_ms=round(val_duration, 2),
                model_init_duration_ms=0.0,
                inference_duration_ms=round(inf_duration, 2),
                export_duration_ms=round(export_duration, 2),
                total_duration_ms=round(total_duration, 2)
            ),
            metadata={
                "layout": config.layout.value,
                "canvas_dimensions": f"{composed_canvas.width}x{composed_canvas.height}",
                "output_format": out_fmt.lower(),
                "background_color": config.background_color,
                "slot_dimensions": f"{config.slot_width}x{config.slot_height}"
            },
            error=None
        )


photobooth_service = PhotoboothService()

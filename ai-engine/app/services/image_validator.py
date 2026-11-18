import io
from typing import Tuple, Optional
import numpy as np
from PIL import Image, UnidentifiedImageError
from fastapi import UploadFile
from app.core.config import settings

# Enforce DecompressionBomb protection (prevent denial-of-service via massive raster expansions)
Image.MAX_IMAGE_PIXELS = 64 * 1024 * 1024  # 64 Megapixels maximum


class ImageValidationError(Exception):
    """Base exception for image validation rejections."""
    pass


class ImageSizeLimitError(ImageValidationError):
    """Raised when upload payload exceeds byte limit (HTTP 413)."""
    pass


class ImageFormatError(ImageValidationError):
    """Raised when file signature/MIME is unsupported (HTTP 415)."""
    pass


class ImageCorruptedError(ImageValidationError):
    """Raised when image bytes are corrupted, unreadable, or out of dimension bounds (HTTP 422)."""
    pass


class ImageValidator:
    """Strict validator for uploaded image files enforcing security, MIME, and dimensions."""

    @classmethod
    async def read_upload_stream(
        cls,
        upload_file: UploadFile,
        max_bytes: Optional[int] = None,
        chunk_size: int = 64 * 1024
    ) -> bytes:
        """
        Reads an UploadFile in bounded chunks without buffering oversized files into memory.
        If accumulated bytes exceed max_bytes, reading stops immediately, the file is closed,
        and an ImageValidationError is raised.
        """
        limit = max_bytes if max_bytes is not None else settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
        chunks = []
        total_bytes = 0

        try:
            while True:
                chunk = await upload_file.read(chunk_size)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > limit:
                    raise ImageSizeLimitError(
                        f"File size exceeds maximum allowed limit of {settings.MAX_UPLOAD_SIZE_MB}MB "
                        f"(aborted at {total_bytes / (1024 * 1024):.2f}MB)."
                    )
                chunks.append(chunk)
        finally:
            await upload_file.close()

        if total_bytes == 0:
            raise ImageValidationError("Uploaded image file is empty.")

        return b"".join(chunks)

    @staticmethod
    def detect_mime_from_signature(data: bytes) -> str:
        """
        Detect actual MIME type strictly using binary magic numbers (file signature).
        Prevents file extension spoofing and polyglot attacks.
        """
        if len(data) < 12:
            raise ImageFormatError("File is too small to contain a valid image signature.")

        # JPEG: FF D8 FF
        if data.startswith(b"\xFF\xD8\xFF"):
            return "image/jpeg"

        # PNG: 89 50 4E 47 0D 0A 1A 0A
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"

        # WebP: RIFF .... WEBP
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp"

        raise ImageFormatError("Unsupported or invalid file signature. Only JPEG, PNG, and WebP are allowed.")

    @classmethod
    def validate_upload(
        cls,
        data: bytes,
        content_type: str = "",
        min_dim: int = None,
        max_dim: int = None
    ) -> Tuple[Image.Image, str, int, int]:
        """
        Validates image binary:
        1. File size checks.
        2. Binary signature matches allowed image types.
        3. Decodes and checks for image corruption (verify & load).
        4. Bounds checking on dimensions.

        Returns: (PIL.Image in RGB mode, detected_mime, width, height)
        """
        if not data or len(data) == 0:
            raise ImageValidationError("Uploaded image file is empty.")

        max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
        if len(data) > max_bytes:
            raise ImageSizeLimitError(
                f"File size exceeds maximum allowed limit of {settings.MAX_UPLOAD_SIZE_MB}MB "
                f"(received {len(data) / (1024 * 1024):.2f}MB)."
            )

        # Detect actual MIME from magic bytes
        detected_mime = cls.detect_mime_from_signature(data)

        if detected_mime not in settings.ALLOWED_MIME_TYPES:
            raise ImageFormatError(f"MIME type '{detected_mime}' is not permitted.")

        # Decode image using Pillow
        try:
            # First pass: verify structural integrity
            bio_verify = io.BytesIO(data)
            verify_img = Image.open(bio_verify)
            verify_img.verify()

            # Second pass: actually load pixel buffer to catch truncated/corrupted payloads
            bio_load = io.BytesIO(data)
            img = Image.open(bio_load)
            img.load()
        except (UnidentifiedImageError, OSError, ValueError) as e:
            raise ImageCorruptedError(f"Corrupted or unreadable image data: {str(e)}")

        width, height = img.size

        min_d = min_dim or settings.MIN_IMAGE_DIMENSION
        max_d = max_dim or settings.MAX_IMAGE_DIMENSION

        if width < min_d or height < min_d:
            raise ImageCorruptedError(
                f"Image dimensions ({width}x{height}) are smaller than minimum allowed ({min_d}x{min_d})."
            )

        if width > max_d or height > max_d:
            raise ImageCorruptedError(
                f"Image dimensions ({width}x{height}) exceed maximum allowed ({max_d}x{max_d})."
            )

        # Normalize to standard RGB
        if img.mode != "RGB":
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                # Alpha composite over clean white background
                bg = Image.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.convert("RGBA").split()[3])
                img = bg
            else:
                img = img.convert("RGB")

        return img, detected_mime, width, height

    @classmethod
    def validate_output(cls, output_np: np.ndarray, expected_width: int = None, expected_height: int = None) -> Image.Image:
        """
        Validates processed image array prior to encoding and serialization:
        1. Ensures valid numpy array of uint8 dtype.
        2. Validates 3-channel RGB structure (H, W, 3).
        3. Bounds check on resulting dimensions.
        4. Validates PIL Image conversion integrity.

        Returns: Decodable PIL.Image in RGB mode.
        """
        if output_np is None:
            raise ImageCorruptedError("Filter engine returned a null/empty output array.")

        if not isinstance(output_np, np.ndarray):
            raise ImageCorruptedError(f"Expected numpy ndarray from filter engine, got {type(output_np)}.")

        if output_np.dtype != np.uint8:
            raise ImageCorruptedError(f"Invalid output image array dtype '{output_np.dtype}', expected uint8.")

        if output_np.ndim != 3 or output_np.shape[2] != 3:
            raise ImageCorruptedError(
                f"Invalid output image array shape {output_np.shape}. Expected 3-channel (H, W, 3) RGB format."
            )

        h, w = output_np.shape[:2]
        if w < settings.MIN_IMAGE_DIMENSION or h < settings.MIN_IMAGE_DIMENSION:
            raise ImageCorruptedError(f"Output dimensions ({w}x{h}) are below minimum {settings.MIN_IMAGE_DIMENSION}px.")

        if w > settings.MAX_IMAGE_DIMENSION or h > settings.MAX_IMAGE_DIMENSION:
            raise ImageValidationError(f"Output dimensions ({w}x{h}) exceed maximum {settings.MAX_IMAGE_DIMENSION}px.")

        try:
            pil_out = Image.fromarray(output_np)
            # Verify can save to memory
            bio = io.BytesIO()
            pil_out.save(bio, format="JPEG", quality=90)
            if bio.tell() == 0:
                raise ImageValidationError("Encoded output image buffer is empty.")
        except Exception as e:
            raise ImageValidationError(f"Failed to encode output image: {str(e)}")

        return pil_out

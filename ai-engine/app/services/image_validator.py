import io
from typing import Tuple
import numpy as np
from PIL import Image, UnidentifiedImageError
from app.core.config import settings

# Enforce DecompressionBomb protection (prevent denial-of-service via massive raster expansions)
Image.MAX_IMAGE_PIXELS = 64 * 1024 * 1024  # 64 Megapixels maximum


class ImageValidationError(Exception):
    """Custom exception raised when an uploaded image fails validation."""
    pass


class ImageValidator:
    """Strict validator for uploaded image files enforcing security, MIME, and dimensions."""

    @staticmethod
    def detect_mime_from_signature(data: bytes) -> str:
        """
        Detect actual MIME type strictly using binary magic numbers (file signature).
        Prevents file extension spoofing and polyglot attacks.
        """
        if len(data) < 12:
            raise ImageValidationError("File is too small to contain a valid image signature.")

        # JPEG: FF D8 FF
        if data.startswith(b"\xFF\xD8\xFF"):
            return "image/jpeg"

        # PNG: 89 50 4E 47 0D 0A 1A 0A
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"

        # WebP: RIFF .... WEBP
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp"

        raise ImageValidationError("Unsupported or invalid file signature. Only JPEG, PNG, and WebP are allowed.")

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
            raise ImageValidationError(
                f"File size exceeds maximum allowed limit of {settings.MAX_UPLOAD_SIZE_MB}MB "
                f"(received {len(data) / (1024 * 1024):.2f}MB)."
            )

        # Detect actual MIME from magic bytes
        detected_mime = cls.detect_mime_from_signature(data)

        if detected_mime not in settings.ALLOWED_MIME_TYPES:
            raise ImageValidationError(f"MIME type '{detected_mime}' is not permitted.")

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
            raise ImageValidationError(f"Corrupted or unreadable image data: {str(e)}")

        width, height = img.size

        min_d = min_dim or settings.MIN_IMAGE_DIMENSION
        max_d = max_dim or settings.MAX_IMAGE_DIMENSION

        if width < min_d or height < min_d:
            raise ImageValidationError(
                f"Image dimensions ({width}x{height}) are smaller than minimum allowed ({min_d}x{min_d})."
            )

        if width > max_d or height > max_d:
            raise ImageValidationError(
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
            raise ImageValidationError("Filter engine returned a null/empty output array.")

        if not isinstance(output_np, np.ndarray):
            raise ImageValidationError(f"Expected numpy ndarray from filter engine, got {type(output_np)}.")

        if output_np.dtype != np.uint8:
            raise ImageValidationError(f"Invalid output image array dtype '{output_np.dtype}', expected uint8.")

        if output_np.ndim != 3 or output_np.shape[2] != 3:
            raise ImageValidationError(
                f"Invalid output image array shape {output_np.shape}. Expected 3-channel (H, W, 3) RGB format."
            )

        h, w = output_np.shape[:2]
        if w < settings.MIN_IMAGE_DIMENSION or h < settings.MIN_IMAGE_DIMENSION:
            raise ImageValidationError(f"Output dimensions ({w}x{h}) are below minimum {settings.MIN_IMAGE_DIMENSION}px.")

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

import io
from typing import Tuple
from PIL import Image, UnidentifiedImageError
from app.core.config import settings


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

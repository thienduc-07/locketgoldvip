import io
import pytest
import numpy as np
from PIL import Image
from app.services.image_validator import ImageValidator, ImageValidationError
from app.core.config import settings


def test_signature_detection_valid():
    """Verify magic byte detection for JPEG, PNG, and WebP."""
    # JPEG
    jpeg_bytes = b"\xFF\xD8\xFF\xE0" + b"\x00" * 20
    assert ImageValidator.detect_mime_from_signature(jpeg_bytes) == "image/jpeg"

    # PNG
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    assert ImageValidator.detect_mime_from_signature(png_bytes) == "image/png"

    # WebP
    webp_bytes = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 20
    assert ImageValidator.detect_mime_from_signature(webp_bytes) == "image/webp"


def test_signature_detection_invalid():
    """Verify rejection of non-image signatures (e.g. plain text, html, zip)."""
    with pytest.raises(ImageValidationError, match="Unsupported or invalid file signature"):
        ImageValidator.detect_mime_from_signature(b"<html><body>Hello World</body></html>")

    with pytest.raises(ImageValidationError, match="too small"):
        ImageValidator.detect_mime_from_signature(b"short")


def test_validate_upload_empty():
    """Verify empty image upload raises validation error."""
    with pytest.raises(ImageValidationError, match="empty"):
        ImageValidator.validate_upload(b"")


def test_validate_upload_oversized(monkeypatch):
    """Verify file exceeding MAX_UPLOAD_SIZE_MB is rejected."""
    monkeypatch.setattr(settings, "MAX_UPLOAD_SIZE_MB", 1)  # Set to 1MB for test
    oversized_data = b"\xFF\xD8\xFF" + b"\x00" * (2 * 1024 * 1024)
    with pytest.raises(ImageValidationError, match="exceeds maximum allowed limit"):
        ImageValidator.validate_upload(oversized_data)


def test_validate_upload_corrupted(corrupted_image_bytes):
    """Verify corrupted image data fails Pillow two-pass verification."""
    with pytest.raises(ImageValidationError, match="Corrupted or unreadable"):
        ImageValidator.validate_upload(corrupted_image_bytes)


def test_validate_upload_tiny(tiny_image_bytes):
    """Verify image dimensions below MIN_IMAGE_DIMENSION are rejected."""
    with pytest.raises(ImageValidationError, match="smaller than minimum allowed"):
        ImageValidator.validate_upload(tiny_image_bytes)


def test_validate_upload_success_jpeg(sample_portrait_bytes):
    """Verify valid JPEG decodes to RGB and returns dimensions."""
    img, mime, w, h = ImageValidator.validate_upload(sample_portrait_bytes)
    assert mime == "image/jpeg"
    assert img.mode == "RGB"
    assert w == 400
    assert h == 500


def test_validate_upload_rgba_normalized(sample_png_bytes):
    """Verify RGBA/PNG is normalized to RGB mode."""
    # Create RGBA PNG
    rgba = Image.new("RGBA", (100, 100), (255, 0, 0, 128))
    bio = io.BytesIO()
    rgba.save(bio, format="PNG")
    data = bio.getvalue()

    img, mime, w, h = ImageValidator.validate_upload(data)
    assert mime == "image/png"
    assert img.mode == "RGB"
    assert w == 100
    assert h == 100


def test_validate_output_valid():
    """Verify validate_output accepts valid uint8 RGB numpy array."""
    valid_arr = np.zeros((200, 200, 3), dtype=np.uint8)
    valid_arr[:, :] = [100, 150, 200]
    out_pil = ImageValidator.validate_output(valid_arr)
    assert isinstance(out_pil, Image.Image)
    assert out_pil.size == (200, 200)
    assert out_pil.mode == "RGB"


def test_validate_output_invalid_type():
    """Verify validate_output rejects None and non-numpy objects."""
    with pytest.raises(ImageValidationError, match="null/empty"):
        ImageValidator.validate_output(None)

    with pytest.raises(ImageValidationError, match="Expected numpy ndarray"):
        ImageValidator.validate_output("not_an_array")


def test_validate_output_invalid_dtype():
    """Verify validate_output rejects float32 or int32 arrays."""
    float_arr = np.zeros((100, 100, 3), dtype=np.float32)
    with pytest.raises(ImageValidationError, match="dtype"):
        ImageValidator.validate_output(float_arr)


def test_validate_output_invalid_channels():
    """Verify validate_output rejects single-channel or 4-channel arrays."""
    gray_arr = np.zeros((100, 100), dtype=np.uint8)
    with pytest.raises(ImageValidationError, match="shape"):
        ImageValidator.validate_output(gray_arr)

    rgba_arr = np.zeros((100, 100, 4), dtype=np.uint8)
    with pytest.raises(ImageValidationError, match="shape"):
        ImageValidator.validate_output(rgba_arr)


@pytest.mark.asyncio
async def test_streaming_upload_rejection_early_abort():
    """
    Verify that read_upload_stream aborts immediately during chunked reading
    when byte limit is exceeded, preventing unbounded in-memory buffering.
    """
    from fastapi import UploadFile
    import io

    # Create a 2MB buffer, test with max_bytes = 100KB (0.1MB)
    two_mb_stream = io.BytesIO(b"A" * (2 * 1024 * 1024))
    upload = UploadFile(filename="oversized.jpg", file=two_mb_stream)

    read_calls = 0
    orig_read = upload.read

    async def counting_read(size=-1):
        nonlocal read_calls
        read_calls += 1
        return await orig_read(size)

    upload.read = counting_read

    max_allowed = 128 * 1024  # 128KB limit
    chunk_sz = 64 * 1024      # 64KB chunks

    with pytest.raises(ImageValidationError, match="exceeds maximum allowed limit"):
        await ImageValidator.read_upload_stream(upload, max_bytes=max_allowed, chunk_size=chunk_sz)

    # Must abort by chunk 3 (128KB + 64KB > 128KB), NOT reading all 32 chunks of the 2MB file
    assert read_calls <= 3, f"Stream was not aborted early! Read calls made: {read_calls}"

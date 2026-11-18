import io
import base64
import pytest
from PIL import Image


def test_api_health(client):
    """Verify GET /health returns 200 with platform and filter metadata."""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert "version" in data
    assert len(data["supported_filters"]) == 6
    assert "beard" in data["supported_filters"]
    assert "glasses" in data["supported_filters"]
    assert "system" in data


def test_api_list_filters(client):
    """Verify GET /api/v1/filters returns full catalog of 6 filters."""
    resp = client.get("/api/v1/filters")
    assert resp.status_code == 200
    filters = resp.json()
    assert len(filters) == 6
    fids = [f["id"] for f in filters]
    for expected in ["beard", "glasses", "beauty_makeup", "anime", "cartoon", "chibi_3d"]:
        assert expected in fids


@pytest.mark.parametrize("filter_id", [
    "beard",
    "glasses",
    "beauty_makeup",
    "cartoon",
    "anime",
    "chibi_3d"
])
def test_api_process_all_six_filters(client, sample_portrait_bytes, filter_id):
    """Verify POST /api/v1/filters/process transforms image and returns valid data URI for all 6 filters."""
    files = {"file": ("portrait.jpg", sample_portrait_bytes, "image/jpeg")}
    data = {"filter_id": filter_id, "intensity": "1.0"}

    resp = client.post("/api/v1/filters/process", files=files, data=data)
    assert resp.status_code == 200, f"Filter {filter_id} returned HTTP {resp.status_code}: {resp.text}"

    body = resp.json()
    assert body["status"] == "success"
    assert body["filter_id"] == filter_id
    assert body["output_image"].startswith("data:image/jpeg;base64,")

    # Decode and verify the returned image is a valid JPEG
    b64_content = body["output_image"].split(",")[1]
    decoded_bytes = base64.b64decode(b64_content)
    out_pil = Image.open(io.BytesIO(decoded_bytes))
    assert out_pil.format == "JPEG"
    assert out_pil.size == (400, 500)

    # Check metrics
    metrics = body["metrics"]
    assert metrics["upload_duration_ms"] >= 0
    assert metrics["validation_duration_ms"] >= 0
    assert metrics["inference_duration_ms"] >= 0
    assert metrics["total_duration_ms"] > 0


def test_api_preview_mode(client, sample_portrait_bytes):
    """Verify POST /api/v1/filters/preview downscales image for low-latency feedback."""
    files = {"file": ("portrait.jpg", sample_portrait_bytes, "image/jpeg")}
    data = {"filter_id": "cartoon", "intensity": "1.0"}

    resp = client.post("/api/v1/filters/preview", files=files, data=data)
    assert resp.status_code == 200

    body = resp.json()
    assert body["status"] == "success"
    # Preview downsamples to <= 512px
    assert max(body["dimensions"]["width"], body["dimensions"]["height"]) <= 512


def test_api_photobooth_compose(client, sample_portrait_bytes, sample_landscape_bytes):
    """Verify POST /api/v1/photobooth/compose combines multiple photos."""
    files = [
        ("files", ("p1.jpg", sample_portrait_bytes, "image/jpeg")),
        ("files", ("p2.jpg", sample_landscape_bytes, "image/jpeg")),
    ]
    data = {"layout": "2cut_vertical", "background_color": "#FFFFFF"}

    resp = client.post("/api/v1/photobooth/compose", files=files, data=data)
    assert resp.status_code == 200

    body = resp.json()
    assert body["status"] == "success"
    assert body["photo_count"] == 2
    assert body["output_image"].startswith("data:image/jpeg;base64,")


def test_api_invalid_filter_id(client, sample_portrait_bytes):
    """Verify unsupported filter ID returns HTTP 400."""
    files = {"file": ("portrait.jpg", sample_portrait_bytes, "image/jpeg")}
    data = {"filter_id": "non_existent_filter"}

    resp = client.post("/api/v1/filters/process", files=files, data=data)
    assert resp.status_code == 400
    assert "Unsupported filter ID" in resp.json()["detail"]


def test_api_corrupted_file(client, corrupted_image_bytes):
    """Verify corrupted image upload returns HTTP 422 Unprocessable Entity."""
    files = {"file": ("corrupt.jpg", corrupted_image_bytes, "image/jpeg")}
    data = {"filter_id": "cartoon"}

    resp = client.post("/api/v1/filters/process", files=files, data=data)
    assert resp.status_code == 422
    assert "Corrupted or unreadable" in resp.json()["detail"]


def test_api_oversized_file(client, monkeypatch):
    """Verify upload exceeding MAX_UPLOAD_SIZE_MB returns HTTP 413."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "MAX_UPLOAD_SIZE_MB", 1)  # 1MB limit

    oversized_bytes = b"\xFF\xD8\xFF\xE0" + b"\x00" * (1024 * 1024 + 1024)
    files = {"file": ("big.jpg", oversized_bytes, "image/jpeg")}
    data = {"filter_id": "cartoon"}

    resp = client.post("/api/v1/filters/process", files=files, data=data)
    assert resp.status_code == 413
    assert "exceeds maximum allowed limit" in resp.json()["detail"]


def test_api_unsupported_format(client):
    """Verify non-image binary or text payload returns HTTP 415 Unsupported Media Type."""
    text_payload = b"<!DOCTYPE html><html><body><h1>Not an image</h1></body></html>"
    files = {"file": ("exploit.html", text_payload, "text/html")}
    data = {"filter_id": "cartoon"}

    resp = client.post("/api/v1/filters/process", files=files, data=data)
    assert resp.status_code == 415
    assert "signature" in resp.json()["detail"].lower()


def test_security_headers_present(client):
    """Verify security headers are applied to HTTP responses."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("x-frame-options") == "DENY"
    assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"


def test_cors_configured_origins(client):
    """Verify CORS middleware handles configured origin preflight."""
    headers = {
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
    }
    resp = client.options("/api/v1/filters/process", headers=headers)
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"

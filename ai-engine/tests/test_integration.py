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


def test_api_process_url_and_fetch_output(client, sample_portrait_bytes, monkeypatch):
    """Verify POST /api/v1/filters/process-url downloads, processes, and serves via GET /output/{id}.jpg."""
    import httpx

    class MockStreamResponse:
        status_code = 200
        headers = {"content-type": "image/jpeg", "content-length": str(len(sample_portrait_bytes))}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield sample_portrait_bytes

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/test.jpg?alt=media",
        "filter_id": "looks_maxxing",
        "intensity": 0.85
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["filter_id"] == "beauty_makeup"
    assert data["output_url"] is not None
    assert "/api/v1/filters/output/" in data["output_url"]

    # Verify fetching the output JPEG
    output_resp = client.get(f"/api/v1/filters/output/{data['session_id']}.jpg")
    assert output_resp.status_code == 200
    assert output_resp.headers["content-type"] == "image/jpeg"
    assert "public, max-age=600" in output_resp.headers["cache-control"]
    assert output_resp.content.startswith(b"\xff\xd8\xff")  # JPEG SOI marker


def test_api_process_url_invalid_url(client):
    """Verify POST /api/v1/filters/process-url rejects invalid URLs."""
    payload = {
        "image_url": "ftp://bad-url",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 400


def test_api_process_url_download_failure(client, monkeypatch):
    """Verify POST /api/v1/filters/process-url handles remote fetch 404."""
    import httpx

    class Mock404StreamResponse:
        status_code = 404
        headers = {}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b"Not Found"

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return Mock404StreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/missing.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 400


def test_api_process_url_ssrf_metadata_blocked(client):
    """Verify SSRF protection strictly blocks AWS/GCP cloud metadata IP."""
    payload = {
        "image_url": "http://169.254.169.254/latest/meta-data/",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "forbidden" in resp.json()["detail"].lower()


def test_api_process_url_ssrf_localhost_blocked(client):
    """Verify SSRF protection strictly blocks loopback 127.0.0.1."""
    payload = {
        "image_url": "http://127.0.0.1:8000/internal",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "forbidden" in resp.json()["detail"].lower()


def test_api_process_url_ssrf_metadata_domain_blocked(client):
    """Verify SSRF protection strictly blocks metadata.google.internal."""
    payload = {
        "image_url": "http://metadata.google.internal/computeMetadata/v1/",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403


def test_api_process_url_oversized_image(client, monkeypatch):
    """Verify POST /api/v1/filters/process-url rejects downloads exceeding 10MB."""
    import httpx

    class MockOversizedStreamResponse:
        status_code = 200
        headers = {"content-type": "image/jpeg", "content-length": str(15 * 1024 * 1024)}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b"x" * (11 * 1024 * 1024)

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockOversizedStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/huge.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 413


def test_api_process_url_invalid_mime_type(client, monkeypatch):
    """Verify POST /api/v1/filters/process-url rejects non-image binaries."""
    import httpx

    class MockHTMLStreamResponse:
        status_code = 200
        headers = {"content-type": "text/html", "content-length": "100"}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b"<html><body>Not an image</body></html>"

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockHTMLStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/file.html",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 415


def test_api_process_url_auth_enforcement(client, sample_portrait_bytes, monkeypatch):
    """Verify X-API-Key is enforced when AI_ENGINE_API_KEY is configured in env."""
    import httpx

    class MockStreamResponse:
        status_code = 200
        headers = {"content-type": "image/jpeg", "content-length": str(len(sample_portrait_bytes))}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield sample_portrait_bytes

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)
    monkeypatch.setenv("AI_ENGINE_API_KEY", "super-secret-key-123")

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/test.jpg",
        "filter_id": "beard"
    }

    # Without header -> 401
    resp_no_auth = client.post("/api/v1/filters/process-url", json=payload)
    assert resp_no_auth.status_code == 401

    # With bad header -> 401
    resp_bad_auth = client.post("/api/v1/filters/process-url", json=payload, headers={"x-api-key": "wrong"})
    assert resp_bad_auth.status_code == 401

    # With good header -> 200
    resp_ok = client.post("/api/v1/filters/process-url", json=payload, headers={"x-api-key": "super-secret-key-123"})
    assert resp_ok.status_code == 200


def test_api_output_expired_status_410(client):
    """Verify GET /api/v1/filters/output/{id}.jpg returns 410 Gone for expired session."""
    from app.api.filters import _IMAGE_CACHE
    import time

    session_id = "test-expired-session"
    _IMAGE_CACHE[session_id] = (b"\xff\xd8\xff...", time.time() - 100.0)  # Expired 100s ago

    resp = client.get(f"/api/v1/filters/output/{session_id}.jpg")
    assert resp.status_code == 410
    assert "expired" in resp.json()["detail"].lower()



def test_api_output_not_found(client):
    """Verify GET /api/v1/filters/output/{id}.jpg returns 404 for unknown session."""
    resp = client.get("/api/v1/filters/output/nonexistent-session-id.jpg")
    assert resp.status_code == 404


def test_api_process_url_ipv4_mapped_ipv6_loopback(client):
    """Verify POST /api/v1/filters/process-url rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)."""
    payload = {
        "image_url": "http://[::ffff:127.0.0.1]/secret.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "loopback" in resp.json()["detail"].lower()


def test_api_process_url_ipv4_mapped_ipv6_metadata(client):
    """Verify POST /api/v1/filters/process-url rejects IPv4-mapped IPv6 cloud metadata (::ffff:169.254.169.254)."""
    payload = {
        "image_url": "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "metadata" in resp.json()["detail"].lower() or "link-local" in resp.json()["detail"].lower()


def test_api_process_url_dns_rebinding_socket_intercept(client, monkeypatch):
    """Verify connect-time socket IP inspection catches DNS rebinding / TOCTOU IP swap."""
    import httpx

    class MockNetworkStream:
        def get_extra_info(self, info_type):
            if info_type == "server_addr":
                # Simulated socket connected to loopback IP post-DNS resolution
                return ("127.0.0.1", 80)
            return None

    class MockReboundStreamResponse:
        status_code = 200
        headers = {"content-type": "image/jpeg", "content-length": "100"}
        extensions = {"network_stream": MockNetworkStream()}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b"\xff\xd8\xff" + b"x" * 100

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockReboundStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/rebound.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "dns rebinding defense" in resp.json()["detail"].lower()


def test_api_process_url_redirect_chain_to_internal_ip(client, monkeypatch):
    """Verify HTTP redirect chain pointing to internal/private IP (10.0.0.1) is blocked."""
    import httpx

    class MockRedirectStreamResponse:
        status_code = 302
        headers = {"Location": "http://10.0.0.1/internal-admin.jpg"}
        extensions = {}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b""

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockRedirectStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/redirect.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 403
    assert "private network" in resp.json()["detail"].lower()


def test_api_process_url_redirect_loop(client, monkeypatch):
    """Verify HTTP redirect loop (>3 hops) is aborted with 400 Bad Request."""
    import httpx

    class MockLoopStreamResponse:
        status_code = 302
        headers = {"Location": "https://firebasestorage.googleapis.com/v0/b/locket/o/loop.jpg"}
        extensions = {}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def aiter_bytes(self, chunk_size=65536):
            yield b""

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url):
            return MockLoopStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    payload = {
        "image_url": "https://firebasestorage.googleapis.com/v0/b/locket/o/loop.jpg",
        "filter_id": "beard"
    }
    resp = client.post("/api/v1/filters/process-url", json=payload)
    assert resp.status_code == 400
    assert "too many redirects" in resp.json()["detail"].lower()



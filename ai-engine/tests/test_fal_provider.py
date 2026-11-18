import io
import pytest
import numpy as np
import httpx
from PIL import Image
from app.engines.generative import FalAIProvider


def test_fal_provider_unconfigured():
    """Verify FalAIProvider when FAL_KEY is not configured."""
    provider = FalAIProvider(api_key=None)
    assert provider.is_available() is False

    status = provider.get_status()
    assert status["configured"] is False
    assert status["status"] == "unconfigured_missing_key"


@pytest.mark.asyncio
async def test_fal_provider_fallback_when_unconfigured():
    """Verify generate_style returns fallback with original image when unconfigured."""
    provider = FalAIProvider(api_key=None)
    dummy_np = np.zeros((100, 100, 3), dtype=np.uint8)

    out_np, meta = await provider.generate_style(
        img_rgb=dummy_np,
        style_prompt="anime portrait",
        filter_id="anime"
    )
    # Must preserve array and report fallback
    assert np.array_equal(out_np, dummy_np)
    assert meta["fallback_applied"] is True
    assert "FAL_KEY" in meta["error"]


@pytest.mark.asyncio
async def test_fal_provider_mock_response():
    """
    Verify FalAIProvider correctly handles remote response schema
    using an httpx MockTransport (zero network calls, zero API costs).
    """
    # Create generated test image bytes
    gen_pil = Image.new("RGB", (100, 100), (255, 100, 50))
    gen_bio = io.BytesIO()
    gen_pil.save(gen_bio, format="JPEG")
    gen_bytes = gen_bio.getvalue()

    def mock_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("fast-sdxl/image-to-image"):
            # Check auth header
            assert "Key test_fal_secret_key" in request.headers.get("Authorization", "")
            return httpx.Response(200, json={
                "images": [{"url": "https://fal.media/mock_result.jpg"}]
            })
        elif "mock_result.jpg" in str(request.url):
            return httpx.Response(200, content=gen_bytes)
        return httpx.Response(404)

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="test_fal_secret_key")
        assert provider.is_available() is True

        dummy_np = np.zeros((100, 100, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(
            img_rgb=dummy_np,
            style_prompt="anime style",
            filter_id="anime",
            http_client=mock_client
        )

        assert meta["status"] == "success"
        assert meta["fallback_applied"] is False
        assert meta["applied"] is True
        assert meta["success"] is True
        assert out_np.shape == (100, 100, 3)


@pytest.mark.asyncio
async def test_fal_provider_invalid_key_http_401():
    """Verify FalAIProvider handles invalid API key (HTTP 401) via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Unauthorized: Invalid API key")

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="invalid_test_key_12345")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        assert np.array_equal(out_np, dummy_np)
        assert meta["status"] == "http_error"
        assert meta["http_status"] == 401
        assert meta["fallback_applied"] is True
        assert meta["applied"] is False
        assert meta["success"] is False


@pytest.mark.asyncio
async def test_fal_provider_rate_limit_http_429():
    """Verify FalAIProvider handles rate limiting (HTTP 429) via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="Rate limit exceeded. Retry later.")

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="valid_key_123456789")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        assert np.array_equal(out_np, dummy_np)
        assert meta["status"] == "http_error"
        assert meta["http_status"] == 429
        assert meta["fallback_applied"] is True


@pytest.mark.asyncio
async def test_fal_provider_server_error_http_500():
    """Verify FalAIProvider handles provider server crash (HTTP 500) via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="Internal Server Error in model worker")

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="valid_key_123456789")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        assert np.array_equal(out_np, dummy_np)
        assert meta["status"] == "http_error"
        assert meta["http_status"] == 500
        assert meta["fallback_applied"] is True


@pytest.mark.asyncio
async def test_fal_provider_network_timeout():
    """Verify FalAIProvider handles remote network timeout cleanly via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("Connection timed out to Fal.ai gateway")

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="valid_key_123456789")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        assert np.array_equal(out_np, dummy_np)
        assert meta["status"] == "timeout"
        assert meta["fallback_applied"] is True


@pytest.mark.asyncio
async def test_fal_provider_malformed_response():
    """Verify FalAIProvider handles response missing images array schema via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected_key": "no_images_here"})

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="valid_key_123456789")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        assert np.array_equal(out_np, dummy_np)
        assert meta["status"] == "schema_error"
        assert meta["fallback_applied"] is True


@pytest.mark.asyncio
async def test_fal_provider_corrupted_generated_image():
    """Verify FalAIProvider handles corrupted downloaded image bytes via MockTransport."""
    def mock_handler(request: httpx.Request) -> httpx.Response:
        if "image-to-image" in str(request.url):
            return httpx.Response(200, json={"images": [{"url": "https://fal.media/corrupt.jpg"}]})
        elif "corrupt.jpg" in str(request.url):
            return httpx.Response(200, content=b"Not a valid image data payload")
        return httpx.Response(404)

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as mock_client:
        provider = FalAIProvider(api_key="valid_key_123456789")
        dummy_np = np.zeros((50, 50, 3), dtype=np.uint8)
        out_np, meta = await provider.generate_style(dummy_np, "prompt", "anime", http_client=mock_client)

        # Exception caught when Image.open fails -> returns original image fallback
        assert np.array_equal(out_np, dummy_np)
        assert meta["fallback_applied"] is True

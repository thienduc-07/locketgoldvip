import os
import time
import base64
import urllib.parse
import socket
import ipaddress
from typing import List, Dict, Any, Optional, Tuple
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status, Request, Response
from app.core.config import settings
from app.schemas.image import FilterProcessResponse, FilterType, ProcessURLRequest, ProcessURLResponse
from app.services.image_processor import image_processor
from app.services.image_validator import (
    ImageValidator,
    ImageValidationError,
    ImageSizeLimitError,
    ImageFormatError,
    ImageCorruptedError
)
import httpx

router = APIRouter(prefix="/api/v1/filters", tags=["Filters"])

# RAM Image Cache with TTL 10 minutes (600s) for processed filter outputs
_IMAGE_CACHE: Dict[str, Tuple[bytes, float]] = {}


def _evict_expired_cache() -> None:
    """Evicts expired image cache entries and enforces max size (200 images)."""
    now = time.time()
    expired_keys = [k for k, (_, exp) in _IMAGE_CACHE.items() if exp < now]
    for k in expired_keys:
        _IMAGE_CACHE.pop(k, None)
    if len(_IMAGE_CACHE) > 200:
        sorted_keys = sorted(_IMAGE_CACHE.keys(), key=lambda k: _IMAGE_CACHE[k][1])
        for k in sorted_keys[: len(_IMAGE_CACHE) - 200]:
            _IMAGE_CACHE.pop(k, None)


def is_forbidden_ip(ip_obj: Any, allow_private: bool = False) -> Tuple[bool, str]:
    """
    Evaluates whether an IP address violates security boundaries (loopback, metadata, link-local, private).
    Unpacks IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) before checking.
    """
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
        ip_obj = ip_obj.ipv4_mapped

    if ip_obj.is_loopback:
        return True, f"Loopback address ({ip_obj}) is forbidden (SSRF defense)."
    if ip_obj.is_link_local:
        return True, f"Link-local / cloud metadata address ({ip_obj}) is forbidden (SSRF defense)."
    if ip_obj.is_unspecified:
        return True, f"Unspecified address ({ip_obj}) is forbidden."
    if ip_obj.is_reserved:
        return True, f"Reserved address ({ip_obj}) is forbidden."
    if not allow_private and ip_obj.is_private:
        return True, f"Private network address ({ip_obj}) is forbidden (SSRF defense)."
    return False, ""


def verify_connected_socket_ip(stream_resp: Any, allow_private: bool = False) -> None:
    """
    Verifies the actual physical socket IP address that the TCP/TLS connection was established with.
    Defeats DNS rebinding and TOCTOU attacks where DNS answers change between validation and connection.
    """
    ext = getattr(stream_resp, "extensions", None) or {}
    stream = ext.get("network_stream")
    if stream and hasattr(stream, "get_extra_info"):
        server_addr = stream.get_extra_info("server_addr")
        if server_addr and len(server_addr) >= 1:
            raw_ip = server_addr[0]
            try:
                ip_obj = ipaddress.ip_address(raw_ip)
                forbidden, reason = is_forbidden_ip(ip_obj, allow_private=allow_private)
                if forbidden:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"Connection aborted: {reason} (DNS Rebinding defense)."
                    )
            except ValueError:
                pass


def validate_and_sanitize_image_url(url_str: str) -> None:
    """
    Strict SSRF and security defense:
    - Enforces http/https scheme only.
    - Resolves DNS and blocks loopback (127.0.0.0/8, ::1), link-local / cloud metadata (169.254.0.0/16, fe80::/10),
      unspecified (0.0.0.0), and private networks (10/8, 172.16/12, 192.168/16) unless ALLOW_PRIVATE_NETWORKS=true.
    - Prohibits known cloud metadata hostnames directly.
    """
    if not url_str or not isinstance(url_str, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid image_url parameter"
        )

    try:
        parsed = urllib.parse.urlparse(url_str.strip())
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed image_url: {str(e)}"
        )

    if parsed.scheme.lower() not in ("http", "https"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Prohibited URL scheme '{parsed.scheme}'. Only 'http' and 'https' are allowed."
        )

    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image_url: Missing hostname."
        )

    lower_host = hostname.lower()
    if lower_host in ("169.254.169.254", "metadata.google.internal", "instance-data", "metadata", "localhost"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access to cloud metadata / localhost is strictly forbidden (SSRF defense)."
        )

    allow_private = os.getenv("ALLOW_PRIVATE_NETWORKS", "false").lower() in ("true", "1", "yes")

    try:
        ip = ipaddress.ip_address(hostname)
        ips_to_check = [ip]
    except ValueError:
        try:
            addr_info = socket.getaddrinfo(hostname, None)
            ips_to_check = [ipaddress.ip_address(entry[4][0]) for entry in addr_info]
        except socket.gaierror as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to resolve hostname '{hostname}': {str(e)}"
            )

    for ip_obj in ips_to_check:
        forbidden, reason = is_forbidden_ip(ip_obj, allow_private=allow_private)
        if forbidden:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=reason
            )



def normalize_filter_id(filter_id: str) -> str:

    """
    Maps Locket and Shadowrocket filter IDs to the 6 core CV/generative filter engines.
    """
    fid = (filter_id or "").lower().strip()
    mapping = {
        "looks_maxxing": "beauty_makeup",
        "looksmaxing": "beauty_makeup",
        "stk_dio_looksmaxing": "beauty_makeup",
        "beauty": "beauty_makeup",
        "beauty_makeup": "beauty_makeup",
        "vintage": "beauty_makeup",
        "beard": "beard",
        "bearded": "beard",
        "stk_dio_bearded": "beard",
        "stk_dio_bearded_holiday": "beard",
        "glasses": "glasses",
        "sunglasses": "glasses",
        "anime": "anime",
        "watercolor_art": "anime",
        "stk_watercolor_art": "anime",
        "cartoon": "cartoon",
        "disco": "cartoon",
        "disco_lights": "cartoon",
        "stk_dio_disco": "cartoon",
        "fortnite_llama": "cartoon",
        "stk_fortnite_llama": "cartoon",
        "chibi_3d": "chibi_3d",
        "chibi": "chibi_3d",
        "shrek_ogre": "chibi_3d",
        "stk_shrek_ogre": "chibi_3d",
    }
    return mapping.get(fid, fid)



@router.get("", response_model=List[Dict[str, Any]])
async def list_filters():
    """
    Returns the comprehensive catalog of all 6 supported filters,
    including algorithm category, technical descriptions, and execution providers.
    """
    return image_processor.get_filters_metadata()


@router.post("/process", response_model=FilterProcessResponse)
async def process_filter(
    file: UploadFile = File(..., description="Uploaded image file (JPEG, PNG, WebP)"),
    filter_id: str = Form(..., description="Target filter identifier (e.g. beard, glasses, beauty_makeup, anime, cartoon, chibi_3d)"),
    intensity: float = Form(1.0, ge=0.0, le=1.0, description="Effect intensity from 0.0 to 1.0"),
    preview_mode: bool = Form(False, description="Enable low-latency preview mode (downscales input to <=512px)")
):
    """
    Processes an uploaded image through the selected computer vision / generative filter.
    Enforces MIME signature validation, dimension bounds, processing timeouts,
    and automatic memory/temp cleanup.
    """
    upload_start = time.perf_counter()
    try:
        image_bytes = await ImageValidator.read_upload_stream(file)
    except ImageSizeLimitError as e:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
    except ImageFormatError as e:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(e))
    except ImageCorruptedError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except ImageValidationError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Failed to read upload payload: {str(e)}")
    upload_duration = (time.perf_counter() - upload_start) * 1000.0

    # Execute image processor orchestration
    response = await image_processor.process_image(
        image_bytes=image_bytes,
        filter_id=filter_id,
        upload_duration_ms=upload_duration,
        intensity=intensity,
        preview_mode=preview_mode
    )

    if response.status == "failed":
        err_msg = (response.error or "").lower()
        if "unsupported filter id" in err_msg or "empty" in err_msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)
        elif "exceeds maximum allowed limit" in err_msg or "file size exceeds" in err_msg:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=response.error)
        elif "signature" in err_msg or "mime type" in err_msg or "format" in err_msg:
            raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=response.error)
        elif "corrupted" in err_msg or "dimension" in err_msg or "unreadable" in err_msg or "output validation" in err_msg:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)
        elif "capacity limit reached" in err_msg or "queue wait timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=response.error)
        elif "timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    return response


@router.post("/preview", response_model=FilterProcessResponse)
async def preview_filter(
    file: UploadFile = File(..., description="Uploaded image file (JPEG, PNG, WebP)"),
    filter_id: str = Form(..., description="Target filter identifier"),
    intensity: float = Form(1.0, ge=0.0, le=1.0, description="Effect intensity from 0.0 to 1.0")
):
    """
    Fast preview endpoint: automatically downscales the image to <=512px
    to deliver instant visual feedback (<100ms latency).
    """
    upload_start = time.perf_counter()
    try:
        image_bytes = await ImageValidator.read_upload_stream(file)
    except ImageSizeLimitError as e:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
    except ImageFormatError as e:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(e))
    except ImageCorruptedError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except ImageValidationError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Failed to read upload payload: {str(e)}")
    upload_duration = (time.perf_counter() - upload_start) * 1000.0

    response = await image_processor.process_image(
        image_bytes=image_bytes,
        filter_id=filter_id,
        upload_duration_ms=upload_duration,
        intensity=intensity,
        preview_mode=True
    )

    if response.status == "failed":
        err_msg = (response.error or "").lower()
        if "unsupported filter id" in err_msg or "empty" in err_msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=response.error)
        elif "exceeds maximum allowed limit" in err_msg or "file size exceeds" in err_msg:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=response.error)
        elif "signature" in err_msg or "mime type" in err_msg or "format" in err_msg:
            raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=response.error)
        elif "corrupted" in err_msg or "dimension" in err_msg or "unreadable" in err_msg or "output validation" in err_msg:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)
        elif "capacity limit reached" in err_msg or "queue wait timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=response.error)
        elif "timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    return response


@router.post("/process-url", response_model=ProcessURLResponse)
async def process_filter_url(
    payload: ProcessURLRequest,
    request: Request
):
    """
    Downloads an image from a URL (e.g. Firebase Storage, Locket CDN),
    applies the requested filter via the local CV/generative engine,
    caches the output JPEG in RAM, and returns a direct HTTP URL for Locket/Shadowrocket.
    """
    # 0. Security & Input Constraints Enforcement
    _evict_expired_cache()
    validate_and_sanitize_image_url(payload.image_url)

    # Optional API Key Authentication
    api_key_env = os.getenv("AI_ENGINE_API_KEY")
    if api_key_env:
        client_key = request.headers.get("x-api-key")
        if client_key != api_key_env:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unauthorized: Missing or invalid X-API-Key"
            )

    target_fid = normalize_filter_id(payload.filter_id)
    if target_fid not in image_processor.get_supported_filters():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported filter ID: '{payload.filter_id}'. Supported: {image_processor.get_supported_filters()}"
        )

    # 1. Fetch remote image with SSRF-safe streaming and size limits
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    fetch_start = time.perf_counter()
    image_bytes = bytearray()
    current_url = payload.image_url
    max_redirects = 3

    allow_private = os.getenv("ALLOW_PRIVATE_NETWORKS", "false").lower() in ("true", "1", "yes")

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
            for _ in range(max_redirects + 1):
                validate_and_sanitize_image_url(current_url)
                async with client.stream("GET", current_url) as stream_resp:
                    # Verify connected socket IP immediately to prevent DNS rebinding
                    verify_connected_socket_ip(stream_resp, allow_private=allow_private)

                    if stream_resp.status_code in (301, 302, 303, 307, 308):
                        redirect_url = stream_resp.headers.get("Location")
                        if not redirect_url:
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Redirect response missing Location header"
                            )
                        current_url = urllib.parse.urljoin(current_url, redirect_url)
                        continue

                    if stream_resp.status_code != 200:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Failed to fetch image from URL: HTTP {stream_resp.status_code}"
                        )

                    content_length = stream_resp.headers.get("content-length")
                    if content_length and int(content_length) > max_bytes:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail=f"Image download exceeds maximum limit of {settings.MAX_UPLOAD_SIZE_MB}MB"
                        )

                    image_bytes = bytearray()
                    async for chunk in stream_resp.aiter_bytes(chunk_size=65536):
                        image_bytes.extend(chunk)
                        if len(image_bytes) > max_bytes:
                            raise HTTPException(
                                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                detail=f"Image download exceeded maximum limit of {settings.MAX_UPLOAD_SIZE_MB}MB"
                            )
                    break
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Too many redirects while fetching image"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Network error downloading image: {str(e)}"
        )
    fetch_duration = (time.perf_counter() - fetch_start) * 1000.0

    # Binary magic byte verification
    raw_bytes = bytes(image_bytes)
    if len(raw_bytes) < 12:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Downloaded file is too small to be a valid image"
        )
    if not (
        raw_bytes.startswith(b"\xFF\xD8\xFF") or
        raw_bytes.startswith(b"\x89PNG\r\n\x1a\n") or
        (raw_bytes.startswith(b"RIFF") and raw_bytes[8:12] == b"WEBP")
    ):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported image format. Only JPEG, PNG, and WebP are allowed."
        )

    # 2. Execute image processor
    response = await image_processor.process_image(
        image_bytes=raw_bytes,
        filter_id=target_fid,
        upload_duration_ms=fetch_duration,
        intensity=payload.intensity,
        preview_mode=payload.preview_mode
    )

    if response.status == "failed":
        err_msg = (response.error or "").lower()
        if "capacity limit reached" in err_msg or "queue wait timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=response.error)
        elif "timeout" in err_msg:
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=response.error)
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=response.error)

    # 3. Cache processed JPEG bytes in RAM
    if not response.output_image or "," not in response.output_image:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Processing completed but output image data was missing"
        )

    try:
        b64_data = response.output_image.split(",", 1)[1]
        jpeg_bytes = base64.b64decode(b64_data)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to decode output JPEG: {str(e)}"
        )

    _IMAGE_CACHE[response.session_id] = (jpeg_bytes, time.time() + 600.0)

    # 4. Construct direct output URL
    public_base = os.getenv("PUBLIC_URL") or os.getenv("AI_ENGINE_PUBLIC_URL")
    if not public_base:
        public_base = str(request.base_url).rstrip("/")
    else:
        public_base = public_base.rstrip("/")

    output_url = f"{public_base}/api/v1/filters/output/{response.session_id}.jpg"

    return ProcessURLResponse(
        status="success",
        session_id=response.session_id,
        filter_id=target_fid,
        output_url=output_url,
        dimensions=response.dimensions,
        metrics=response.metrics,
        error=None
    )


@router.get("/output/{session_id}.jpg")
async def get_processed_output(session_id: str):
    """
    Serves cached processed filter JPEG images.
    Returns Cache-Control headers for optimal iPhone/Locket loading.
    """
    clean_session_id = session_id.replace(".jpg", "")
    item = _IMAGE_CACHE.get(clean_session_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found or session expired"
        )

    jpeg_bytes, expires_at = item
    if time.time() > expires_at:
        _IMAGE_CACHE.pop(clean_session_id, None)
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Processed image has expired"
        )

    return Response(
        content=jpeg_bytes,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=600",
            "Content-Disposition": f'inline; filename="{clean_session_id}.jpg"',
            "Access-Control-Allow-Origin": "*"
        }
    )


import io
import time
import pytest
import numpy as np
from PIL import Image
from app.services.image_processor import image_processor


def create_synthetic_image_bytes(w: int, h: int) -> bytes:
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    # Fill with a varied gradient to ensure real processing work
    for y in range(h):
        arr[y, :, 0] = int(y / h * 255)
        arr[y, :, 1] = 120
    for x in range(w):
        arr[:, x, 2] = int(x / w * 255)

    pil = Image.fromarray(arr)
    bio = io.BytesIO()
    pil.save(bio, format="JPEG", quality=90)
    return bio.getvalue()


@pytest.mark.parametrize("resolution", [
    (512, 512),
    (1080, 1080),
    (1440, 1440)
])
@pytest.mark.asyncio
async def test_performance_benchmark(resolution):
    w, h = resolution
    img_bytes = create_synthetic_image_bytes(w, h)

    # Benchmark cartoon filter
    start = time.perf_counter()
    resp = await image_processor.process_image(img_bytes, "cartoon")
    elapsed_ms = (time.perf_counter() - start) * 1000.0

    assert resp.status == "success"
    assert resp.output_image is not None
    print(f"\n[BENCHMARK] Resolution: {w}x{h} | Latency: {elapsed_ms:.1f}ms | Inference: {resp.metrics.inference_duration_ms:.1f}ms")

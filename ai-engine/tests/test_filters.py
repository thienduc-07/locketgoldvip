import pytest
import numpy as np
from PIL import Image
from app.services.image_processor import image_processor
from app.engines.accessories import GlassesFilterEngine, BeardFilterEngine
from app.engines.beauty import BeautyMakeupFilterEngine
from app.engines.generative import CartoonFilterEngine, AnimeFilterEngine, Chibi3DFilterEngine


def get_numpy_from_bytes(img_bytes: bytes) -> np.ndarray:
    import io
    pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    return np.array(pil)


# ---------------------------------------------------------------------------
# 1. Beauty Makeup Filter
# ---------------------------------------------------------------------------
def test_beauty_makeup_transformation(sample_portrait_bytes):
    engine = BeautyMakeupFilterEngine()
    img_np = get_numpy_from_bytes(sample_portrait_bytes)

    out_np, meta = engine.apply(img_np, intensity=1.0)

    # 1. Output structure assertions
    assert isinstance(out_np, np.ndarray), "Output must be a numpy ndarray"
    assert out_np.dtype == np.uint8, "Output dtype must be uint8"
    assert out_np.shape == img_np.shape, "Output shape must match input dimensions"

    # 2. Actual image transformation assertion (Mean Absolute Error)
    diff = np.abs(img_np.astype(float) - out_np.astype(float))
    mae = np.mean(diff)
    assert mae > 0.5, f"Beauty filter failed to alter pixel data (MAE={mae})"

    # 3. Metadata validation
    assert meta["skin_smoothing_applied"] is True
    assert "identity_preservation_score" in meta


# ---------------------------------------------------------------------------
# 2. Glasses Filter
# ---------------------------------------------------------------------------
def test_glasses_transformation(sample_portrait_bytes, sample_landscape_bytes):
    engine = GlassesFilterEngine()

    # Test with portrait
    port_np = get_numpy_from_bytes(sample_portrait_bytes)
    out_port, meta_port = engine.apply(port_np, intensity=1.0)
    assert out_port.shape == port_np.shape
    assert out_port.dtype == np.uint8
    assert np.mean(np.abs(port_np.astype(float) - out_port.astype(float))) > 0.5

    # Test with non-face image (fallback path)
    land_np = get_numpy_from_bytes(sample_landscape_bytes)
    out_land, meta_land = engine.apply(land_np, intensity=1.0)
    assert out_land.shape == land_np.shape
    assert meta_land["faces_detected"] == 0
    assert np.mean(np.abs(land_np.astype(float) - out_land.astype(float))) > 0.5


# ---------------------------------------------------------------------------
# 3. Beard Filter
# ---------------------------------------------------------------------------
def test_beard_transformation(sample_portrait_bytes, sample_landscape_bytes):
    engine = BeardFilterEngine()

    port_np = get_numpy_from_bytes(sample_portrait_bytes)
    out_port, meta_port = engine.apply(port_np, intensity=1.0)
    assert out_port.shape == port_np.shape
    assert out_port.dtype == np.uint8
    assert np.mean(np.abs(port_np.astype(float) - out_port.astype(float))) > 0.5

    # Non-face fallback
    land_np = get_numpy_from_bytes(sample_landscape_bytes)
    out_land, meta_land = engine.apply(land_np, intensity=1.0)
    assert out_land.shape == land_np.shape
    assert meta_land["faces_detected"] == 0
    assert np.mean(np.abs(land_np.astype(float) - out_land.astype(float))) > 0.5


# ---------------------------------------------------------------------------
# 4. Cartoon Filter
# ---------------------------------------------------------------------------
def test_cartoon_transformation(sample_portrait_bytes):
    engine = CartoonFilterEngine()
    img_np = get_numpy_from_bytes(sample_portrait_bytes)

    out_np, meta = engine.apply(img_np, intensity=1.0)
    assert out_np.shape == img_np.shape
    assert out_np.dtype == np.uint8

    # Stylization check: Cartoon quantization and edges produce significant pixel variance
    diff = np.abs(img_np.astype(float) - out_np.astype(float))
    mae = np.mean(diff)
    assert mae > 2.0, f"Cartoon filter must significantly stylize pixels (MAE={mae})"
    assert meta["provider"] == "local_cv"


# ---------------------------------------------------------------------------
# 5. Anime Filter
# ---------------------------------------------------------------------------
def test_anime_transformation(sample_portrait_bytes):
    engine = AnimeFilterEngine()
    img_np = get_numpy_from_bytes(sample_portrait_bytes)

    out_np, meta = engine.apply(img_np, intensity=1.0)
    assert out_np.shape == img_np.shape
    assert out_np.dtype == np.uint8

    diff = np.abs(img_np.astype(float) - out_np.astype(float))
    mae = np.mean(diff)
    assert mae > 2.0, f"Anime filter must produce visible pastel/edge grading (MAE={mae})"


# ---------------------------------------------------------------------------
# 6. Chibi 3D Filter
# ---------------------------------------------------------------------------
def test_chibi_3d_transformation(sample_portrait_bytes):
    engine = Chibi3DFilterEngine()
    img_np = get_numpy_from_bytes(sample_portrait_bytes)

    out_np, meta = engine.apply(img_np, intensity=1.0)
    assert out_np.shape == img_np.shape
    assert out_np.dtype == np.uint8

    diff = np.abs(img_np.astype(float) - out_np.astype(float))
    mae = np.mean(diff)
    assert mae > 2.0, f"Chibi 3D filter must produce clay diffusion and lighting (MAE={mae})"
    # Check 2D accurate labeling requirement
    assert meta["stylization_type"] == "2d_image_processing"


# ---------------------------------------------------------------------------
# Registry & Intensity Consistency
# ---------------------------------------------------------------------------
def test_all_six_filters_registered():
    """Verify all 6 required filters are present in the ImageProcessor registry."""
    registered = image_processor.get_supported_filters()
    expected = ["beard", "glasses", "beauty_makeup", "anime", "cartoon", "chibi_3d"]
    for exp in expected:
        assert exp in registered, f"Filter '{exp}' is missing from processor registry"


def test_intensity_scaling(sample_portrait_bytes):
    """Verify higher intensity produces stronger pixel transformations."""
    engine = CartoonFilterEngine()
    img_np = get_numpy_from_bytes(sample_portrait_bytes)

    out_low, _ = engine.apply(img_np, intensity=0.2)
    out_high, _ = engine.apply(img_np, intensity=1.0)

    mae_low = np.mean(np.abs(img_np.astype(float) - out_low.astype(float)))
    mae_high = np.mean(np.abs(img_np.astype(float) - out_high.astype(float)))

    assert mae_high >= mae_low, f"Higher intensity ({mae_high}) should equal or exceed lower intensity ({mae_low})"

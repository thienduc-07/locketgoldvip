import io
import pytest
from PIL import Image
from app.schemas.photobooth import PhotoboothLayout, PhotoboothConfig
from app.services.photobooth import photobooth_service
from app.services.image_validator import ImageValidationError


@pytest.mark.asyncio
async def test_photobooth_2cut_vertical(sample_portrait_bytes, sample_landscape_bytes):
    """Verify 2-cut vertical layout composes exactly 2 images into a vertical stack."""
    config = PhotoboothConfig(
        layout=PhotoboothLayout.TWO_CUT_VERTICAL,
        slot_width=400,
        slot_height=300,
        outer_margin=20,
        inner_spacing=15,
        footer_space=50
    )
    resp = await photobooth_service.compose([sample_portrait_bytes, sample_landscape_bytes], config)

    assert resp.status == "success"
    assert resp.photo_count == 2
    assert resp.layout == "2cut_vertical"
    assert resp.output_image.startswith("data:image/jpeg;base64,")

    # Expected dimensions:
    # W = 20 * 2 + 400 = 440
    # H = 20 * 2 + 300 * 2 + 15 + 50 = 40 + 600 + 15 + 50 = 705
    assert resp.dimensions.width == 440
    assert resp.dimensions.height == 705


@pytest.mark.asyncio
async def test_photobooth_2cut_horizontal(sample_portrait_bytes, sample_landscape_bytes):
    """Verify 2-cut horizontal layout composes 2 images side-by-side."""
    config = PhotoboothConfig(
        layout=PhotoboothLayout.TWO_CUT_HORIZONTAL,
        slot_width=300,
        slot_height=400,
        outer_margin=20,
        inner_spacing=10,
        footer_space=0
    )
    resp = await photobooth_service.compose([sample_portrait_bytes, sample_landscape_bytes], config)

    assert resp.status == "success"
    assert resp.photo_count == 2
    # W = 20 * 2 + 300 * 2 + 10 = 650
    # H = 20 * 2 + 400 + 0 = 440
    assert resp.dimensions.width == 650
    assert resp.dimensions.height == 440


@pytest.mark.asyncio
async def test_photobooth_4cut_strip(sample_portrait_bytes, sample_landscape_bytes, sample_png_bytes, sample_webp_bytes):
    """Verify 4-cut strip layout composes 4 images in a single vertical strip."""
    config = PhotoboothConfig(
        layout=PhotoboothLayout.FOUR_CUT_STRIP,
        slot_width=400,
        slot_height=300,
        outer_margin=25,
        inner_spacing=15,
        footer_space=60,
        background_color="#FFD6E0"
    )
    images = [sample_portrait_bytes, sample_landscape_bytes, sample_png_bytes, sample_webp_bytes]
    resp = await photobooth_service.compose(images, config)

    assert resp.status == "success"
    assert resp.photo_count == 4
    # W = 25 * 2 + 400 = 450
    # H = 25 * 2 + 4 * 300 + 3 * 15 + 60 = 50 + 1200 + 45 + 60 = 1355
    assert resp.dimensions.width == 450
    assert resp.dimensions.height == 1355


@pytest.mark.asyncio
async def test_photobooth_4cut_grid(sample_portrait_bytes, sample_landscape_bytes, sample_png_bytes, sample_webp_bytes):
    """Verify 4-cut grid layout composes 4 images in a 2x2 grid."""
    config = PhotoboothConfig(
        layout=PhotoboothLayout.FOUR_CUT_GRID,
        slot_width=300,
        slot_height=300,
        outer_margin=30,
        inner_spacing=20,
        footer_space=70
    )
    images = [sample_portrait_bytes, sample_landscape_bytes, sample_png_bytes, sample_webp_bytes]
    resp = await photobooth_service.compose(images, config)

    assert resp.status == "success"
    assert resp.photo_count == 4
    # W = 30 * 2 + 2 * 300 + 20 = 60 + 600 + 20 = 680
    # H = 30 * 2 + 2 * 300 + 20 + 70 = 60 + 600 + 20 + 70 = 750
    assert resp.dimensions.width == 680
    assert resp.dimensions.height == 750


@pytest.mark.asyncio
async def test_photobooth_png_export(sample_portrait_bytes, sample_landscape_bytes):
    """Verify PNG export format generates valid image/png data URI."""
    config = PhotoboothConfig(
        layout=PhotoboothLayout.TWO_CUT_VERTICAL,
        output_format="png"
    )
    resp = await photobooth_service.compose([sample_portrait_bytes, sample_landscape_bytes], config)
    assert resp.status == "success"
    assert resp.output_image.startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_photobooth_invalid_photo_count(sample_portrait_bytes):
    """Verify passing mismatched photo count produces clear validation rejection."""
    # 2-cut vertical requires 2 images, but only 1 is given
    config_2cut = PhotoboothConfig(layout=PhotoboothLayout.TWO_CUT_VERTICAL)
    resp_2cut = await photobooth_service.compose([sample_portrait_bytes], config_2cut)
    assert resp_2cut.status == "failed"
    assert "requires exactly 2 images" in resp_2cut.error

    # 4-cut strip requires 4 images, but only 2 are given
    config_4cut = PhotoboothConfig(layout=PhotoboothLayout.FOUR_CUT_STRIP)
    resp_4cut = await photobooth_service.compose([sample_portrait_bytes, sample_portrait_bytes], config_4cut)
    assert resp_4cut.status == "failed"
    assert "requires exactly 4 images" in resp_4cut.error


@pytest.mark.asyncio
async def test_photobooth_aspect_ratio_cover():
    """Verify crop_and_resize_cover produces exact target dimensions without distortion."""
    # Wide source image
    wide_img = Image.new("RGB", (800, 300), (255, 0, 0))
    res_wide = photobooth_service.crop_and_resize_cover(wide_img, 400, 400)
    assert res_wide.size == (400, 400)

    # Tall source image
    tall_img = Image.new("RGB", (300, 800), (0, 255, 0))
    res_tall = photobooth_service.crop_and_resize_cover(tall_img, 400, 400)
    assert res_tall.size == (400, 400)

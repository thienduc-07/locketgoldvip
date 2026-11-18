import io
import pytest
import numpy as np
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture(scope="session")
def client():
    """Reusable FastAPI test client."""
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def sample_portrait_bytes() -> bytes:
    """
    Generates a synthetic 400x500 portrait image with a skin-toned face,
    eyes, nose, mouth, and hair so Haar Cascades or facial heuristics have real features.
    """
    img = Image.new("RGB", (400, 500), (220, 225, 230))
    draw = ImageDraw.Draw(img)

    # Hair (dark background oval)
    draw.ellipse((80, 50, 320, 420), fill=(40, 30, 25))

    # Face (skin tone: #E8B99A -> RGB 232, 185, 154)
    draw.ellipse((100, 100, 300, 380), fill=(232, 185, 154))

    # Neck
    draw.rectangle((160, 360, 240, 480), fill=(215, 168, 140))

    # Eyes (left and right)
    draw.ellipse((140, 190, 180, 220), fill=(255, 255, 255))
    draw.ellipse((153, 198, 167, 212), fill=(50, 40, 35))

    draw.ellipse((220, 190, 260, 220), fill=(255, 255, 255))
    draw.ellipse((233, 198, 247, 212), fill=(50, 40, 35))

    # Eyebrows
    draw.arc((135, 175, 185, 195), 180, 360, fill=(40, 30, 25), width=3)
    draw.arc((215, 175, 265, 195), 180, 360, fill=(40, 30, 25), width=3)

    # Nose
    draw.line([(200, 210), (195, 260), (205, 260)], fill=(190, 140, 115), width=3)

    # Mouth / Lips (reddish pink)
    draw.ellipse((170, 295, 230, 325), fill=(205, 95, 105))
    draw.line([(175, 310), (225, 310)], fill=(150, 50, 60), width=2)

    bio = io.BytesIO()
    img.save(bio, format="JPEG", quality=95)
    return bio.getvalue()


@pytest.fixture(scope="session")
def sample_landscape_bytes() -> bytes:
    """Generates a 300x300 non-facial gradient image."""
    arr = np.zeros((300, 300, 3), dtype=np.uint8)
    for y in range(300):
        for x in range(300):
            arr[y, x] = [int(x / 300 * 255), int(y / 300 * 255), 128]
    img = Image.fromarray(arr)
    bio = io.BytesIO()
    img.save(bio, format="JPEG", quality=95)
    return bio.getvalue()


@pytest.fixture(scope="session")
def sample_png_bytes() -> bytes:
    """Generates a 200x200 valid PNG image."""
    img = Image.new("RGB", (200, 200), (100, 150, 200))
    draw = ImageDraw.Draw(img)
    draw.rectangle((50, 50, 150, 150), fill=(255, 200, 100))
    bio = io.BytesIO()
    img.save(bio, format="PNG")
    return bio.getvalue()


@pytest.fixture(scope="session")
def sample_webp_bytes() -> bytes:
    """Generates a 200x200 valid WebP image."""
    img = Image.new("RGB", (200, 200), (50, 200, 120))
    bio = io.BytesIO()
    img.save(bio, format="WEBP")
    return bio.getvalue()


@pytest.fixture(scope="session")
def corrupted_image_bytes() -> bytes:
    """Generates a corrupted image payload (starts with JPEG header, followed by random garbage)."""
    return b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"CORRUPTED_TRUNCATED_STREAM" * 10


@pytest.fixture(scope="session")
def tiny_image_bytes() -> bytes:
    """Generates a 32x32 image (violates minimum 64x64 dimension)."""
    img = Image.new("RGB", (32, 32), (255, 0, 0))
    bio = io.BytesIO()
    img.save(bio, format="JPEG")
    return bio.getvalue()

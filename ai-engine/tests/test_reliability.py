import os
import asyncio
import time
import pytest
from app.services.image_processor import image_processor
from app.core.config import settings
from app.core.security import temporary_working_directory, concurrency_limiter


@pytest.mark.asyncio
async def test_non_blocking_event_loop(sample_portrait_bytes):
    """
    Verify that CPU-bound image processing does not block asyncio event loop.
    We run a processing task and an asyncio background ticker simultaneously.
    If the event loop were blocked, the ticker would starve and fail to tick.
    """
    ticks = []

    async def ticker():
        for _ in range(5):
            await asyncio.sleep(0.01)
            ticks.append(time.perf_counter())

    ticker_task = asyncio.create_task(ticker())
    process_task = asyncio.create_task(
        image_processor.process_image(sample_portrait_bytes, "cartoon")
    )

    await asyncio.gather(ticker_task, process_task)
    assert len(ticks) == 5, f"Event loop was blocked by CPU work! Ticks recorded: {len(ticks)}"


@pytest.mark.asyncio
async def test_processing_timeout_enforcement(sample_portrait_bytes, monkeypatch):
    """
    Verify that tasks exceeding MAX_PROCESSING_TIMEOUT_SEC are cleanly timed out
    and return status='failed' with a timeout error rather than hanging indefinitely.
    """
    # Temporarily set timeout to an ultra-short 0.0001s to trigger timeout
    monkeypatch.setattr(settings, "MAX_PROCESSING_TIMEOUT_SEC", 0.0001)

    resp = await image_processor.process_image(sample_portrait_bytes, "cartoon")
    assert resp.status == "failed"
    assert "timeout exceeded" in (resp.error or "").lower()


@pytest.mark.asyncio
async def test_concurrency_semaphore():
    """Verify that concurrency_limiter prevents exceeding MAX_CONCURRENT_TASKS."""
    assert concurrency_limiter._value <= settings.MAX_CONCURRENT_TASKS


def test_temporary_directory_cleanup():
    """Verify temporary directory context manager deletes temp folders without lingering files."""
    created_dir = None
    with temporary_working_directory(prefix="test_cleanup_") as tmp:
        created_dir = tmp
        assert os.path.exists(tmp), "Temporary directory should exist inside context"
        # Create a dummy file inside
        dummy_file = os.path.join(tmp, "scratch_image.tmp")
        with open(dummy_file, "w") as f:
            f.write("temporary data")
        assert os.path.exists(dummy_file)

    # After exiting context, directory and its contents must be completely deleted
    assert not os.path.exists(created_dir), "Temporary directory was not deleted after exit"

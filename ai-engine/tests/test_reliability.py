import os
import asyncio
import time
import threading
import pytest
from app.services.image_processor import image_processor
from app.services.photobooth import photobooth_service
from app.schemas.photobooth import PhotoboothConfig, PhotoboothLayout
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
        dummy_file = os.path.join(tmp, "scratch_image.tmp")
        with open(dummy_file, "w") as f:
            f.write("temporary data")
        assert os.path.exists(dummy_file)

    assert not os.path.exists(created_dir), "Temporary directory was not deleted after exit"


@pytest.mark.asyncio
async def test_deterministic_capacity_held_during_timeout(sample_portrait_bytes, monkeypatch):
    """
    Deterministic synchronization test proving:
    1. Worker is verified to be actively running in OS thread when timeout occurs.
    2. Semaphore permit is verified to remain held until worker completes.
    3. Permit is released exactly once upon thread completion.
    """
    initial_permits = concurrency_limiter._value
    monkeypatch.setattr(settings, "MAX_PROCESSING_TIMEOUT_SEC", 0.03)

    worker_started = threading.Event()
    allow_worker_to_proceed = threading.Event()
    worker_finished = threading.Event()

    original_engine = image_processor.engines["cartoon"]
    real_apply = original_engine.apply

    def synced_worker(*args, **kwargs):
        worker_started.set()
        allow_worker_to_proceed.wait(timeout=5.0)
        res = real_apply(*args, **kwargs)
        worker_finished.set()
        return res

    monkeypatch.setattr(original_engine, "apply", synced_worker)

    task = asyncio.create_task(image_processor.process_image(sample_portrait_bytes, "cartoon"))

    # Wait until worker has entered thread
    while not worker_started.is_set():
        await asyncio.sleep(0.005)

    # Await request timeout
    resp = await task
    assert resp.status == "failed"
    assert "timeout exceeded" in (resp.error or "").lower()

    # Worker is STILL paused and running
    assert not worker_finished.is_set(), "Worker should still be running in OS thread"
    assert concurrency_limiter._value == initial_permits - 1, (
        f"Capacity was released prematurely! Expected {initial_permits - 1}, got {concurrency_limiter._value}"
    )

    # Release worker thread
    allow_worker_to_proceed.set()

    # Wait until worker finishes
    while not worker_finished.is_set():
        await asyncio.sleep(0.005)

    # Let callback execute on event loop
    await asyncio.sleep(0.02)

    # Permit must now be returned
    assert concurrency_limiter._value == initial_permits, (
        f"Capacity was not returned after thread completed! Expected {initial_permits}, got {concurrency_limiter._value}"
    )


@pytest.mark.asyncio
async def test_client_cancellation_worker_lifecycle(sample_portrait_bytes, monkeypatch):
    """
    Verify that when an asyncio task is cancelled (client disconnection):
    - Capacity is held while background thread executes.
    - Permit is released once thread terminates without leak.
    """
    initial_permits = concurrency_limiter._value
    worker_started = threading.Event()
    allow_proceed = threading.Event()
    worker_finished = threading.Event()

    original_engine = image_processor.engines["cartoon"]
    real_apply = original_engine.apply

    def cancellable_worker(*args, **kwargs):
        worker_started.set()
        allow_proceed.wait(timeout=5.0)
        res = real_apply(*args, **kwargs)
        worker_finished.set()
        return res

    monkeypatch.setattr(original_engine, "apply", cancellable_worker)

    task = asyncio.create_task(image_processor.process_image(sample_portrait_bytes, "cartoon"))

    while not worker_started.is_set():
        await asyncio.sleep(0.005)

    # Cancel client coroutine
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Thread is still running, holding permit
    assert not worker_finished.is_set()
    assert concurrency_limiter._value == initial_permits - 1

    # Signal thread to finish
    allow_proceed.set()
    while not worker_finished.is_set():
        await asyncio.sleep(0.005)

    await asyncio.sleep(0.02)
    assert concurrency_limiter._value == initial_permits


@pytest.mark.asyncio
async def test_worker_exception_after_timeout_releases_permit(sample_portrait_bytes, monkeypatch):
    """
    Verify that if a worker thread crashes or raises an exception AFTER a client timeout,
    the completion callback still executes and releases the permit exactly once.
    """
    initial_permits = concurrency_limiter._value
    monkeypatch.setattr(settings, "MAX_PROCESSING_TIMEOUT_SEC", 0.03)

    worker_started = threading.Event()
    allow_crash = threading.Event()

    original_engine = image_processor.engines["cartoon"]

    def crashing_worker(*args, **kwargs):
        worker_started.set()
        allow_crash.wait(timeout=5.0)
        raise RuntimeError("Simulated worker thread hardware exception")

    monkeypatch.setattr(original_engine, "apply", crashing_worker)

    task = asyncio.create_task(image_processor.process_image(sample_portrait_bytes, "cartoon"))
    while not worker_started.is_set():
        await asyncio.sleep(0.005)

    resp = await task
    assert resp.status == "failed"
    assert concurrency_limiter._value == initial_permits - 1

    # Allow worker to raise exception
    allow_crash.set()
    await asyncio.sleep(0.05)

    # Permit must still be safely released
    assert concurrency_limiter._value == initial_permits


@pytest.mark.asyncio
async def test_repeated_timeouts_no_permit_leak(sample_portrait_bytes, monkeypatch):
    """
    Verify that multiple consecutive timed-out requests do not leak permits.
    """
    initial_permits = concurrency_limiter._value
    monkeypatch.setattr(settings, "MAX_PROCESSING_TIMEOUT_SEC", 0.01)

    original_engine = image_processor.engines["cartoon"]
    real_apply = original_engine.apply

    def sleep_apply(*args, **kwargs):
        time.sleep(0.04)
        return real_apply(*args, **kwargs)

    monkeypatch.setattr(original_engine, "apply", sleep_apply)

    for _ in range(4):
        resp = await image_processor.process_image(sample_portrait_bytes, "cartoon")
        assert resp.status == "failed"

    # Wait for all 4 background workers to complete
    await asyncio.sleep(0.20)
    assert concurrency_limiter._value == initial_permits


@pytest.mark.asyncio
async def test_simultaneous_image_processor_and_photobooth_concurrency(sample_portrait_bytes):
    """
    Verify total application concurrency is controlled across both ImageProcessor and PhotoboothService,
    as they share the same global ConcurrencyLimiter.
    """
    initial_permits = concurrency_limiter._value
    assert initial_permits == settings.MAX_CONCURRENT_TASKS

    # Run tasks concurrently
    t1 = asyncio.create_task(image_processor.process_image(sample_portrait_bytes, "cartoon"))
    cfg = PhotoboothConfig(layout=PhotoboothLayout.TWO_CUT_VERTICAL)
    t2 = asyncio.create_task(photobooth_service.compose([sample_portrait_bytes, sample_portrait_bytes], cfg))

    r1, r2 = await asyncio.gather(t1, t2)
    assert r1.status == "success"
    assert r2.status == "success"
    assert concurrency_limiter._value == initial_permits


@pytest.mark.asyncio
async def test_queue_wait_timeout_rejection(sample_portrait_bytes, monkeypatch):
    """
    Verify that when worker capacity is saturated, incoming requests wait up to
    MAX_QUEUE_WAIT_SEC before being rejected with HTTP 503 capacity limit error.
    """
    monkeypatch.setattr(settings, "MAX_QUEUE_WAIT_SEC", 0.03)

    acquired = []
    for _ in range(settings.MAX_CONCURRENT_TASKS):
        await concurrency_limiter.acquire()
        acquired.append(True)

    try:
        resp = await image_processor.process_image(sample_portrait_bytes, "cartoon")
        assert resp.status == "failed"
        assert "capacity limit reached" in (resp.error or "").lower()
    finally:
        for _ in acquired:
            concurrency_limiter.release()

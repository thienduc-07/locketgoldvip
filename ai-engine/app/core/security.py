import os
import shutil
import asyncio
import tempfile
from contextlib import contextmanager
from typing import Generator
from app.core.config import settings

class ConcurrencyLimiter:
    """
    Thread-safe & EventLoop-aware Concurrency Limiter.
    Dynamically binds to the active asyncio event loop, preventing cross-loop
    Future attachment issues during test runner restarts and server lifecycle events,
    while supporting safe release from background worker threads.
    """
    def __init__(self, limit: int):
        self.limit = limit
        self._sem = None
        self._loop = None

    def _get_sem(self) -> asyncio.Semaphore:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        if self._sem is None or self._loop != current_loop or (self._loop and self._loop.is_closed()):
            self._sem = asyncio.Semaphore(self.limit)
            self._loop = current_loop
        return self._sem

    async def acquire(self) -> bool:
        return await self._get_sem().acquire()

    def release(self) -> None:
        self._get_sem().release()

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.release()

    def safe_release_from_thread(self, target_loop: asyncio.AbstractEventLoop) -> None:
        """Safely dispatches release onto target loop if loop is still running."""
        if target_loop and not target_loop.is_closed():
            try:
                target_loop.call_soon_threadsafe(self.release)
            except RuntimeError:
                pass

    @property
    def _value(self) -> int:
        return self._get_sem()._value


# Global concurrency limiter ensuring server hardware is never overwhelmed
concurrency_limiter = ConcurrencyLimiter(settings.MAX_CONCURRENT_TASKS)


@contextmanager
def temporary_working_directory(prefix: str = "locket_ai_") -> Generator[str, None, None]:
    """
    Context manager that allocates a dedicated, isolated temporary directory
    for processing an image session, and guarantees 100% cleanup upon exit.
    Prevents image retention and ensures privacy.
    """
    os.makedirs(settings.TEMP_DIR, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix=prefix, dir=settings.TEMP_DIR)
    try:
        yield temp_dir
    finally:
        # Strictly delete all files created in this session
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)


def sanitize_filename(filename: str) -> str:
    """Sanitize input filename to prevent directory traversal attacks."""
    clean = os.path.basename(filename)
    return clean.replace("..", "").replace("/", "").replace("\\", "")

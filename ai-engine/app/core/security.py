import os
import shutil
import asyncio
import tempfile
from contextlib import contextmanager
from typing import Generator
from app.core.config import settings

# Global concurrency limiter ensuring server hardware is never overwhelmed
concurrency_limiter = asyncio.Semaphore(settings.MAX_CONCURRENT_TASKS)


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

# syntax=docker/dockerfile:1
FROM python:3.9-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install runtime libraries for OpenCV and healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install pinned Python dependencies via binary wheels (no gcc required)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create unprivileged application user
RUN useradd -m -u 1000 appuser && \
    mkdir -p /tmp/ai_engine /app && \
    chown -R appuser:appuser /app /tmp/ai_engine

# Copy application source code only (secrets & envs are excluded via .dockerignore)
COPY --chown=appuser:appuser app/ ./app/

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--access-log"]

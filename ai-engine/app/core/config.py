import os
from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )

    APP_NAME: str = "Locket AI Filter Engine"
    APP_ENV: str = "development"
    DEBUG: bool = True
    PORT: int = 8000
    HOST: str = "0.0.0.0"

    # Security & Input Constraints
    MAX_UPLOAD_SIZE_MB: int = 10
    MIN_IMAGE_DIMENSION: int = 64
    MAX_IMAGE_DIMENSION: int = 4096
    MAX_PROCESSING_TIMEOUT_SEC: float = 15.0
    MAX_CONCURRENT_TASKS: int = 5
    MAX_QUEUE_WAIT_SEC: float = 2.0
    TEMP_DIR: str = "/tmp/ai_engine"

    # CORS Policy Settings
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:8000"
    CORS_ALLOW_CREDENTIALS: bool = False

    @property
    def cors_origins_list(self) -> List[str]:
        if not self.CORS_ORIGINS or self.CORS_ORIGINS.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    # MIME types allowed
    ALLOWED_MIME_TYPES: List[str] = [
        "image/jpeg",
        "image/png",
        "image/webp"
    ]

    # Generative AI Provider settings
    GENERATIVE_PROVIDER: str = "local_cv"  # local_cv, fal_ai, replicate, huggingface
    FAL_KEY: Optional[str] = None
    REPLICATE_API_TOKEN: Optional[str] = None
    HUGGINGFACE_API_KEY: Optional[str] = None


settings = Settings()

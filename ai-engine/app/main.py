import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.api.health import router as health_router
from app.api.filters import router as filters_router
from app.api.photobooth import router as photobooth_router
from app.services.image_validator import (
    ImageValidationError,
    ImageSizeLimitError,
    ImageFormatError,
    ImageCorruptedError
)

# Structured Logging Setup
logging.basicConfig(
    level=logging.INFO if not settings.DEBUG else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("locket_ai_engine")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup & shutdown events."""
    logger.info(f"Starting {settings.APP_NAME} in '{settings.APP_ENV}' mode...")
    logger.info(f"Concurrency Limit: {settings.MAX_CONCURRENT_TASKS} concurrent tasks")
    logger.info(f"Processing Timeout: {settings.MAX_PROCESSING_TIMEOUT_SEC}s")
    yield
    logger.info(f"Shutting down {settings.APP_NAME}...")


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="Independent AI Image Processing & Photobooth Engine for Locket Gold VIP",
    lifespan=lifespan
)

# Security Headers Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# CORS Configuration
origins = settings.cors_origins_list
allow_creds = settings.CORS_ALLOW_CREDENTIALS and ("*" not in origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_creds,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Centralized Exception Handlers
@app.exception_handler(ImageSizeLimitError)
async def image_size_limit_handler(request: Request, exc: ImageSizeLimitError):
    logger.warning(f"Upload size exceeded on {request.url.path}: {str(exc)}")
    return JSONResponse(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        content={
            "status": "failed",
            "error_type": "ImageSizeLimitError",
            "detail": str(exc)
        }
    )


@app.exception_handler(ImageFormatError)
async def image_format_handler(request: Request, exc: ImageFormatError):
    logger.warning(f"Unsupported format on {request.url.path}: {str(exc)}")
    return JSONResponse(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        content={
            "status": "failed",
            "error_type": "ImageFormatError",
            "detail": str(exc)
        }
    )


@app.exception_handler(ImageCorruptedError)
async def image_corrupted_handler(request: Request, exc: ImageCorruptedError):
    logger.warning(f"Corrupted or invalid image data on {request.url.path}: {str(exc)}")
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "status": "failed",
            "error_type": "ImageCorruptedError",
            "detail": str(exc)
        }
    )


@app.exception_handler(ImageValidationError)
async def image_validation_exception_handler(request: Request, exc: ImageValidationError):
    logger.warning(f"Validation rejection on {request.url.path}: {str(exc)}")
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={
            "status": "failed",
            "error_type": "ImageValidationError",
            "detail": str(exc)
        }
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.url.path}: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "status": "error",
            "error_type": "InternalServerError",
            "detail": "An internal error occurred during image processing."
        }
    )


# Mount API Routers
app.include_router(health_router)
app.include_router(filters_router)
app.include_router(photobooth_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)

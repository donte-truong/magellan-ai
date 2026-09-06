import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware

from app.api import router
from app.config import Settings
from app.db import Database, new_id
from app.errors import APIError
from app.geography import GeographyService
from app.providers import build_provider
from app.worker import Worker

logger = logging.getLogger(__name__)


def error_response(request, status, code, message, details=None, headers=None):
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "code": code,
                "message": message,
                "details": details or {},
                "request_id": getattr(request.state, "request_id", new_id("req")),
            }
        },
        headers=headers,
    )


def create_app(settings=None, provider=None):
    settings = settings or Settings()
    db = Database(settings.database_url)
    provider = provider or build_provider(settings)
    geography = GeographyService(settings.production_data_path)

    @asynccontextmanager
    async def lifespan(app):
        if settings.auto_create_schema:
            db.create_schema()
        task = asyncio.create_task(app.state.worker.serve()) if settings.embedded_worker else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            db.engine.dispose()

    app = FastAPI(
        title="Magellan Supply Chain API",
        version="1.0.0",
        lifespan=lifespan,
        description="Implements API_SPEC sections 2.1–2.6 and evidence-backed BOM decomposition.",
    )
    app.state.settings, app.state.db, app.state.provider, app.state.geography = (
        settings,
        db,
        provider,
        geography,
    )
    app.state.worker = Worker(db, settings, provider, geography)
    app.state.estimate_active = 0

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = new_id("req")
        try:
            if request.method in {"POST", "PUT", "PATCH"}:
                # Enforced on actual received bytes as well as Content-Length, including chunked requests.
                # The BOM estimate accepts a photo (5 MB raw, larger as base64 JSON).
                maximum = 1024 * 1024 + 65536
                if request.url.path == "/v1/bom":
                    maximum = 8 * 1024 * 1024 + 65536
                declared = request.headers.get("content-length")
                if declared and (not declared.isdecimal() or int(declared) > maximum):
                    raise APIError(413, "invalid_input", "Request body exceeds the size limit")
                chunks, total = [], 0
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > maximum:
                        raise APIError(413, "invalid_input", "Request body exceeds the size limit")
                    chunks.append(chunk)
                request._body = b"".join(chunks)
            response = await call_next(request)
        except APIError as exc:
            response = error_response(
                request, exc.status, exc.code, exc.message, exc.details, exc.headers
            )
        except Exception:
            logger.exception("Unhandled request error: %s", request.state.request_id)
            response = error_response(request, 500, "internal", "An unexpected error occurred")
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(APIError)
    async def api_error(request, exc):
        return error_response(request, exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def validation_error(request, exc):
        errors = [
            {"loc": list(e["loc"]), "type": e["type"], "message": e["msg"]} for e in exc.errors()
        ]
        return error_response(
            request, 400, "invalid_input", "Request validation failed", {"errors": errors}
        )

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error_response(
            request,
            exc.status_code,
            "not_found" if exc.status_code == 404 else "invalid_input",
            str(exc.detail),
            headers=exc.headers,
        )

    @app.get("/healthz", include_in_schema=False)
    def health():
        from sqlalchemy import text

        with db.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"status": "ok"}

    app.include_router(router)
    default_openapi = app.openapi

    def openapi():
        schema = default_openapi()
        schema["components"]["schemas"]["ErrorResponse"] = {
            "type": "object",
            "required": ["error"],
            "properties": {
                "error": {
                    "type": "object",
                    "required": ["code", "message", "details", "request_id"],
                    "properties": {
                        "code": {"type": "string"},
                        "message": {"type": "string"},
                        "details": {"type": "object"},
                        "request_id": {"type": "string"},
                    },
                }
            },
        }
        for path in schema["paths"].values():
            for operation in path.values():
                responses = operation.get("responses", {})
                responses.pop("422", None)
                for status in ("400", "401", "404", "409", "429", "500"):
                    responses.setdefault(
                        status,
                        {
                            "description": "API error",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                                }
                            },
                        },
                    )
                if "201" in responses or "202" in responses:
                    responses["200"] = {
                        **responses.get("201", responses.get("202")),
                        "description": "Idempotent replay",
                    }
        return schema

    app.openapi = openapi
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "If-Match",
            "Last-Event-ID",
        ],
        expose_headers=["ETag", "X-Request-ID", "Retry-After", "Content-Disposition"],
    )
    return app


app = create_app()

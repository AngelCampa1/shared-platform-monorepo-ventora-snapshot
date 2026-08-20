from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AppError(Exception):
    status: int
    message: str
    code: str | None = field(default=None)

    def __str__(self) -> str:
        return self.message

    def __post_init__(self) -> None:
        super().__init__(self.message)


class NotFoundError(AppError):
    def __init__(self, message: str = "Not found") -> None:
        super().__init__(status=404, message=message)


class UnauthorizedError(AppError):
    def __init__(self, message: str = "Unauthorized") -> None:
        super().__init__(status=401, message=message)


class ForbiddenError(AppError):
    def __init__(self, message: str = "Forbidden") -> None:
        super().__init__(status=403, message=message)


class ValidationError(AppError):
    def __init__(self, message: str = "Validation error", code: str | None = None) -> None:
        super().__init__(status=422, message=message, code=code)


class ConflictError(AppError):
    def __init__(self, message: str = "Conflict") -> None:
        super().__init__(status=409, message=message)


class RateLimitError(AppError):
    def __init__(self, message: str = "Too many requests") -> None:
        super().__init__(status=429, message=message)


def build_internal_error_body(tracking_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": "Something went wrong. Please try again."}
    if tracking_id:
        body["trackingId"] = tracking_id
    return body


def to_user_facing_error(err: Exception) -> dict[str, Any]:
    if isinstance(err, AppError):
        return {"message": err.message, "reportable": err.status >= 500}
    return {"message": "Something went wrong. Please try again.", "reportable": True}


def make_fastapi_exception_handler() -> Callable[..., Any] | None:
    """Returns a FastAPI exception handler for AppError. Import fastapi lazily."""
    try:
        from fastapi import Request
        from fastapi.responses import JSONResponse

        async def handler(request: Request, exc: AppError) -> JSONResponse:
            return JSONResponse(
                status_code=exc.status,
                content={"error": exc.message, **({"code": exc.code} if exc.code else {})},
            )

        return handler
    except ImportError:
        return None

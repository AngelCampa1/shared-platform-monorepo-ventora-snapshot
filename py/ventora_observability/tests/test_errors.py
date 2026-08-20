from __future__ import annotations
import pytest

from ventora_observability.errors import (
    AppError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    UnauthorizedError,
    ValidationError,
    build_internal_error_body,
    make_fastapi_exception_handler,
    to_user_facing_error,
)


# ---------------------------------------------------------------------------
# AppError base class
# ---------------------------------------------------------------------------

def test_app_error_stores_status() -> None:
    err = AppError(status=500, message="Internal error")
    assert err.status == 500


def test_app_error_stores_message() -> None:
    err = AppError(status=400, message="Bad request")
    assert err.message == "Bad request"


def test_app_error_stores_code() -> None:
    err = AppError(status=422, message="Invalid", code="INVALID_FIELD")
    assert err.code == "INVALID_FIELD"


def test_app_error_code_defaults_to_none() -> None:
    err = AppError(status=400, message="Bad")
    assert err.code is None


def test_app_error_str_is_message() -> None:
    err = AppError(status=404, message="Not found")
    assert str(err) == "Not found"


def test_app_error_is_exception() -> None:
    err = AppError(status=500, message="Error")
    assert isinstance(err, Exception)


def test_app_error_can_be_raised_and_caught() -> None:
    with pytest.raises(AppError) as exc_info:
        raise AppError(status=503, message="Service unavailable")
    assert exc_info.value.status == 503


# ---------------------------------------------------------------------------
# Subclass status codes
# ---------------------------------------------------------------------------

def test_not_found_error_status_404() -> None:
    assert NotFoundError().status == 404


def test_not_found_error_default_message() -> None:
    assert NotFoundError().message == "Not found"


def test_not_found_error_custom_message() -> None:
    assert NotFoundError("Item missing").message == "Item missing"


def test_unauthorized_error_status_401() -> None:
    assert UnauthorizedError().status == 401


def test_unauthorized_error_default_message() -> None:
    assert UnauthorizedError().message == "Unauthorized"


def test_forbidden_error_status_403() -> None:
    assert ForbiddenError().status == 403


def test_forbidden_error_default_message() -> None:
    assert ForbiddenError().message == "Forbidden"


def test_validation_error_status_422() -> None:
    assert ValidationError().status == 422


def test_validation_error_default_message() -> None:
    assert ValidationError().message == "Validation error"


def test_validation_error_with_code() -> None:
    err = ValidationError("Bad field", code="FIELD_REQUIRED")
    assert err.code == "FIELD_REQUIRED"


def test_conflict_error_status_409() -> None:
    assert ConflictError().status == 409


def test_conflict_error_default_message() -> None:
    assert ConflictError().message == "Conflict"


def test_rate_limit_error_status_429() -> None:
    assert RateLimitError().status == 429


def test_rate_limit_error_default_message() -> None:
    assert RateLimitError().message == "Too many requests"


# ---------------------------------------------------------------------------
# build_internal_error_body
# ---------------------------------------------------------------------------

def test_build_internal_error_body_has_error_key() -> None:
    body = build_internal_error_body()
    assert "error" in body


def test_build_internal_error_body_no_tracking_id() -> None:
    body = build_internal_error_body()
    assert "trackingId" not in body


def test_build_internal_error_body_with_tracking_id() -> None:
    body = build_internal_error_body(tracking_id="track-123")
    assert body["trackingId"] == "track-123"


def test_build_internal_error_body_message_content() -> None:
    body = build_internal_error_body()
    assert "Please try again" in body["error"]


# ---------------------------------------------------------------------------
# to_user_facing_error
# ---------------------------------------------------------------------------

def test_to_user_facing_error_with_4xx_app_error() -> None:
    err = NotFoundError()
    result = to_user_facing_error(err)
    assert result["message"] == "Not found"
    assert result["reportable"] is False


def test_to_user_facing_error_with_5xx_app_error() -> None:
    err = AppError(status=500, message="Internal server error")
    result = to_user_facing_error(err)
    assert result["message"] == "Internal server error"
    assert result["reportable"] is True


def test_to_user_facing_error_with_422_app_error_not_reportable() -> None:
    err = ValidationError("Bad input")
    result = to_user_facing_error(err)
    assert result["reportable"] is False


def test_to_user_facing_error_with_generic_exception() -> None:
    err = RuntimeError("unexpected failure")
    result = to_user_facing_error(err)
    assert result["reportable"] is True
    assert "Please try again" in result["message"]


def test_to_user_facing_error_generic_hides_details() -> None:
    err = ValueError("sensitive internal detail")
    result = to_user_facing_error(err)
    assert "sensitive" not in result["message"]


# ---------------------------------------------------------------------------
# make_fastapi_exception_handler
# ---------------------------------------------------------------------------

def test_make_fastapi_exception_handler_returns_callable() -> None:
    handler = make_fastapi_exception_handler()
    if handler is None:
        pytest.skip("fastapi not available")
    assert callable(handler)


import pytest


@pytest.mark.asyncio
async def test_fastapi_handler_returns_json_response() -> None:
    from unittest.mock import MagicMock
    handler = make_fastapi_exception_handler()
    if handler is None:
        pytest.skip("fastapi not available")

    request = MagicMock()
    err = NotFoundError("Item not found")
    response = await handler(request, err)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_fastapi_handler_includes_code_when_present() -> None:
    from unittest.mock import MagicMock
    import json as json_mod
    handler = make_fastapi_exception_handler()
    if handler is None:
        pytest.skip("fastapi not available")

    request = MagicMock()
    err = ValidationError("Bad field", code="FIELD_REQUIRED")
    response = await handler(request, err)
    body = json_mod.loads(response.body)
    assert body.get("code") == "FIELD_REQUIRED"


@pytest.mark.asyncio
async def test_fastapi_handler_omits_code_when_none() -> None:
    from unittest.mock import MagicMock
    import json as json_mod
    handler = make_fastapi_exception_handler()
    if handler is None:
        pytest.skip("fastapi not available")

    request = MagicMock()
    err = NotFoundError()
    response = await handler(request, err)
    body = json_mod.loads(response.body)
    assert "code" not in body


def test_make_fastapi_exception_handler_returns_none_when_fastapi_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """make_fastapi_exception_handler returns None when fastapi is not installed."""
    import builtins
    import ventora_observability.errors as errors_mod

    real_import = builtins.__import__

    def mock_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "fastapi":
            raise ImportError("fastapi not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", mock_import)
    result = errors_mod.make_fastapi_exception_handler()
    assert result is None

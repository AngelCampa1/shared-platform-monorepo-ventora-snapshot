from __future__ import annotations
import json
import logging
from contextvars import copy_context
from io import StringIO

import pytest

from ventora_observability.logging import JsonFormatter, SensitiveDataFilter, configure_logger
from ventora_observability.correlation import set_correlation_id


# ---------------------------------------------------------------------------
# SensitiveDataFilter tests
# ---------------------------------------------------------------------------

def _make_record(msg: str) -> logging.LogRecord:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg=msg,
        args=(),
        exc_info=None,
    )
    return record


def test_sensitive_filter_scrubs_jwt() -> None:
    jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    record = _make_record(f"Token: {jwt}")
    f = SensitiveDataFilter()
    f.filter(record)
    assert "[jwt]" in record.msg
    assert jwt not in record.msg


def test_sensitive_filter_scrubs_email() -> None:
    record = _make_record("User email is john.doe@example.com in our system")
    f = SensitiveDataFilter()
    f.filter(record)
    assert "[email]" in record.msg
    assert "john.doe@example.com" not in record.msg


def test_sensitive_filter_scrubs_bearer_token() -> None:
    record = _make_record("Authorization: Bearer abc123token456")
    f = SensitiveDataFilter()
    f.filter(record)
    assert "Bearer [token]" in record.msg
    assert "abc123token456" not in record.msg


def test_sensitive_filter_scrubs_message_args() -> None:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="User email is %s",
        args=("jane.doe@example.com",),
        exc_info=None,
    )
    f = SensitiveDataFilter()
    f.filter(record)
    assert record.getMessage() == "User email is [email]"
    assert "jane.doe@example.com" not in record.getMessage()


def test_sensitive_filter_scrubs_extra_fields() -> None:
    record = _make_record("with extras")
    record.api_key = "key-secret-value"  # type: ignore[attr-defined]
    record.user_id = "jane.doe@example.com"  # type: ignore[attr-defined]
    f = SensitiveDataFilter()
    f.filter(record)
    assert record.api_key == "[redacted]"  # type: ignore[attr-defined]
    assert record.user_id == "[email]"  # type: ignore[attr-defined]


def test_sensitive_filter_scrubs_bearer_token_case_insensitive() -> None:
    record = _make_record("header: BEARER mytoken")
    f = SensitiveDataFilter()
    f.filter(record)
    assert "mytoken" not in record.msg


def test_sensitive_filter_passes_clean_message() -> None:
    msg = "User logged in successfully"
    record = _make_record(msg)
    f = SensitiveDataFilter()
    result = f.filter(record)
    assert result is True
    assert record.msg == msg


def test_sensitive_filter_returns_true() -> None:
    record = _make_record("hello")
    f = SensitiveDataFilter()
    assert f.filter(record) is True


# ---------------------------------------------------------------------------
# JsonFormatter tests
# ---------------------------------------------------------------------------

def _format_record(msg: str, level: int = logging.INFO) -> dict:
    record = logging.LogRecord(
        name="test.logger",
        level=level,
        pathname="",
        lineno=0,
        msg=msg,
        args=(),
        exc_info=None,
    )
    formatter = JsonFormatter()
    output = formatter.format(record)
    return json.loads(output)


def test_json_formatter_produces_valid_json() -> None:
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="hello world", args=(), exc_info=None,
    )
    formatter = JsonFormatter()
    output = formatter.format(record)
    parsed = json.loads(output)
    assert isinstance(parsed, dict)


def test_json_formatter_has_required_fields() -> None:
    parsed = _format_record("test message")
    assert "level" in parsed
    assert "logger" in parsed
    assert "message" in parsed
    assert "timestamp" in parsed


def test_json_formatter_level_field() -> None:
    parsed = _format_record("msg", logging.WARNING)
    assert parsed["level"] == "WARNING"


def test_json_formatter_message_field() -> None:
    parsed = _format_record("hello formatter")
    assert parsed["message"] == "hello formatter"


def test_json_formatter_includes_correlation_id_when_set() -> None:
    ctx = copy_context()

    def _run() -> dict:
        set_correlation_id("corr-abc-123")
        return _format_record("with correlation")

    parsed = ctx.run(_run)
    assert parsed.get("correlation_id") == "corr-abc-123"


def test_json_formatter_omits_correlation_id_when_not_set() -> None:
    ctx = copy_context()

    def _run() -> dict:
        return _format_record("no correlation")

    parsed = ctx.run(_run)
    assert "correlation_id" not in parsed


def test_json_formatter_includes_exc_info() -> None:
    try:
        raise ValueError("test error")
    except ValueError:
        import sys
        exc_info = sys.exc_info()
    record = logging.LogRecord(
        name="test", level=logging.ERROR, pathname="", lineno=0,
        msg="error", args=(), exc_info=exc_info,
    )
    formatter = JsonFormatter()
    output = formatter.format(record)
    parsed = json.loads(output)
    assert "exc_info" in parsed
    assert "ValueError" in parsed["exc_info"]


def test_json_formatter_includes_extra_fields() -> None:
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="with extra", args=(), exc_info=None,
    )
    record.request_id = "req-999"  # type: ignore[attr-defined]
    record.route = "/api/test"  # type: ignore[attr-defined]
    formatter = JsonFormatter()
    output = formatter.format(record)
    parsed = json.loads(output)
    assert parsed.get("request_id") == "req-999"
    assert parsed.get("route") == "/api/test"


def test_json_formatter_does_not_leak_scrubbed_extra_values() -> None:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="with extra",
        args=(),
        exc_info=None,
    )
    record.user_id = "jane.doe@example.com"  # type: ignore[attr-defined]
    f = SensitiveDataFilter()
    f.filter(record)
    formatter = JsonFormatter()
    parsed = json.loads(formatter.format(record))
    assert parsed["user_id"] == "[email]"
    assert "jane.doe@example.com" not in json.dumps(parsed)


# ---------------------------------------------------------------------------
# configure_logger tests
# ---------------------------------------------------------------------------

def test_configure_logger_returns_logger() -> None:
    log = configure_logger(logger_name="test.configure.basic")
    assert isinstance(log, logging.Logger)


def test_configure_logger_has_at_least_one_handler() -> None:
    log = configure_logger(logger_name="test.configure.handlers")
    assert len(log.handlers) >= 1


def test_configure_logger_sets_level() -> None:
    log = configure_logger(level="DEBUG", logger_name="test.configure.level")
    assert log.level == logging.DEBUG


def test_configure_logger_default_level_is_info() -> None:
    log = configure_logger(logger_name="test.configure.default.level")
    assert log.level == logging.INFO


def test_configure_logger_json_handler_has_filter() -> None:
    log = configure_logger(logger_name="test.configure.filter")
    handler = log.handlers[0]
    filter_types = [type(f).__name__ for f in handler.filters]
    assert "SensitiveDataFilter" in filter_types


def test_configure_logger_json_formatter() -> None:
    log = configure_logger(use_json=True, logger_name="test.configure.json")
    handler = log.handlers[0]
    assert isinstance(handler.formatter, JsonFormatter)


def test_configure_logger_no_json_formatter() -> None:
    log = configure_logger(use_json=False, logger_name="test.configure.nojson")
    handler = log.handlers[0]
    assert not isinstance(handler.formatter, JsonFormatter)


def test_configure_logger_idempotent() -> None:
    """Calling configure_logger twice on same name does not duplicate handlers."""
    name = "test.configure.idempotent"
    log1 = configure_logger(logger_name=name)
    log2 = configure_logger(logger_name=name)
    assert log1 is log2
    assert len(log1.handlers) == 1

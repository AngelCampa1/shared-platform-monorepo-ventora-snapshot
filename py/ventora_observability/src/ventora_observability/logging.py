from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

from .correlation import get_correlation_id
from .redact import redact

_STANDARD_LOG_RECORD_KEYS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


class SensitiveDataFilter(logging.Filter):
    """Scrubs common PII patterns from log record messages and extra fields."""

    _PATTERNS: list[tuple[re.Pattern[str], str]] = [
        (
            re.compile(
                r"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
            ),
            "[jwt]",
        ),
        (re.compile(r"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*"), "Bearer [token]"),
        (
            re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"),
            "[email]",
        ),
    ]

    _SENSITIVE_KEYS: frozenset[str] = frozenset({
        "password", "passwd", "secret", "token", "api_key", "apikey",
        "access_token", "refresh_token", "auth_token", "authorization",
        "cookie", "session_id",
    })

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._scrub(str(redact(record.getMessage())))
        record.args = ()
        for key, value in vars(record).items():
            if key in _STANDARD_LOG_RECORD_KEYS:
                continue
            if key.lower() in self._SENSITIVE_KEYS:
                setattr(record, key, "[redacted]")
            else:
                setattr(record, key, redact(value))
        return True

    def _scrub(self, text: str) -> str:
        for pattern, replacement in self._PATTERNS:
            text = pattern.sub(replacement, text)
        return text


class JsonFormatter(logging.Formatter):
    """Emits a single-line JSON object per log record."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "timestamp": self.formatTime(record, self.datefmt),
        }
        correlation_id = get_correlation_id()
        if correlation_id:
            payload["correlation_id"] = correlation_id
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        for key in ("request_id", "user_id", "route", "surface"):
            val = getattr(record, key, None)
            if val is not None:
                payload[key] = val
        return json.dumps(payload)


def configure_logger(
    level: str = "INFO",
    use_json: bool = True,
    logger_name: str | None = None,
) -> logging.Logger:
    """Configure and return a logger with SensitiveDataFilter and optional JSON output."""
    log = logging.getLogger(logger_name)
    log.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not log.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.addFilter(SensitiveDataFilter())
        if use_json:
            handler.setFormatter(JsonFormatter())
        log.addHandler(handler)
    return log

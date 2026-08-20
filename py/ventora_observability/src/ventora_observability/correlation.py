from __future__ import annotations

import uuid
from contextvars import ContextVar

correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)

_REQUEST_ID_LENGTH = 36  # UUID v4 length


def get_correlation_id() -> str | None:
    return correlation_id_var.get()


def set_correlation_id(rid: str) -> None:
    correlation_id_var.set(rid)


def generate_request_id() -> str:
    return str(uuid.uuid4())


def is_valid_request_id(rid: str) -> bool:
    """Returns True if rid is a valid UUID v4."""
    try:
        val = uuid.UUID(rid, version=4)
        return str(val) == rid.lower()
    except (ValueError, AttributeError):
        return False

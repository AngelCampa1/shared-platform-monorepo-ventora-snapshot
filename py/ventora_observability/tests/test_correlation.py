from __future__ import annotations
import re
import uuid
from contextvars import copy_context

import pytest

from ventora_observability.correlation import (
    correlation_id_var,
    generate_request_id,
    get_correlation_id,
    is_valid_request_id,
    set_correlation_id,
)

_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def test_generate_request_id_returns_string() -> None:
    rid = generate_request_id()
    assert isinstance(rid, str)


def test_generate_request_id_matches_uuid_v4_format() -> None:
    rid = generate_request_id()
    assert _UUID_V4_RE.match(rid), f"Not a UUID v4: {rid}"


def test_generate_request_id_unique() -> None:
    ids = {generate_request_id() for _ in range(100)}
    assert len(ids) == 100


def test_is_valid_request_id_true_for_valid_uuid4() -> None:
    valid = str(uuid.uuid4())
    assert is_valid_request_id(valid) is True


def test_is_valid_request_id_false_for_non_uuid() -> None:
    assert is_valid_request_id("not-a-uuid") is False


def test_is_valid_request_id_false_for_empty_string() -> None:
    assert is_valid_request_id("") is False


def test_is_valid_request_id_false_for_uuid1() -> None:
    uid1 = str(uuid.uuid1())
    assert is_valid_request_id(uid1) is False


def test_is_valid_request_id_false_for_random_hex() -> None:
    # A 32-char hex string without dashes is not a valid UUID v4
    assert is_valid_request_id("abcdefabcdefabcdefabcdefabcdefab") is False


def test_set_and_get_correlation_id_roundtrip() -> None:
    ctx = copy_context()

    def _run() -> None:
        set_correlation_id("test-id-123")
        assert get_correlation_id() == "test-id-123"

    ctx.run(_run)


def test_correlation_id_starts_as_none_in_fresh_context() -> None:
    ctx = copy_context()

    def _run() -> str | None:
        return get_correlation_id()

    result = ctx.run(_run)
    # Default is None
    assert result is None


def test_correlation_id_var_default_is_none() -> None:
    ctx = copy_context()

    def _run() -> str | None:
        return correlation_id_var.get()

    result = ctx.run(_run)
    assert result is None


def test_set_correlation_id_does_not_leak_to_parent() -> None:
    """Changes inside a child context don't affect the parent."""
    original = get_correlation_id()

    ctx = copy_context()

    def _run() -> None:
        set_correlation_id("child-only")
        assert get_correlation_id() == "child-only"

    ctx.run(_run)
    # Parent context is unaffected
    assert get_correlation_id() == original


def test_multiple_set_calls_overwrite() -> None:
    ctx = copy_context()

    def _run() -> str | None:
        set_correlation_id("first")
        set_correlation_id("second")
        return get_correlation_id()

    result = ctx.run(_run)
    assert result == "second"

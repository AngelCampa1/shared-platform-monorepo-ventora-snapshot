from __future__ import annotations

import asyncio
import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from ventora_analytics.client import (
    AnalyticsEnv,
    _build_payload,
    _resolve_host,
    capture_event,
    capture_event_async,
    capture_event_background,
    sanitize_properties,
)


# ---------------------------------------------------------------------------
# sanitize_properties
# ---------------------------------------------------------------------------


def test_sanitize_removes_password_key() -> None:
    result = sanitize_properties({"user_password": "secret123", "name": "Alice"})
    assert "user_password" not in result
    assert result["name"] == "Alice"


def test_sanitize_removes_token_key() -> None:
    result = sanitize_properties({"access_token": "tok_abc", "email": "a@b.com"})
    assert "access_token" not in result
    assert "email" in result


def test_sanitize_removes_secret_key() -> None:
    result = sanitize_properties({"client_secret": "shh", "plan": "pro"})
    assert "client_secret" not in result
    assert result["plan"] == "pro"


def test_sanitize_removes_key_suffix() -> None:
    result = sanitize_properties({"api_key": "abc123", "user_id": "u1"})
    assert "api_key" not in result
    assert result["user_id"] == "u1"


def test_sanitize_removes_auth_suffix() -> None:
    result = sanitize_properties({"bearer_auth": "xyz", "plan": "free"})
    assert "bearer_auth" not in result


def test_sanitize_removes_credential_suffix() -> None:
    result = sanitize_properties({"db_credential": "pass", "org": "acme"})
    assert "db_credential" not in result
    assert result["org"] == "acme"


def test_sanitize_truncates_long_strings() -> None:
    long_val = "x" * 2000
    result = sanitize_properties({"description": long_val})
    assert len(result["description"]) == 1000


def test_sanitize_preserves_strings_at_limit() -> None:
    exact_val = "a" * 1000
    result = sanitize_properties({"description": exact_val})
    assert result["description"] == exact_val


def test_sanitize_drops_none_values() -> None:
    result = sanitize_properties({"name": None, "plan": "pro"})
    assert "name" not in result
    assert result["plan"] == "pro"


def test_sanitize_passes_safe_values_unchanged() -> None:
    props: dict[str, Any] = {
        "plan": "enterprise",
        "user_id": "u_123",
        "count": 42,
        "active": True,
        "tags": ["a", "b"],
    }
    result = sanitize_properties(props)
    assert result == props


def test_sanitize_empty_dict() -> None:
    assert sanitize_properties({}) == {}


def test_sanitize_case_insensitive_suffix() -> None:
    result = sanitize_properties({"API_KEY": "abc", "User_Token": "tok"})
    assert "API_KEY" not in result
    assert "User_Token" not in result


def test_sanitize_skips_none_keys() -> None:
    # dict[str, Any] type hint doesn't prevent None keys at runtime
    props: dict[Any, Any] = {None: "value", "plan": "pro"}
    result = sanitize_properties(props)  # type: ignore[arg-type]
    assert None not in result
    assert result["plan"] == "pro"


def test_sanitize_drops_api_credential_contains() -> None:
    """'api_credential' contains 'credential' — must be dropped."""
    result = sanitize_properties({"api_credential": "val", "plan": "pro"})
    assert "api_credential" not in result
    assert result["plan"] == "pro"


def test_sanitize_drops_x_auth_suffix() -> None:
    """'x_auth' ends with 'auth' — must be dropped."""
    result = sanitize_properties({"x_auth": "val", "count": 1})
    assert "x_auth" not in result
    assert result["count"] == 1


def test_sanitize_drops_oauth_contains() -> None:
    """'oauth' contains 'auth'? No — it contains 'oauth' which contains 'auth' as substring.
    'oauth'.endswith('auth') is False, but 'auth' in 'oauth' is True — so it IS dropped."""
    result = sanitize_properties({"oauth": "val", "plan": "free"})
    assert "oauth" not in result
    assert result["plan"] == "free"


def test_sanitize_drops_session_token_count_contains() -> None:
    """'session_token_count' contains 'token' — must be dropped (substring rule, not suffix)."""
    result = sanitize_properties({"session_token_count": 42, "user_id": "u1"})
    assert "session_token_count" not in result
    assert result["user_id"] == "u1"


def test_sanitize_keeps_author_not_auth_suffix() -> None:
    """'author' ends with 'or', not 'auth' — must NOT be dropped."""
    result = sanitize_properties({"author": "Alice", "plan": "pro"})
    assert result["author"] == "Alice"


def test_sanitize_keeps_plan_name_safe_key() -> None:
    """'plan_name' contains no sensitive pattern — must NOT be dropped."""
    result = sanitize_properties({"plan_name": "enterprise", "count": 5})
    assert result["plan_name"] == "enterprise"
    assert result["count"] == 5


# ---------------------------------------------------------------------------
# _resolve_host
# ---------------------------------------------------------------------------


def test_resolve_host_none_returns_us() -> None:
    assert _resolve_host(None) == "https://us.i.posthog.com"


def test_resolve_host_empty_string_returns_us() -> None:
    assert _resolve_host("") == "https://us.i.posthog.com"


def test_resolve_host_app_posthog_returns_us() -> None:
    assert _resolve_host("https://app.posthog.com") == "https://us.i.posthog.com"


def test_resolve_host_eu_posthog_passes_through() -> None:
    assert _resolve_host("https://eu.posthog.com") == "https://eu.posthog.com"


def test_resolve_host_custom_passes_through() -> None:
    custom = "https://posthog.mycompany.com"
    assert _resolve_host(custom) == custom


def test_resolve_host_us_i_passes_through() -> None:
    host = "https://us.i.posthog.com"
    assert _resolve_host(host) == host


# ---------------------------------------------------------------------------
# capture_event — sync
# ---------------------------------------------------------------------------


def test_capture_event_noop_when_no_key() -> None:
    env = AnalyticsEnv(posthog_key=None)
    with patch("httpx.post") as mock_post:
        capture_event("user_signed_up", distinct_id="u1", env=env)
        mock_post.assert_not_called()


def test_capture_event_noop_unapproved(caplog: pytest.LogCaptureFixture) -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with patch("httpx.post") as mock_post:
        with caplog.at_level(logging.WARNING):
            capture_event("not_a_real_event", distinct_id="u1", env=env)
        mock_post.assert_not_called()
    assert "unapproved event" in caplog.text
    assert "not_a_real_event" in caplog.text


def test_capture_event_calls_httpx_post() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with patch("httpx.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        capture_event("user_signed_up", distinct_id="u1", env=env)
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        assert call_args[0][0] == "https://us.i.posthog.com/i/v0/e/"


def test_capture_event_correct_url_with_custom_host() -> None:
    env = AnalyticsEnv(posthog_key="phc_test", posthog_host="https://posthog.mycompany.com")
    with patch("httpx.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        capture_event("user_signed_up", distinct_id="u1", env=env)
        call_args = mock_post.call_args
        assert call_args[0][0] == "https://posthog.mycompany.com/i/v0/e/"


def test_capture_event_rewrites_app_posthog_host() -> None:
    env = AnalyticsEnv(posthog_key="phc_test", posthog_host="https://app.posthog.com")
    with patch("httpx.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        capture_event("user_signed_up", distinct_id="u1", env=env)
        call_args = mock_post.call_args
        assert call_args[0][0] == "https://us.i.posthog.com/i/v0/e/"


def test_capture_event_never_raises_on_httpx_error() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with patch("httpx.post", side_effect=httpx.ConnectError("network down")):
        # Must not raise
        capture_event("user_signed_up", distinct_id="u1", env=env)


def test_capture_event_payload_structure() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with patch("httpx.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        capture_event(
            "user_signed_up",
            distinct_id="u1",
            organization_id="org_abc",
            properties={"plan": "pro"},
            env=env,
        )
        payload = mock_post.call_args.kwargs["json"]
        assert payload["api_key"] == "phc_test"
        assert payload["event"] == "user_signed_up"
        assert "timestamp" in payload
        assert payload["properties"]["distinct_id"] == "u1"
        assert payload["properties"]["$groups"] == {"organization": "org_abc"}
        assert payload["properties"]["plan"] == "pro"


def test_capture_event_no_org_omits_groups() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with patch("httpx.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        capture_event("user_signed_up", distinct_id="u1", env=env)
        payload = mock_post.call_args.kwargs["json"]
        assert "$groups" not in payload["properties"]


# ---------------------------------------------------------------------------
# capture_event_async — async
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_capture_event_async_noop_when_no_key() -> None:
    env = AnalyticsEnv(posthog_key=None)
    with respx.mock:
        await capture_event_async("user_signed_up", distinct_id="u1", env=env)
        assert len(respx.calls) == 0


@pytest.mark.asyncio
async def test_capture_event_async_noop_unapproved(caplog: pytest.LogCaptureFixture) -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with respx.mock:
        with caplog.at_level(logging.WARNING):
            await capture_event_async("not_a_real_event", distinct_id="u1", env=env)
        assert len(respx.calls) == 0
    assert "unapproved event" in caplog.text


@pytest.mark.asyncio
async def test_capture_event_async_calls_correct_url() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with respx.mock:
        route = respx.post("https://us.i.posthog.com/i/v0/e/").mock(
            return_value=httpx.Response(200)
        )
        await capture_event_async("user_signed_up", distinct_id="u1", env=env)
        assert route.called


@pytest.mark.asyncio
async def test_capture_event_async_rewrites_app_posthog_host() -> None:
    env = AnalyticsEnv(posthog_key="phc_test", posthog_host="https://app.posthog.com")
    with respx.mock:
        route = respx.post("https://us.i.posthog.com/i/v0/e/").mock(
            return_value=httpx.Response(200)
        )
        await capture_event_async("user_signed_up", distinct_id="u1", env=env)
        assert route.called


@pytest.mark.asyncio
async def test_capture_event_async_never_raises_on_httpx_error() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with respx.mock:
        respx.post("https://us.i.posthog.com/i/v0/e/").mock(
            side_effect=httpx.ConnectError("network down")
        )
        # Must not raise
        await capture_event_async("user_signed_up", distinct_id="u1", env=env)


@pytest.mark.asyncio
async def test_capture_event_async_payload_structure() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")
    with respx.mock:
        route = respx.post("https://us.i.posthog.com/i/v0/e/").mock(
            return_value=httpx.Response(200)
        )
        await capture_event_async(
            "user_signed_up",
            distinct_id="u1",
            organization_id="org_abc",
            properties={"plan": "pro"},
            env=env,
        )
        assert route.called
        request = route.calls.last.request
        import json
        payload = json.loads(request.content)
        assert payload["api_key"] == "phc_test"
        assert payload["event"] == "user_signed_up"
        assert payload["properties"]["distinct_id"] == "u1"
        assert payload["properties"]["$groups"] == {"organization": "org_abc"}


@pytest.mark.asyncio
async def test_capture_event_async_custom_host() -> None:
    env = AnalyticsEnv(posthog_key="phc_test", posthog_host="https://posthog.mycompany.com")
    with respx.mock:
        route = respx.post("https://posthog.mycompany.com/i/v0/e/").mock(
            return_value=httpx.Response(200)
        )
        await capture_event_async("user_signed_up", distinct_id="u1", env=env)
        assert route.called


# ---------------------------------------------------------------------------
# capture_event_background
# ---------------------------------------------------------------------------


def test_capture_event_background_schedules_task_when_loop_running() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")

    scheduled_coros: list[Any] = []

    mock_loop = MagicMock()

    def fake_create_task(coro: Any) -> MagicMock:
        scheduled_coros.append(coro)
        # Close the coroutine to avoid ResourceWarning
        coro.close()
        return MagicMock()

    mock_loop.create_task = fake_create_task

    with patch("asyncio.get_running_loop", return_value=mock_loop):
        capture_event_background("user_signed_up", distinct_id="u1", env=env)

    assert len(scheduled_coros) == 1


def test_capture_event_background_falls_back_to_sync_when_no_loop() -> None:
    env = AnalyticsEnv(posthog_key="phc_test")

    with patch("asyncio.get_running_loop", side_effect=RuntimeError("no loop")):
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(status_code=200)
            capture_event_background("user_signed_up", distinct_id="u1", env=env)
            mock_post.assert_called_once()


def test_capture_event_background_noop_no_key_no_loop() -> None:
    env = AnalyticsEnv(posthog_key=None)

    with patch("asyncio.get_running_loop", side_effect=RuntimeError("no loop")):
        with patch("httpx.post") as mock_post:
            capture_event_background("user_signed_up", distinct_id="u1", env=env)
            mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# _build_payload
# ---------------------------------------------------------------------------


def test_build_payload_structure() -> None:
    payload = _build_payload(
        "user_signed_up",
        "u1",
        "org_123",
        {"plan": "pro", "api_key": "should_be_stripped"},
        "phc_test",
    )
    assert payload["api_key"] == "phc_test"
    assert payload["event"] == "user_signed_up"
    assert "timestamp" in payload
    props = payload["properties"]
    assert props["distinct_id"] == "u1"
    assert props["$groups"] == {"organization": "org_123"}
    assert props["plan"] == "pro"
    # "api_key" should be sanitized out
    assert "api_key" not in props


def test_build_payload_no_org() -> None:
    payload = _build_payload("page_viewed", "u2", None, None, "phc_test")
    assert "$groups" not in payload["properties"]
    assert payload["properties"]["distinct_id"] == "u2"


def test_build_payload_distinct_id_at_top_level() -> None:
    payload = _build_payload("user_signed_up", "u_toplevel", "org_xyz", {"plan": "pro"}, "phc_test")
    assert payload["distinct_id"] == "u_toplevel"

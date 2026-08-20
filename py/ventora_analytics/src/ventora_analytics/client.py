from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


class AnalyticsEnv:
    """Holds PostHog credentials. Accepts any object with POSTHOG_KEY attr."""

    def __init__(self, posthog_key: str | None = None, posthog_host: str | None = None) -> None:
        self.posthog_key = posthog_key
        self.posthog_host = posthog_host


def _resolve_host(host: str | None) -> str:
    if not host or host == "https://app.posthog.com":
        return "https://us.i.posthog.com"
    return host


_SENSITIVE_CONTAINS = ("password", "token", "secret", "credential")
_SENSITIVE_SUFFIX = ("key", "auth")


def sanitize_properties(props: dict[str, Any]) -> dict[str, Any]:
    """Remove secret-looking keys, truncate long strings, drop None values."""
    result: dict[str, Any] = {}
    for k, v in props.items():
        if k is None:
            continue
        key_lower = k.lower()
        if any(s in key_lower for s in _SENSITIVE_CONTAINS) or key_lower.endswith(
            _SENSITIVE_SUFFIX
        ):
            continue
        if v is None:
            continue
        if isinstance(v, str) and len(v) > 1000:
            v = v[:1000]
        result[k] = v
    return result


def is_approved_event(name: str) -> bool:
    from ._generated_events import APPROVED_EVENTS
    return name in APPROVED_EVENTS


def capture_event(
    event: str,
    *,
    distinct_id: str,
    organization_id: str | None = None,
    properties: dict[str, Any] | None = None,
    env: AnalyticsEnv,
) -> None:
    """Synchronous PostHog event capture. No-ops when POSTHOG_KEY absent or event unapproved."""
    if not env.posthog_key:
        return
    if not is_approved_event(event):
        logger.warning("PostHog: unapproved event %r dropped", event)
        return

    import httpx

    host = _resolve_host(env.posthog_host)
    payload = _build_payload(event, distinct_id, organization_id, properties, env.posthog_key)
    try:
        httpx.post(f"{host}/i/v0/e/", json=payload, timeout=5.0)
    except Exception:  # noqa: S110
        pass  # Analytics failures must never crash the service


async def capture_event_async(
    event: str,
    *,
    distinct_id: str,
    organization_id: str | None = None,
    properties: dict[str, Any] | None = None,
    env: AnalyticsEnv,
) -> None:
    """Async PostHog event capture. Fire-and-forget safe."""
    if not env.posthog_key:
        return
    if not is_approved_event(event):
        logger.warning("PostHog: unapproved event %r dropped", event)
        return

    import httpx

    host = _resolve_host(env.posthog_host)
    payload = _build_payload(event, distinct_id, organization_id, properties, env.posthog_key)
    try:
        async with httpx.AsyncClient() as client:
            await client.post(f"{host}/i/v0/e/", json=payload, timeout=5.0)
    except Exception:  # noqa: S110
        pass


def capture_event_background(
    event: str,
    *,
    distinct_id: str,
    organization_id: str | None = None,
    properties: dict[str, Any] | None = None,
    env: AnalyticsEnv,
) -> None:
    """Fire-and-forget wrapper — schedules async capture in the running event loop."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(
            capture_event_async(
                event,
                distinct_id=distinct_id,
                organization_id=organization_id,
                properties=properties,
                env=env,
            )
        )
    except RuntimeError:
        # No running loop — fall back to sync
        capture_event(
            event,
            distinct_id=distinct_id,
            organization_id=organization_id,
            properties=properties,
            env=env,
        )


def _build_payload(
    event: str,
    distinct_id: str,
    organization_id: str | None,
    properties: dict[str, Any] | None,
    api_key: str,
) -> dict[str, Any]:
    clean_props = sanitize_properties(properties or {})
    if organization_id:
        clean_props["$groups"] = {"organization": organization_id}
    return {
        "api_key": api_key,
        "event": event,
        "distinct_id": distinct_id,
        "timestamp": datetime.now(UTC).isoformat(),
        "properties": {**clean_props, "distinct_id": distinct_id},
    }

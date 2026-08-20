from __future__ import annotations

import logging
from typing import cast

logger = logging.getLogger(__name__)


def init_sentry(
    dsn: str | None,
    environment: str,
    release: str | None = None,
    send_default_pii: bool = False,
) -> None:
    """Initialize Sentry SDK. No-ops if dsn is None or empty."""
    if not dsn:
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=release,
            send_default_pii=send_default_pii,
            traces_sample_rate=0.0,
        )
    except ImportError:
        logger.warning("sentry-sdk not installed; Sentry disabled")


def capture_reportable_exception(
    error: BaseException,
    *,
    surface: str,
    route: str,
    status_code: int,
    request_id: str | None = None,
) -> str | None:
    """Capture an exception in Sentry with standard tags. Returns event ID or None."""
    if status_code < 500:
        return None
    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            scope.set_tag("surface", surface)
            scope.set_tag("route", route)
            scope.set_tag("status_code", str(status_code))
            if request_id:
                scope.set_tag("request_id", request_id)
            return cast("str | None", sentry_sdk.capture_exception(error))
    except Exception:
        return None

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import time
from typing import Literal

UnsubscribeCategory = Literal["marketing", "transactional"]


def generate_unsubscribe_token(
    user_id: str,
    category: UnsubscribeCategory,
    secret: str,
) -> str:
    """Generate a stateless HMAC-SHA256 unsubscribe token."""
    payload = json.dumps({"userId": user_id, "category": category, "iat": int(time.time())})
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{payload_b64}.{sig_b64}"


_DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 3600  # 30 days


def verify_unsubscribe_token(
    token: str,
    secret: str,
    max_age_seconds: int = _DEFAULT_MAX_AGE_SECONDS,
) -> dict[str, str] | None:
    """Verify token signature and expiry, returning payload or None."""
    try:
        parts = token.split(".")
        if len(parts) != 2:
            return None
        payload_b64, sig_b64 = parts
        expected_sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
        expected_b64 = base64.urlsafe_b64encode(expected_sig).rstrip(b"=").decode()
        if not hmac.compare_digest(expected_b64, sig_b64):
            return None
        # Pad base64 if needed
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        data = json.loads(base64.urlsafe_b64decode(payload_b64).decode())
        if not isinstance(data.get("userId"), str):
            return None
        if data.get("category") not in ("marketing", "transactional"):
            return None
        issued_at = data.get("iat")
        if (
            isinstance(issued_at, bool)
            or not isinstance(issued_at, int | float)
            or not math.isfinite(issued_at)
        ):
            return None
        now = time.time()
        if issued_at > now or now - issued_at > max_age_seconds:
            return None
        return {"userId": data["userId"], "category": data["category"]}
    except Exception:  # noqa: BLE001
        return None

from __future__ import annotations
import base64
import hashlib
import hmac
import json
from unittest.mock import patch

import pytest

from ventora_email.tokens import generate_unsubscribe_token, verify_unsubscribe_token


SECRET = "test-secret-key"


def _signed_token(payload: dict[str, object], secret: str = SECRET) -> str:
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{payload_b64}.{sig_b64}"


def test_generate_returns_two_part_dot_separated():
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    parts = token.split(".")
    assert len(parts) == 2
    assert all(part for part in parts)


def test_verify_round_trip_marketing():
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    result = verify_unsubscribe_token(token, SECRET)
    assert result is not None
    assert result["userId"] == "user123"
    assert result["category"] == "marketing"


def test_verify_round_trip_transactional():
    token = generate_unsubscribe_token("user456", "transactional", SECRET)
    result = verify_unsubscribe_token(token, SECRET)
    assert result is not None
    assert result["userId"] == "user456"
    assert result["category"] == "transactional"


def test_verify_wrong_secret_returns_none():
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    result = verify_unsubscribe_token(token, "wrong-secret")
    assert result is None


def test_verify_no_dot_returns_none():
    result = verify_unsubscribe_token("nodottoken", SECRET)
    assert result is None


def test_verify_too_many_dots_returns_none():
    result = verify_unsubscribe_token("part1.part2.part3", SECRET)
    assert result is None


def test_verify_empty_string_returns_none():
    result = verify_unsubscribe_token("", SECRET)
    assert result is None


def test_verify_invalid_json_payload_returns_none():
    """Token whose payload is valid base64 but not valid JSON triggers except branch."""
    raw = b"this is not json!!"
    payload_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    sig = hmac.new(SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    token = f"{payload_b64}.{sig_b64}"
    result = verify_unsubscribe_token(token, SECRET)
    assert result is None


def test_verify_tampered_payload_returns_none():
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    payload_b64, sig_b64 = token.split(".")
    # Decode, tamper, re-encode
    padding = 4 - len(payload_b64) % 4
    padded = payload_b64 + ("=" * padding if padding != 4 else "")
    data = json.loads(base64.urlsafe_b64decode(padded).decode())
    data["userId"] = "evil-user"
    tampered_payload = base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    tampered_token = f"{tampered_payload}.{sig_b64}"
    result = verify_unsubscribe_token(tampered_token, SECRET)
    assert result is None


def test_verify_expired_token_returns_none():
    """A token whose iat is older than max_age_seconds must return None."""
    past_time = 1_000_000.0  # far in the past
    with patch("ventora_email.tokens.time") as mock_time:
        mock_time.time.return_value = past_time
        token = generate_unsubscribe_token("user123", "marketing", SECRET)

    # Now verify with current (real) time — iat is in the distant past
    result = verify_unsubscribe_token(token, SECRET)
    assert result is None


def test_verify_fresh_token_still_verifies():
    """A token just generated must verify successfully."""
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    result = verify_unsubscribe_token(token, SECRET)
    assert result is not None
    assert result["userId"] == "user123"
    assert result["category"] == "marketing"


def test_verify_rejects_signed_invalid_category():
    token = _signed_token({"userId": "user123", "category": "admin", "iat": 2_000_000_000})

    assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_rejects_signed_non_numeric_iat():
    token = _signed_token({"userId": "user123", "category": "marketing", "iat": "now"})

    assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_rejects_signed_nan_iat():
    token = _signed_token({"userId": "user123", "category": "marketing", "iat": float("nan")})

    assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_rejects_signed_bool_iat():
    token = _signed_token({"userId": "user123", "category": "marketing", "iat": True})

    assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_rejects_signed_legacy_millisecond_iat():
    token = _signed_token({"userId": "user123", "category": "marketing", "iat": 2_000_000_000_000})

    assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_rejects_signed_future_iat():
    token = _signed_token({"userId": "user123", "category": "marketing", "iat": 2_000_000_060})

    with patch("ventora_email.tokens.time") as mock_time:
        mock_time.time.return_value = 2_000_000_000
        assert verify_unsubscribe_token(token, SECRET) is None


def test_verify_max_age_zero_always_expires():
    """With max_age_seconds=0, even a brand-new token must return None."""
    token = generate_unsubscribe_token("user123", "marketing", SECRET)
    result = verify_unsubscribe_token(token, SECRET, max_age_seconds=0)
    assert result is None

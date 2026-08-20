from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any, TypeGuard

BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


@dataclass(frozen=True)
class DownloadUrlPayload:
    key: str
    expires_at: int


@dataclass(frozen=True)
class DirectUploadInput:
    key: str
    content_type: str
    max_size_bytes: int | None = None
    expires_in: int | None = None


@dataclass(frozen=True)
class DirectUploadCapability:
    key: str
    content_type: str
    expires_at: int
    max_size_bytes: int | None = None


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    if not value or any(char not in BASE64URL_ALPHABET for char in value):
        raise ValueError("invalid base64url")
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def _hmac_signature(encoded_payload: str, secret: str) -> bytes:
    _validate_secret(secret)
    return hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("utf-8"),
        hashlib.sha256,
    ).digest()


def _validate_secret(secret: str) -> None:
    if not secret.strip():
        raise ValueError("secret must not be blank")


def _sign_payload(payload: dict[str, object], secret: str) -> str:
    _validate_secret(secret)
    json_payload = json.dumps(payload, separators=(",", ":"))
    encoded_payload = _base64url_encode(json_payload.encode("utf-8"))
    encoded_signature = _base64url_encode(_hmac_signature(encoded_payload, secret))
    return f"{encoded_payload}.{encoded_signature}"


def _verify_payload(token: str, secret: str) -> dict[str, Any] | None:
    try:
        _validate_secret(secret)
    except ValueError:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None

    encoded_payload, encoded_signature = parts
    try:
        signature = _base64url_decode(encoded_signature)
        payload_bytes = _base64url_decode(encoded_payload)
    except ValueError:
        return None

    expected_signature = _hmac_signature(encoded_payload, secret)
    if not hmac.compare_digest(signature, expected_signature):
        return None

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict):
        return None
    return payload


def _is_expiration_millis(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_not_expired(expires_at: int) -> bool:
    return int(time.time() * 1000) <= expires_at


def sign_download_url(payload: DownloadUrlPayload, secret: str) -> str:
    return _sign_payload({"key": payload.key, "expiresAt": payload.expires_at}, secret)


def verify_download_url(token: str, secret: str) -> DownloadUrlPayload | None:
    payload = _verify_payload(token, secret)
    if payload is None:
        return None

    key = payload.get("key")
    expires_at = payload.get("expiresAt")
    if not isinstance(key, str) or not _is_expiration_millis(expires_at):
        return None
    if not _is_not_expired(expires_at):
        return None

    return DownloadUrlPayload(key=key, expires_at=int(expires_at))


def generate_capability_token(capability: DirectUploadCapability, secret: str) -> str:
    payload: dict[str, object] = {
        "key": capability.key,
        "contentType": capability.content_type,
    }
    if capability.max_size_bytes is not None:
        payload["maxSizeBytes"] = capability.max_size_bytes
    payload["expiresAt"] = capability.expires_at
    return _sign_payload(payload, secret)


def verify_capability_token(token: str, secret: str) -> DirectUploadCapability | None:
    payload = _verify_payload(token, secret)
    if payload is None:
        return None

    key = payload.get("key")
    content_type = payload.get("contentType")
    expires_at = payload.get("expiresAt")
    max_size_bytes = payload.get("maxSizeBytes")
    if (
        not isinstance(key, str)
        or not isinstance(content_type, str)
        or not _is_expiration_millis(expires_at)
    ):
        return None
    if max_size_bytes is not None and (
        not isinstance(max_size_bytes, int) or isinstance(max_size_bytes, bool)
    ):
        return None
    if not _is_not_expired(expires_at):
        return None

    return DirectUploadCapability(
        key=key,
        content_type=content_type,
        max_size_bytes=max_size_bytes,
        expires_at=int(expires_at),
    )

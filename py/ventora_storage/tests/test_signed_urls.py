from __future__ import annotations

import base64
import hashlib
import hmac
import json

from ventora_storage.signed_urls import (
    DirectUploadCapability,
    DirectUploadInput,
    DownloadUrlPayload,
    generate_capability_token,
    sign_download_url,
    verify_capability_token,
    verify_download_url,
)

SECRET = "test-secret-key-123"
ALT_SECRET = "different-secret-key-456"


def test_signed_url_helpers_are_exported_from_package() -> None:
    import ventora_storage

    assert ventora_storage.DownloadUrlPayload is DownloadUrlPayload
    assert ventora_storage.DirectUploadInput is DirectUploadInput
    assert ventora_storage.DirectUploadCapability is DirectUploadCapability
    assert ventora_storage.sign_download_url is sign_download_url
    assert ventora_storage.verify_download_url is verify_download_url
    assert ventora_storage.generate_capability_token is generate_capability_token
    assert ventora_storage.verify_capability_token is verify_capability_token


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _make_signed_token(raw_payload: str, secret: str) -> str:
    encoded_payload = _base64url_encode(raw_payload.encode("utf-8"))
    signature = hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_payload}.{_base64url_encode(signature)}"


def _decode_payload(token: str) -> dict[str, object]:
    encoded_payload = token.split(".", 1)[0]
    padding = "=" * (-len(encoded_payload) % 4)
    payload_bytes = base64.urlsafe_b64decode(f"{encoded_payload}{padding}")
    payload = json.loads(payload_bytes.decode("utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_sign_download_url_emits_two_base64url_parts_with_camel_case_payload() -> None:
    payload = DownloadUrlPayload(key="tenant1/file.txt", expires_at=4_102_444_800_000)

    token = sign_download_url(payload, SECRET)

    assert token.count(".") == 1
    assert all(part for part in token.split("."))
    assert set(token) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
    assert _decode_payload(token) == {
        "key": "tenant1/file.txt",
        "expiresAt": 4_102_444_800_000,
    }


def test_verify_download_url_returns_payload_for_valid_token() -> None:
    payload = DownloadUrlPayload(key="tenant1/file.txt", expires_at=4_102_444_800_000)
    token = sign_download_url(payload, SECRET)

    assert verify_download_url(token, SECRET) == payload


def test_download_url_helpers_reject_blank_secrets() -> None:
    payload = DownloadUrlPayload(key="tenant1/file.txt", expires_at=4_102_444_800_000)

    for secret in ("", "   "):
        try:
            sign_download_url(payload, secret)
        except ValueError as exc:
            assert str(exc) == "secret must not be blank"
        else:
            raise AssertionError("expected blank secret to be rejected")

        assert verify_download_url("payload.signature", secret) is None


def test_verify_download_url_returns_none_for_invalid_tokens() -> None:
    valid = sign_download_url(
        DownloadUrlPayload(key="tenant1/file.txt", expires_at=4_102_444_800_000),
        SECRET,
    )
    encoded_signature = valid.split(".", 1)[1]
    tampered_payload = _base64url_encode(
        json.dumps({"key": "tenant2/evil.txt", "expiresAt": 4_102_444_800_000}).encode("utf-8")
    )

    assert verify_download_url("nodotintoken", SECRET) is None
    assert verify_download_url("!!!.!!!invalid", SECRET) is None
    assert verify_download_url(valid, ALT_SECRET) is None
    assert verify_download_url(f"{tampered_payload}.{encoded_signature}", SECRET) is None
    assert verify_download_url(
        sign_download_url(DownloadUrlPayload(key="tenant1/file.txt", expires_at=1), SECRET),
        SECRET,
    ) is None
    assert verify_download_url(_make_signed_token("not-valid-json!!!", SECRET), SECRET) is None
    assert (
        verify_download_url(_make_signed_token(json.dumps({"foo": "bar"}), SECRET), SECRET)
        is None
    )
    assert verify_download_url(_make_signed_token("null", SECRET), SECRET) is None


def test_verify_download_url_returns_none_for_non_finite_expiration() -> None:
    token = _make_signed_token('{"key":"tenant1/file.txt","expiresAt":Infinity}', SECRET)
    fractional_token = _make_signed_token('{"key":"tenant1/file.txt","expiresAt":4102444800000.5}', SECRET)

    assert verify_download_url(token, SECRET) is None
    assert verify_download_url(fractional_token, SECRET) is None


def test_capability_token_round_trips_with_optional_max_size() -> None:
    capability = DirectUploadCapability(
        key="tenant1/uploads/image.png",
        content_type="image/png",
        expires_at=4_102_444_800_000,
        max_size_bytes=5_000_000,
    )

    token = generate_capability_token(capability, SECRET)

    assert _decode_payload(token) == {
        "key": "tenant1/uploads/image.png",
        "contentType": "image/png",
        "maxSizeBytes": 5_000_000,
        "expiresAt": 4_102_444_800_000,
    }
    assert verify_capability_token(token, SECRET) == capability


def test_capability_token_round_trips_without_optional_fields() -> None:
    capability = DirectUploadCapability(
        key="tenant1/uploads/doc.pdf",
        content_type="application/pdf",
        expires_at=4_102_444_800_000,
    )

    token = generate_capability_token(capability, SECRET)

    assert _decode_payload(token) == {
        "key": "tenant1/uploads/doc.pdf",
        "contentType": "application/pdf",
        "expiresAt": 4_102_444_800_000,
    }
    assert verify_capability_token(token, SECRET) == capability


def test_capability_helpers_reject_blank_secrets() -> None:
    capability = DirectUploadCapability(
        key="tenant1/uploads/doc.pdf",
        content_type="application/pdf",
        expires_at=4_102_444_800_000,
    )

    for secret in ("", "   "):
        try:
            generate_capability_token(capability, secret)
        except ValueError as exc:
            assert str(exc) == "secret must not be blank"
        else:
            raise AssertionError("expected blank secret to be rejected")

        assert verify_capability_token("payload.signature", secret) is None


def test_verify_capability_token_returns_none_for_invalid_tokens() -> None:
    valid = generate_capability_token(
        DirectUploadCapability(
            key="tenant1/uploads/image.png",
            content_type="image/png",
            expires_at=4_102_444_800_000,
        ),
        SECRET,
    )
    encoded_signature = valid.split(".", 1)[1]
    tampered_payload = _base64url_encode(
        json.dumps(
            {
                "key": "evil/path",
                "contentType": "image/png",
                "expiresAt": 4_102_444_800_000,
            }
        ).encode("utf-8")
    )
    expired = generate_capability_token(
        DirectUploadCapability(
            key="tenant1/uploads/image.png",
            content_type="image/png",
            expires_at=1,
        ),
        SECRET,
    )

    assert verify_capability_token("notavalidtoken", SECRET) is None
    assert verify_capability_token("!!!.!!!invalid", SECRET) is None
    assert verify_capability_token(valid, ALT_SECRET) is None
    assert verify_capability_token(f"{tampered_payload}.{encoded_signature}", SECRET) is None
    assert verify_capability_token(expired, SECRET) is None
    assert verify_capability_token(_make_signed_token("not-valid-json!!!", SECRET), SECRET) is None
    assert (
        verify_capability_token(_make_signed_token(json.dumps({"foo": "bar"}), SECRET), SECRET)
        is None
    )
    assert verify_capability_token(_make_signed_token("null", SECRET), SECRET) is None


def test_verify_capability_token_returns_none_for_non_finite_expiration() -> None:
    token = _make_signed_token(
        '{"key":"tenant1/uploads/image.png","contentType":"image/png","expiresAt":Infinity}',
        SECRET,
    )
    fractional_token = _make_signed_token(
        '{"key":"tenant1/uploads/image.png","contentType":"image/png","expiresAt":4102444800000.5}',
        SECRET,
    )

    assert verify_capability_token(token, SECRET) is None
    assert verify_capability_token(fractional_token, SECRET) is None

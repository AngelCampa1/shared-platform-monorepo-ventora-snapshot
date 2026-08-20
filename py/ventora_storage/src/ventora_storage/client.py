from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config

from .signed_urls import (
    DirectUploadCapability,
    DirectUploadInput,
    generate_capability_token,
    verify_capability_token,
)

MAX_PRESIGNED_URL_EXPIRY = 3600  # 15 min default, max 1 hour cap
DEFAULT_CAPABILITY_EXPIRY = 900
MAX_CAPABILITY_EXPIRY = 3600


@dataclass
class StorageConfig:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    region: str = "auto"
    encryption_key: bytes | None = field(default=None, repr=False)
    capability_secret: str | None = field(default=None, repr=False)


@dataclass
class UploadResult:
    key: str
    etag: str
    size: int


class ObjectStorageService:
    def __init__(self, config: StorageConfig) -> None:
        self._config = config
        self._client = boto3.client(
            "s3",
            endpoint_url=config.endpoint,
            aws_access_key_id=config.access_key,
            aws_secret_access_key=config.secret_key,
            region_name=config.region,
            config=Config(signature_version="s3v4", retries={"max_attempts": 2}),
        )

    def upload(
        self,
        key: str,
        content: bytes,
        *,
        content_type: str = "application/octet-stream",
        metadata: dict[str, str] | None = None,
    ) -> UploadResult:
        data = self._maybe_encrypt(content)
        extra: dict[str, Any] = {"ContentType": content_type}
        if metadata:
            extra["Metadata"] = metadata
        if self._config.encryption_key:
            extra.setdefault("Metadata", {})["x-ventora-encrypted"] = "aes256gcm"
        response = self._client.put_object(Bucket=self._config.bucket, Key=key, Body=data, **extra)
        etag = response.get("ETag", "").strip('"')
        return UploadResult(key=key, etag=etag, size=len(data))

    def stream_upload(
        self,
        key: str,
        stream: Iterator[bytes],
        content_type: str = "application/octet-stream",
    ) -> UploadResult:
        data = b"".join(stream)
        return self.upload(key, data, content_type=content_type)

    def download(self, key: str) -> bytes:
        import botocore.exceptions
        try:
            response = self._client.get_object(Bucket=self._config.bucket, Key=key)
        except botocore.exceptions.ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                raise FileNotFoundError(f"Object not found: {key}") from e
            raise
        data: bytes = response["Body"].read()
        return self._maybe_decrypt(data)

    def generate_presigned_url(self, key: str, *, expires_in: int = 900) -> str:
        expires = min(expires_in, MAX_PRESIGNED_URL_EXPIRY)
        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._config.bucket, "Key": key},
            ExpiresIn=expires,
        )
        if not isinstance(url, str):
            raise TypeError("storage client returned a non-string presigned URL")
        return url

    def generate_presigned_download_url(self, key: str, *, expires_in: int = 900) -> str:
        return self.generate_presigned_url(key, expires_in=expires_in)

    def generate_direct_upload_capability(self, upload: DirectUploadInput) -> str:
        secret = self._require_capability_secret()
        expires_in = (
            upload.expires_in if upload.expires_in is not None else DEFAULT_CAPABILITY_EXPIRY
        )
        capped_expires_in = min(expires_in, MAX_CAPABILITY_EXPIRY)
        capability = DirectUploadCapability(
            key=upload.key,
            content_type=upload.content_type,
            max_size_bytes=upload.max_size_bytes,
            expires_at=int(time.time() * 1000) + capped_expires_in * 1000,
        )
        return generate_capability_token(capability, secret)

    def verify_direct_upload_capability(self, token: str) -> DirectUploadCapability | None:
        secret = self._require_capability_secret()
        return verify_capability_token(token, secret)

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._config.bucket, Key=key)

    def exists(self, key: str) -> bool:
        import botocore.exceptions
        try:
            self._client.head_object(Bucket=self._config.bucket, Key=key)
            return True
        except botocore.exceptions.ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
                return False
            raise

    def _require_capability_secret(self) -> str:
        if not self._config.capability_secret:
            raise ValueError("StorageConfig.capability_secret is required")
        return self._config.capability_secret

    def _maybe_encrypt(self, data: bytes) -> bytes:
        if self._config.encryption_key:
            from .encryption import encrypt_bytes
            return encrypt_bytes(data, self._config.encryption_key)
        return data

    def _maybe_decrypt(self, data: bytes) -> bytes:
        if self._config.encryption_key:
            from .encryption import decrypt_bytes
            return decrypt_bytes(data, self._config.encryption_key)
        return data

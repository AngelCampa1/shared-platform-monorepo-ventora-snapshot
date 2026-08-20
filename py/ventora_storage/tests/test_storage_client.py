from __future__ import annotations
from unittest.mock import MagicMock, patch
import boto3
import pytest
from moto import mock_aws

from ventora_storage.client import ObjectStorageService, StorageConfig, UploadResult
from ventora_storage.encryption import generate_data_key
from ventora_storage.signed_urls import DirectUploadCapability, DirectUploadInput

BUCKET = "test-bucket"
REGION = "us-east-1"


def make_config(**kwargs: object) -> StorageConfig:
    return StorageConfig(
        endpoint="https://s3.amazonaws.com",
        access_key="test",
        secret_key="test",
        bucket=BUCKET,
        region=REGION,
        **kwargs,  # type: ignore[arg-type]
    )


def create_bucket() -> None:
    boto3.client("s3", region_name=REGION).create_bucket(Bucket=BUCKET)


@mock_aws
def test_upload_returns_upload_result() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    result = service.upload("tenant1/file.txt", b"hello world")
    assert isinstance(result, UploadResult)
    assert result.key == "tenant1/file.txt"
    assert result.size == len(b"hello world")


@mock_aws
def test_upload_stores_object() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"hello world")
    s3 = boto3.client("s3", region_name=REGION)
    obj = s3.get_object(Bucket=BUCKET, Key="tenant1/file.txt")
    assert obj["Body"].read() == b"hello world"


@mock_aws
def test_download_retrieves_uploaded_content() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"test content")
    data = service.download("tenant1/file.txt")
    assert data == b"test content"


@mock_aws
def test_upload_download_with_encryption_key() -> None:
    create_bucket()
    enc_key = generate_data_key()
    service = ObjectStorageService(make_config(encryption_key=enc_key))
    plaintext = b"secret ventora data"
    service.upload("tenant1/secret.bin", plaintext)

    # Raw bytes in S3 should NOT equal plaintext (encrypted)
    s3 = boto3.client("s3", region_name=REGION)
    raw = s3.get_object(Bucket=BUCKET, Key="tenant1/secret.bin")["Body"].read()
    assert raw != plaintext

    # Download should decrypt and return original plaintext
    result = service.download("tenant1/secret.bin")
    assert result == plaintext


@mock_aws
def test_upload_with_content_type_and_metadata() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    result = service.upload(
        "tenant1/photo.jpg",
        b"\xff\xd8\xff",
        content_type="image/jpeg",
        metadata={"original-name": "photo.jpg"},
    )
    assert result.key == "tenant1/photo.jpg"
    s3 = boto3.client("s3", region_name=REGION)
    head = s3.head_object(Bucket=BUCKET, Key="tenant1/photo.jpg")
    assert head["ContentType"] == "image/jpeg"
    assert head["Metadata"]["original-name"] == "photo.jpg"


@mock_aws
def test_generate_presigned_url_returns_string() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"data")
    url = service.generate_presigned_url("tenant1/file.txt")
    assert isinstance(url, str)
    assert "tenant1/file.txt" in url


@mock_aws
def test_generate_presigned_url_caps_expiry() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"data")
    # Request 9999 seconds — should be capped at 3600
    url = service.generate_presigned_url("tenant1/file.txt", expires_in=9999)
    assert isinstance(url, str)
    # Verify the expiry in the URL is capped (X-Amz-Expires=3600)
    assert "3600" in url


@mock_aws
def test_generate_presigned_url_default_expiry() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"data")
    url = service.generate_presigned_url("tenant1/file.txt")
    # Default is 900 seconds
    assert "900" in url


@mock_aws
def test_generate_presigned_download_url_aliases_presigned_url() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"data")

    url = service.generate_presigned_download_url("tenant1/file.txt", expires_in=7200)

    assert isinstance(url, str)
    assert "tenant1/file.txt" in url
    assert "3600" in url


def test_generate_direct_upload_capability_requires_capability_secret() -> None:
    service = ObjectStorageService(make_config())

    with pytest.raises(ValueError, match="capability_secret"):
        service.generate_direct_upload_capability(
            DirectUploadInput(
                key="tenant1/uploads/file.png",
                content_type="image/png",
            ),
        )


def test_generate_direct_upload_capability_uses_default_expiry_and_round_trips() -> None:
    service = ObjectStorageService(make_config(capability_secret="test-capability-secret"))
    before = int(__import__("time").time() * 1000)

    token = service.generate_direct_upload_capability(
        DirectUploadInput(
            key="tenant1/uploads/file.png",
            content_type="image/png",
        ),
    )

    capability = service.verify_direct_upload_capability(token)
    assert isinstance(capability, DirectUploadCapability)
    assert capability.key == "tenant1/uploads/file.png"
    assert capability.content_type == "image/png"
    assert capability.max_size_bytes is None
    assert before + 899_000 <= capability.expires_at <= before + 901_000


def test_generate_direct_upload_capability_caps_expiry_and_includes_max_size() -> None:
    service = ObjectStorageService(make_config(capability_secret="test-capability-secret"))
    before = int(__import__("time").time() * 1000)

    token = service.generate_direct_upload_capability(
        DirectUploadInput(
            key="tenant1/uploads/file.png",
            content_type="image/png",
            max_size_bytes=2_000_000,
            expires_in=7200,
        ),
    )

    capability = service.verify_direct_upload_capability(token)
    assert isinstance(capability, DirectUploadCapability)
    assert capability.max_size_bytes == 2_000_000
    assert before + 3_599_000 <= capability.expires_at <= before + 3_601_000


def test_verify_direct_upload_capability_returns_none_for_invalid_token() -> None:
    service = ObjectStorageService(make_config(capability_secret="test-capability-secret"))

    assert service.verify_direct_upload_capability("invalid.token") is None


@mock_aws
def test_delete_removes_object() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/file.txt", b"delete me")
    service.delete("tenant1/file.txt")
    s3 = boto3.client("s3", region_name=REGION)
    with pytest.raises(Exception):
        s3.get_object(Bucket=BUCKET, Key="tenant1/file.txt")


@mock_aws
def test_exists_returns_true_for_existing_object() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    service.upload("tenant1/present.txt", b"here")
    assert service.exists("tenant1/present.txt") is True


@mock_aws
def test_exists_returns_false_for_missing_object() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    assert service.exists("tenant1/missing.txt") is False


@mock_aws
def test_stream_upload_concatenates_chunks() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    chunks = [b"chunk1", b"chunk2", b"chunk3"]
    result = service.stream_upload("tenant1/stream.bin", iter(chunks))
    assert isinstance(result, UploadResult)
    assert result.key == "tenant1/stream.bin"
    data = service.download("tenant1/stream.bin")
    assert data == b"chunk1chunk2chunk3"


@mock_aws
def test_stream_upload_with_content_type() -> None:
    create_bucket()
    service = ObjectStorageService(make_config())
    chunks = [b"part1", b"part2"]
    result = service.stream_upload("tenant1/data.csv", iter(chunks), content_type="text/csv")
    assert result.key == "tenant1/data.csv"
    s3 = boto3.client("s3", region_name=REGION)
    head = s3.head_object(Bucket=BUCKET, Key="tenant1/data.csv")
    assert head["ContentType"] == "text/csv"


@mock_aws
def test_upload_encryption_sets_metadata_flag() -> None:
    create_bucket()
    enc_key = generate_data_key()
    service = ObjectStorageService(make_config(encryption_key=enc_key))
    service.upload("tenant1/enc.bin", b"encrypted content")
    s3 = boto3.client("s3", region_name=REGION)
    head = s3.head_object(Bucket=BUCKET, Key="tenant1/enc.bin")
    assert head["Metadata"].get("x-ventora-encrypted") == "aes256gcm"


def test_upload_etag_is_extracted_and_quotes_stripped() -> None:
    """put_object response ETag (wrapped in double quotes) is stripped and returned."""
    service = ObjectStorageService(make_config())
    mock_client = MagicMock()
    mock_client.put_object.return_value = {"ETag": '"abc123"'}
    service._client = mock_client

    result = service.upload("tenant1/file.txt", b"data")

    assert result.etag == "abc123"


def test_upload_etag_is_empty_string_when_response_has_no_etag() -> None:
    """When put_object response has no ETag key, result.etag is empty string."""
    service = ObjectStorageService(make_config())
    mock_client = MagicMock()
    mock_client.put_object.return_value = {}
    service._client = mock_client

    result = service.upload("tenant1/file.txt", b"data")

    assert result.etag == ""


@mock_aws
def test_download_missing_key_raises_file_not_found_error() -> None:
    """download() on a non-existent key raises FileNotFoundError."""
    create_bucket()
    service = ObjectStorageService(make_config())
    with pytest.raises(FileNotFoundError, match="Object not found: tenant1/missing.bin"):
        service.download("tenant1/missing.bin")


@mock_aws
def test_download_missing_key_with_encryption_raises_file_not_found_error() -> None:
    """download() on a non-existent key raises FileNotFoundError even when encryption is enabled."""
    create_bucket()
    enc_key = generate_data_key()
    service = ObjectStorageService(make_config(encryption_key=enc_key))
    with pytest.raises(FileNotFoundError, match="Object not found: tenant1/secret.bin"):
        service.download("tenant1/secret.bin")


def test_download_reraises_non_404_client_errors() -> None:
    """download() re-raises ClientError when the error code is not a not-found variant."""
    import botocore.exceptions

    service = ObjectStorageService(make_config())
    mock_client = MagicMock()
    error_response = {"Error": {"Code": "InternalError", "Message": "Server error"}}
    mock_client.get_object.side_effect = botocore.exceptions.ClientError(
        error_response, "GetObject"
    )
    service._client = mock_client

    with pytest.raises(botocore.exceptions.ClientError):
        service.download("tenant1/file.txt")


@mock_aws
def test_download_present_key_still_returns_decrypted_bytes() -> None:
    """Regression: a present key still returns the correct (decrypted) bytes after the fix."""
    create_bucket()
    enc_key = generate_data_key()
    service = ObjectStorageService(make_config(encryption_key=enc_key))
    plaintext = b"still works after parity fix"
    service.upload("tenant1/present.bin", plaintext)
    assert service.download("tenant1/present.bin") == plaintext

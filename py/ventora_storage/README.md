# ventora-storage

S3-compatible object storage client (R2/S3 via boto3) with optional AES-256-GCM at-rest encryption, presigned download URLs, and signed direct-upload capability tokens.

## Install

```bash
uv add ventora-storage
```

## Usage

```python
from ventora_storage import ObjectStorageService, StorageConfig

config = StorageConfig(
    endpoint="https://<account>.r2.cloudflarestorage.com",
    access_key="...",
    secret_key="...",
    bucket="ventora-uploads",
    capability_secret="...",
)
storage = ObjectStorageService(config)

result = storage.upload("orgs/acme/report.pdf", b"...", content_type="application/pdf")
url = storage.generate_presigned_download_url(result.key, expires_in=900)
```

## Notes
- `ObjectStorageService.upload`/`download` transparently encrypt/decrypt with AES-256-GCM when `StorageConfig.encryption_key` is set, tagging the object metadata with `x-ventora-encrypted: aes256gcm`.
- Presigned download URLs are capped at `MAX_PRESIGNED_URL_EXPIRY` (3600s) regardless of the requested `expires_in`; direct-upload capability tokens are capped at `MAX_CAPABILITY_EXPIRY` (3600s) and default to `DEFAULT_CAPABILITY_EXPIRY` (900s).
- `sign_download_url`/`verify_download_url` and `generate_capability_token`/`verify_capability_token` use a base64url-encoded-payload + HMAC-SHA256-signature token format, verified with `hmac.compare_digest`.

# @ventora/storage

Object storage abstraction with matching R2 and S3-compatible clients, HMAC-signed download URLs and upload capability tokens, and filename/key sanitization.

## Install

```bash
pnpm add @ventora/storage
```

## Usage

```ts
import { createR2StorageClient, buildTenantKey, sanitizeFilename } from "@ventora/storage";

const storage = createR2StorageClient({
  bucket: env.UPLOADS_BUCKET,
  capabilitySecret: env.STORAGE_CAPABILITY_SECRET,
});

const key = buildTenantKey("acme-co", "invoices", sanitizeFilename(file.name));
await storage.upload(key, await file.arrayBuffer(), { contentType: file.type });
const downloadUrl = await storage.generatePresignedDownloadUrl(key);
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createR2StorageClient`, `createS3StorageClient`, `StorageProvider`/`UploadOptions`/`UploadResult`/`DirectUploadInput`/`DirectUploadCapability` types, `sanitizeFilename`, `buildTenantKey`, `signDownloadUrl`, `verifyDownloadUrl`, `generateCapabilityToken`, `verifyCapabilityToken` |

## Notes

- `createR2StorageClient` and `createS3StorageClient` both implement the same `StorageProvider` interface, so a product can swap Cloudflare R2 for an S3-compatible bucket without touching call sites.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are optional peer dependencies, dynamic-imported only by `createS3StorageClient`.
- Presigned download URLs and direct-upload capability tokens are self-contained HMAC-SHA256 tokens verified locally against `capabilitySecret`, not calls to AWS/Cloudflare's own signing APIs.

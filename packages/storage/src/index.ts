export type {
  StorageProvider,
  UploadOptions,
  UploadResult,
  DirectUploadInput,
  DirectUploadCapability,
  VirusScanHook,
} from "./types.js";

export type { R2BucketLike, R2Opts } from "./r2.js";
export { createR2StorageClient } from "./r2.js";

export type { S3Opts } from "./s3.js";
export { createS3StorageClient } from "./s3.js";

export { sanitizeFilename, buildTenantKey } from "./keys.js";

export type { DownloadUrlPayload } from "./signed-urls.js";
export {
  signDownloadUrl,
  verifyDownloadUrl,
  generateCapabilityToken,
  verifyCapabilityToken,
} from "./signed-urls.js";

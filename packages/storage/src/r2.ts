import { NotFoundError } from "@ventora/observability";
import { generateCapabilityToken, signDownloadUrl, verifyCapabilityToken } from "./signed-urls.js";
import type {
  DirectUploadCapability,
  DirectUploadInput,
  StorageProvider,
  UploadOptions,
  UploadResult,
  VirusScanHook,
} from "./types.js";

// Cloudflare R2 binding adapter
// R2Bucket interface (Workers) — do not import @cloudflare/workers-types to avoid dep

export type R2BucketLike = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    body: ArrayBuffer | Uint8Array,
    opts?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ etag: string }>;
  head(key: string): Promise<{ key: string } | null>;
  delete(key: string): Promise<void>;
};

export type R2Opts = {
  bucket: R2BucketLike;
  capabilitySecret: string;
  publicBaseUrl?: string; // For presigned URLs if not using direct R2 URLs
  virusScan?: VirusScanHook;
};

export function createR2StorageClient(opts: R2Opts): StorageProvider {
  const { bucket, capabilitySecret, publicBaseUrl, virusScan } = opts;

  return {
    async upload(
      key: string,
      body: Uint8Array | ArrayBuffer,
      uploadOpts?: UploadOptions,
    ): Promise<UploadResult> {
      if (virusScan) {
        await virusScan(key, body);
      }

      const result = await bucket.put(key, body, {
        httpMetadata: {
          ...(uploadOpts?.contentType !== undefined ? { contentType: uploadOpts.contentType } : {}),
          ...(uploadOpts?.cacheControl !== undefined
            ? { cacheControl: uploadOpts.cacheControl }
            : {}),
        },
        ...(uploadOpts?.metadata !== undefined ? { customMetadata: uploadOpts.metadata } : {}),
      });

      return { etag: result.etag };
    },

    async download(key: string): Promise<Uint8Array> {
      const object = await bucket.get(key);
      if (object === null) {
        throw new NotFoundError(`Object not found: ${key}`);
      }
      const buffer = await object.arrayBuffer();
      return new Uint8Array(buffer);
    },

    async exists(key: string): Promise<boolean> {
      const head = await bucket.head(key);
      return head !== null;
    },

    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },

    async generatePresignedDownloadUrl(
      key: string,
      presignOpts?: { expiresIn?: number },
    ): Promise<string> {
      const expiresIn = Math.min(presignOpts?.expiresIn ?? 900, 3600);
      const expiresAt = Date.now() + expiresIn * 1000;

      const token = await signDownloadUrl({ key, expiresAt }, capabilitySecret);

      if (publicBaseUrl) {
        return `${publicBaseUrl}?token=${token}`;
      }
      return token;
    },

    async generateDirectUploadCapability(input: DirectUploadInput): Promise<string> {
      const expiresIn = Math.min(input.expiresIn ?? 900, 3600);
      const capability: DirectUploadCapability = {
        key: input.key,
        contentType: input.contentType,
        ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
        expiresAt: Date.now() + expiresIn * 1000,
      };
      return generateCapabilityToken(capability, capabilitySecret);
    },

    async verifyDirectUploadCapability(token: string): Promise<DirectUploadCapability | null> {
      return verifyCapabilityToken(token, capabilitySecret);
    },
  };
}

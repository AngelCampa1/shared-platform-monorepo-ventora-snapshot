import { NotFoundError } from "@ventora/observability";
import { generateCapabilityToken, verifyCapabilityToken } from "./signed-urls.js";
import type {
  DirectUploadCapability,
  DirectUploadInput,
  StorageProvider,
  UploadOptions,
  UploadResult,
  VirusScanHook,
} from "./types.js";

// AWS SDK / R2 S3-compatible API adapter
// Dynamically imports @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner

export type S3Opts = {
  endpoint: string; // R2: https://<accountid>.r2.cloudflarestorage.com
  region?: string; // R2: "auto"
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  capabilitySecret: string;
  virusScan?: VirusScanHook;
};

type S3ClientModule = typeof import("@aws-sdk/client-s3");
type PresignerModule = typeof import("@aws-sdk/s3-request-presigner");

async function getS3Modules(): Promise<{ s3: S3ClientModule; presigner: PresignerModule }> {
  const [s3, presigner] = await Promise.all([
    import("@aws-sdk/client-s3") as Promise<S3ClientModule>,
    import("@aws-sdk/s3-request-presigner") as Promise<PresignerModule>,
  ]);
  return { s3, presigner };
}

export function createS3StorageClient(opts: S3Opts): StorageProvider {
  const {
    endpoint,
    region = "auto",
    accessKeyId,
    secretAccessKey,
    bucket,
    capabilitySecret,
    virusScan,
  } = opts;

  // Lazy-initialize client on first use
  let clientCache: import("@aws-sdk/client-s3").S3Client | null = null;

  async function getClient(): Promise<import("@aws-sdk/client-s3").S3Client> {
    if (clientCache) return clientCache;
    const { s3 } = await getS3Modules();
    clientCache = new s3.S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    return clientCache;
  }

  return {
    async upload(
      key: string,
      body: Uint8Array | ArrayBuffer,
      uploadOpts?: UploadOptions,
    ): Promise<UploadResult> {
      if (virusScan) {
        await virusScan(key, body);
      }

      const client = await getClient();
      const { s3 } = await getS3Modules();

      const result = await client.send(
        new s3.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body instanceof ArrayBuffer ? new Uint8Array(body) : body,
          ContentType: uploadOpts?.contentType,
          CacheControl: uploadOpts?.cacheControl,
          Metadata: uploadOpts?.metadata,
        }),
      );

      return { etag: result.ETag ?? "" };
    },

    async download(key: string): Promise<Uint8Array> {
      const client = await getClient();
      const { s3 } = await getS3Modules();

      let result: import("@aws-sdk/client-s3").GetObjectCommandOutput;
      try {
        result = await client.send(
          new s3.GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "NoSuchKey" ||
            err.name === "NotFound" ||
            (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        ) {
          throw new NotFoundError(`Object not found: ${key}`);
        }
        throw err;
      }

      if (!result.Body) {
        throw new NotFoundError(`Object not found: ${key}`);
      }

      const bytes = await result.Body.transformToByteArray();
      return bytes;
    },

    async exists(key: string): Promise<boolean> {
      const client = await getClient();
      const { s3 } = await getS3Modules();

      try {
        await client.send(
          new s3.HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        return true;
      } catch {
        return false;
      }
    },

    async delete(key: string): Promise<void> {
      const client = await getClient();
      const { s3 } = await getS3Modules();

      await client.send(
        new s3.DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    },

    async generatePresignedDownloadUrl(
      key: string,
      presignOpts?: { expiresIn?: number },
    ): Promise<string> {
      const expiresIn = Math.min(presignOpts?.expiresIn ?? 900, 3600);
      const client = await getClient();
      const { s3, presigner } = await getS3Modules();

      const url = await presigner.getSignedUrl(
        client,
        new s3.GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
        { expiresIn },
      );

      return url;
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

import { NotFoundError } from "@ventora/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3StorageClient } from "../s3.js";

function decodeBase64url(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const paddedStr = pad === 0 ? padded : padded + "=".repeat(4 - pad);
  return atob(paddedStr);
}

const SECRET = "test-capability-secret";

const S3_OPTS = {
  endpoint: "https://account.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  bucket: "test-bucket",
  capabilitySecret: SECRET,
};

// Mock S3 client internals
const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();
const mockS3Client = { send: mockSend };

// Mock classes
class MockPutObjectCommand {
  constructor(public input: unknown) {}
}
class MockGetObjectCommand {
  constructor(public input: unknown) {}
}
class MockHeadObjectCommand {
  constructor(public input: unknown) {}
}
class MockDeleteObjectCommand {
  constructor(public input: unknown) {}
}

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => mockS3Client),
  PutObjectCommand: MockPutObjectCommand,
  GetObjectCommand: MockGetObjectCommand,
  HeadObjectCommand: MockHeadObjectCommand,
  DeleteObjectCommand: MockDeleteObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

describe("createS3StorageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("upload", () => {
    it("sends PutObjectCommand and returns etag", async () => {
      mockSend.mockResolvedValue({ ETag: '"abc123"' });
      const client = createS3StorageClient(S3_OPTS);
      const body = new Uint8Array([1, 2, 3]);
      const result = await client.upload("tenant1/file.txt", body);
      expect(mockSend).toHaveBeenCalledOnce();
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(MockPutObjectCommand);
      expect((call as MockPutObjectCommand).input).toMatchObject({
        Bucket: "test-bucket",
        Key: "tenant1/file.txt",
      });
      expect(result.etag).toBe('"abc123"');
    });

    it("passes contentType and metadata to PutObjectCommand", async () => {
      mockSend.mockResolvedValue({ ETag: '"etag"' });
      const client = createS3StorageClient(S3_OPTS);
      await client.upload("key", new Uint8Array([1]), {
        contentType: "image/png",
        metadata: { owner: "tenant1" },
        cacheControl: "public, max-age=3600",
      });
      const call = mockSend.mock.calls[0]?.[0] as MockPutObjectCommand;
      expect((call.input as Record<string, unknown>).ContentType).toBe("image/png");
      expect((call.input as Record<string, unknown>).Metadata).toEqual({ owner: "tenant1" });
      expect((call.input as Record<string, unknown>).CacheControl).toBe("public, max-age=3600");
    });

    it("calls virusScan before uploading", async () => {
      const virusScan = vi.fn().mockResolvedValue(undefined);
      mockSend.mockResolvedValue({ ETag: '"etag"' });
      const client = createS3StorageClient({ ...S3_OPTS, virusScan });
      const body = new Uint8Array([5, 6]);
      await client.upload("key", body);
      expect(virusScan).toHaveBeenCalledWith("key", body);
    });

    it("does not upload if virusScan throws", async () => {
      const virusScan = vi.fn().mockRejectedValue(new Error("Infected!"));
      const client = createS3StorageClient({ ...S3_OPTS, virusScan });
      await expect(client.upload("key", new Uint8Array([1]))).rejects.toThrow("Infected!");
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("converts ArrayBuffer body to Uint8Array", async () => {
      mockSend.mockResolvedValue({ ETag: '"etag"' });
      const client = createS3StorageClient(S3_OPTS);
      const buffer = new ArrayBuffer(2);
      await client.upload("key", buffer);
      const call = mockSend.mock.calls[0]?.[0] as MockPutObjectCommand;
      expect((call.input as Record<string, unknown>).Body).toBeInstanceOf(Uint8Array);
    });

    it("returns empty string etag when ETag is undefined", async () => {
      mockSend.mockResolvedValue({});
      const client = createS3StorageClient(S3_OPTS);
      const result = await client.upload("key", new Uint8Array([1]));
      expect(result.etag).toBe("");
    });
  });

  describe("download", () => {
    it("returns Uint8Array when object exists", async () => {
      const bytes = new Uint8Array([10, 20, 30]);
      mockSend.mockResolvedValue({
        Body: {
          transformToByteArray: async () => bytes,
        },
      });
      const client = createS3StorageClient(S3_OPTS);
      const result = await client.download("key");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });

    it("throws NotFoundError on NoSuchKey error", async () => {
      const err = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      mockSend.mockRejectedValue(err);
      const client = createS3StorageClient(S3_OPTS);
      await expect(client.download("missing")).rejects.toThrow(NotFoundError);
    });

    it("throws NotFoundError on NotFound error name", async () => {
      const err = Object.assign(new Error("Not Found"), {
        name: "NotFound",
      });
      mockSend.mockRejectedValue(err);
      const client = createS3StorageClient(S3_OPTS);
      await expect(client.download("missing")).rejects.toThrow(NotFoundError);
    });

    it("throws NotFoundError on 404 http status from $metadata", async () => {
      const err = Object.assign(new Error("Unknown S3 error"), {
        name: "S3ServiceException",
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValue(err);
      const client = createS3StorageClient(S3_OPTS);
      await expect(client.download("missing")).rejects.toThrow(NotFoundError);
    });

    it("rethrows non-NotFound errors", async () => {
      const err = new Error("Network error");
      mockSend.mockRejectedValue(err);
      const client = createS3StorageClient(S3_OPTS);
      await expect(client.download("key")).rejects.toThrow("Network error");
      await expect(client.download("key")).rejects.not.toThrow(NotFoundError);
    });

    it("throws NotFoundError when Body is missing", async () => {
      mockSend.mockResolvedValue({ Body: null });
      const client = createS3StorageClient(S3_OPTS);
      await expect(client.download("key")).rejects.toThrow(NotFoundError);
    });
  });

  describe("exists", () => {
    it("returns true when HeadObjectCommand succeeds", async () => {
      mockSend.mockResolvedValue({});
      const client = createS3StorageClient(S3_OPTS);
      expect(await client.exists("key")).toBe(true);
    });

    it("returns false when HeadObjectCommand throws", async () => {
      mockSend.mockRejectedValue(new Error("Not found"));
      const client = createS3StorageClient(S3_OPTS);
      expect(await client.exists("missing")).toBe(false);
    });
  });

  describe("delete", () => {
    it("sends DeleteObjectCommand", async () => {
      mockSend.mockResolvedValue({});
      const client = createS3StorageClient(S3_OPTS);
      await client.delete("tenant1/file.txt");
      expect(mockSend).toHaveBeenCalledOnce();
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(MockDeleteObjectCommand);
    });
  });

  describe("generatePresignedDownloadUrl", () => {
    it("returns a presigned URL", async () => {
      mockGetSignedUrl.mockResolvedValue("https://s3.example.com/key?X-Signature=abc");
      const client = createS3StorageClient(S3_OPTS);
      const url = await client.generatePresignedDownloadUrl("tenant1/file.txt");
      expect(url).toBe("https://s3.example.com/key?X-Signature=abc");
    });

    it("caps expiresIn to 3600 seconds", async () => {
      mockGetSignedUrl.mockResolvedValue("https://s3.example.com/presigned");
      const client = createS3StorageClient(S3_OPTS);
      await client.generatePresignedDownloadUrl("key", { expiresIn: 7200 });
      // Third argument to getSignedUrl should have expiresIn <= 3600
      const callArgs = mockGetSignedUrl.mock.calls[0];
      expect(callArgs?.[2]).toMatchObject({ expiresIn: 3600 });
    });

    it("uses default expiresIn of 900 when not specified", async () => {
      mockGetSignedUrl.mockResolvedValue("https://s3.example.com/presigned");
      const client = createS3StorageClient(S3_OPTS);
      await client.generatePresignedDownloadUrl("key");
      const callArgs = mockGetSignedUrl.mock.calls[0];
      expect(callArgs?.[2]).toMatchObject({ expiresIn: 900 });
    });

    it("enforces max 3600 even for expiresIn exactly at boundary", async () => {
      mockGetSignedUrl.mockResolvedValue("https://s3.example.com/presigned");
      const client = createS3StorageClient(S3_OPTS);
      await client.generatePresignedDownloadUrl("key", { expiresIn: 3600 });
      const callArgs = mockGetSignedUrl.mock.calls[0];
      expect(callArgs?.[2]).toMatchObject({ expiresIn: 3600 });
    });
  });

  describe("generateDirectUploadCapability", () => {
    it("returns a capability token", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const token = await client.generateDirectUploadCapability({
        key: "tenant1/upload/file.png",
        contentType: "image/png",
        expiresIn: 300,
      });
      expect(typeof token).toBe("string");
      expect(token).toMatch(/\./);
    });

    it("caps expiresIn to 3600 seconds", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const before = Date.now();
      const token = await client.generateDirectUploadCapability({
        key: "key",
        contentType: "image/png",
        expiresIn: 7200,
      });
      const [encodedPayload] = token.split(".");
      const payloadJson = decodeBase64url(encodedPayload ?? "");
      const payload = JSON.parse(payloadJson) as { expiresAt: number };
      expect(payload.expiresAt).toBeLessThanOrEqual(before + 3600 * 1000 + 100);
    });

    it("uses default expiresIn of 900 when not specified", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const before = Date.now();
      const token = await client.generateDirectUploadCapability({
        key: "key",
        contentType: "image/png",
      });
      const [encodedPayload] = token.split(".");
      const payloadJson = decodeBase64url(encodedPayload ?? "");
      const payload = JSON.parse(payloadJson) as { expiresAt: number };
      expect(payload.expiresAt).toBeLessThanOrEqual(before + 900 * 1000 + 100);
    });

    it("includes maxSizeBytes when provided", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const token = await client.generateDirectUploadCapability({
        key: "key",
        contentType: "image/png",
        maxSizeBytes: 2_000_000,
        expiresIn: 300,
      });
      const result = await client.verifyDirectUploadCapability(token);
      expect(result?.maxSizeBytes).toBe(2_000_000);
    });
  });

  describe("verifyDirectUploadCapability", () => {
    it("returns capability for valid token", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const token = await client.generateDirectUploadCapability({
        key: "tenant1/upload/file.png",
        contentType: "image/png",
        expiresIn: 300,
      });
      const result = await client.verifyDirectUploadCapability(token);
      expect(result).not.toBeNull();
      expect(result?.key).toBe("tenant1/upload/file.png");
    });

    it("returns null for invalid token", async () => {
      const client = createS3StorageClient(S3_OPTS);
      const result = await client.verifyDirectUploadCapability("invalid.token");
      expect(result).toBeNull();
    });
  });
});

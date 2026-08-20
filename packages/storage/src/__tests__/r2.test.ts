import { NotFoundError } from "@ventora/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createR2StorageClient } from "../r2.js";
import type { R2BucketLike } from "../r2.js";

function decodeBase64url(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const paddedStr = pad === 0 ? padded : padded + "=".repeat(4 - pad);
  return atob(paddedStr);
}

const SECRET = "test-capability-secret";

function makeMockBucket(): R2BucketLike {
  return {
    get: vi.fn(),
    put: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(),
  };
}

describe("createR2StorageClient", () => {
  let bucket: R2BucketLike;

  beforeEach(() => {
    bucket = makeMockBucket();
  });

  describe("upload", () => {
    it("calls bucket.put with key and body and returns etag", async () => {
      vi.mocked(bucket.put).mockResolvedValue({ etag: '"abc123"' });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const body = new Uint8Array([1, 2, 3]);
      const result = await client.upload("tenant1/file.txt", body);
      expect(bucket.put).toHaveBeenCalledWith("tenant1/file.txt", body, expect.any(Object));
      expect(result.etag).toBe('"abc123"');
    });

    it("passes contentType and metadata to bucket.put", async () => {
      vi.mocked(bucket.put).mockResolvedValue({ etag: '"etag1"' });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const body = new Uint8Array([1]);
      await client.upload("key", body, {
        contentType: "image/png",
        metadata: { owner: "tenant1" },
        cacheControl: "public, max-age=3600",
      });
      expect(bucket.put).toHaveBeenCalledWith("key", body, {
        httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=3600" },
        customMetadata: { owner: "tenant1" },
      });
    });

    it("calls virusScan hook before storing", async () => {
      const callOrder: string[] = [];
      const virusScan = vi.fn().mockImplementation(async () => {
        callOrder.push("virusScan");
      });
      vi.mocked(bucket.put).mockImplementation(async () => {
        callOrder.push("put");
        return { etag: '"abc"' };
      });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET, virusScan });
      const body = new Uint8Array([1, 2]);
      await client.upload("key", body);
      expect(virusScan).toHaveBeenCalledWith("key", body);
      expect(callOrder).toEqual(["virusScan", "put"]);
    });

    it("does not call bucket.put if virusScan throws", async () => {
      const virusScan = vi.fn().mockRejectedValue(new Error("Infected!"));
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET, virusScan });
      const body = new Uint8Array([1, 2]);
      await expect(client.upload("key", body)).rejects.toThrow("Infected!");
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it("works without virusScan hook", async () => {
      vi.mocked(bucket.put).mockResolvedValue({ etag: '"etag"' });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      await expect(client.upload("key", new Uint8Array([1]))).resolves.toEqual({ etag: '"etag"' });
    });
  });

  describe("download", () => {
    it("returns Uint8Array when object exists", async () => {
      const buffer = new ArrayBuffer(3);
      new Uint8Array(buffer).set([10, 20, 30]);
      vi.mocked(bucket.get).mockResolvedValue({
        arrayBuffer: async () => buffer,
      });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const result = await client.download("key");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });

    it("throws NotFoundError when object does not exist", async () => {
      vi.mocked(bucket.get).mockResolvedValue(null);
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      await expect(client.download("missing-key")).rejects.toThrow(NotFoundError);
    });
  });

  describe("exists", () => {
    it("returns true when head returns an object", async () => {
      vi.mocked(bucket.head).mockResolvedValue({ key: "tenant1/file.txt" });
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      expect(await client.exists("tenant1/file.txt")).toBe(true);
    });

    it("returns false when head returns null", async () => {
      vi.mocked(bucket.head).mockResolvedValue(null);
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      expect(await client.exists("missing")).toBe(false);
    });
  });

  describe("delete", () => {
    it("calls bucket.delete with the key", async () => {
      vi.mocked(bucket.delete).mockResolvedValue(undefined);
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      await client.delete("tenant1/file.txt");
      expect(bucket.delete).toHaveBeenCalledWith("tenant1/file.txt");
    });
  });

  describe("generatePresignedDownloadUrl", () => {
    it("returns a token string when no publicBaseUrl", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const result = await client.generatePresignedDownloadUrl("tenant1/file.txt");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("returns URL with token query param when publicBaseUrl is set", async () => {
      const client = createR2StorageClient({
        bucket,
        capabilitySecret: SECRET,
        publicBaseUrl: "https://cdn.example.com/files",
      });
      const result = await client.generatePresignedDownloadUrl("tenant1/file.txt");
      expect(result).toMatch(/^https:\/\/cdn\.example\.com\/files\?token=/);
    });

    it("caps expiresIn to 3600 seconds", async () => {
      const client = createR2StorageClient({
        bucket,
        capabilitySecret: SECRET,
        publicBaseUrl: "https://cdn.example.com",
      });
      // Request 7200s but expect expiry ≤ 3600s from now
      const before = Date.now();
      const url = await client.generatePresignedDownloadUrl("key", { expiresIn: 7200 });
      const tokenPart = url.split("?token=")[1] ?? "";
      // Decode and check expiry
      const [encodedPayload] = tokenPart.split(".");
      const payloadJson = decodeBase64url(encodedPayload ?? "");
      const payload = JSON.parse(payloadJson) as { expiresAt: number };
      expect(payload.expiresAt).toBeLessThanOrEqual(before + 3600 * 1000 + 100);
    });

    it("uses default expiresIn of 900 seconds when not specified", async () => {
      const client = createR2StorageClient({
        bucket,
        capabilitySecret: SECRET,
        publicBaseUrl: "https://cdn.example.com",
      });
      const before = Date.now();
      const url = await client.generatePresignedDownloadUrl("key");
      const tokenPart = url.split("?token=")[1] ?? "";
      const [encodedPayload] = tokenPart.split(".");
      const payloadJson = decodeBase64url(encodedPayload ?? "");
      const payload = JSON.parse(payloadJson) as { expiresAt: number };
      expect(payload.expiresAt).toBeLessThanOrEqual(before + 900 * 1000 + 100);
      expect(payload.expiresAt).toBeGreaterThanOrEqual(before + 899 * 1000);
    });
  });

  describe("generateDirectUploadCapability", () => {
    it("returns a token string", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const token = await client.generateDirectUploadCapability({
        key: "tenant1/upload/file.png",
        contentType: "image/png",
        expiresIn: 300,
      });
      expect(typeof token).toBe("string");
      expect(token).toMatch(/\./);
    });

    it("caps expiresIn to 3600 seconds", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
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
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
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

    it("includes maxSizeBytes in capability when provided", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const token = await client.generateDirectUploadCapability({
        key: "key",
        contentType: "image/png",
        maxSizeBytes: 1_000_000,
        expiresIn: 300,
      });
      const result = await client.verifyDirectUploadCapability(token);
      expect(result?.maxSizeBytes).toBe(1_000_000);
    });
  });

  describe("verifyDirectUploadCapability", () => {
    it("returns capability for valid token", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const token = await client.generateDirectUploadCapability({
        key: "tenant1/upload/file.png",
        contentType: "image/png",
        expiresIn: 300,
      });
      const result = await client.verifyDirectUploadCapability(token);
      expect(result).not.toBeNull();
      expect(result?.key).toBe("tenant1/upload/file.png");
      expect(result?.contentType).toBe("image/png");
    });

    it("returns null for invalid token", async () => {
      const client = createR2StorageClient({ bucket, capabilitySecret: SECRET });
      const result = await client.verifyDirectUploadCapability("invalid.token");
      expect(result).toBeNull();
    });
  });
});

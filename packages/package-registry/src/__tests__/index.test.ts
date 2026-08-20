import { describe, expect, it } from "vitest";
import worker, { type Env } from "../index.js";

type BucketBinding = Env["REGISTRY_BUCKET"];

class MemoryObject {
  readonly httpMetadata: { contentType?: string };
  readonly body?: ReadableStream<Uint8Array>;

  constructor(
    private readonly bytes: ArrayBuffer,
    contentType?: string,
    streamBody = false,
  ) {
    this.httpMetadata = contentType ? { contentType } : {};
    if (streamBody) {
      this.body = new Blob([bytes]).stream();
    }
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes;
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata.contentType) {
      headers.set("Content-Type", this.httpMetadata.contentType);
    }
  }
}

class MemoryBucket implements BucketBinding {
  readonly values = new Map<string, MemoryObject>();

  async get(key: string): Promise<MemoryObject | null> {
    return this.values.get(key) ?? null;
  }

  async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.values.has(key)) {
      return null;
    }
    let bytes: ArrayBuffer;
    if (typeof value === "string") {
      const encoded = new TextEncoder().encode(value);
      bytes = new ArrayBuffer(encoded.byteLength);
      new Uint8Array(bytes).set(encoded);
    } else {
      bytes = value;
    }
    const object = new MemoryObject(bytes, options?.httpMetadata?.contentType);
    this.values.set(key, object);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class BlockingPackumentBucket extends MemoryBucket {
  private waitingReads = 0;
  private releaseReads: (() => void) | null = null;
  private readonly readsReleased = new Promise<void>((resolve) => {
    this.releaseReads = resolve;
  });

  override async get(key: string): Promise<MemoryObject | null> {
    if (key === "metadata/@ventora/analytics/packument.json") {
      this.waitingReads += 1;
      if (this.waitingReads === 2) {
        this.releaseReads?.();
      }
      await Promise.race([this.readsReleased, new Promise((resolve) => setTimeout(resolve, 25))]);
    }
    return super.get(key);
  }
}

class FailingPackumentWriteBucket extends MemoryBucket {
  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key === "metadata/@ventora/analytics/packument.json") {
      throw new Error("packument write failed");
    }
    return super.put(key, value, options);
  }
}

class RaceyPackumentWriteBucket extends MemoryBucket {
  private packumentWrites = 0;
  private releaseWrites: (() => void) | null = null;
  private readonly writesReleased = new Promise<void>((resolve) => {
    this.releaseWrites = resolve;
  });

  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key === "metadata/@ventora/analytics/packument.json") {
      this.packumentWrites += 1;
      if (this.packumentWrites === 2) {
        this.releaseWrites?.();
      } else {
        await Promise.race([
          this.writesReleased,
          new Promise((resolve) => setTimeout(resolve, 25)),
        ]);
      }
    }
    return super.put(key, value, options);
  }
}

class HijackingPackumentWriteBucket extends MemoryBucket {
  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key === "metadata/@ventora/analytics/packument.json") {
      await super.put(
        "locks/@ventora/analytics/publish.json",
        JSON.stringify({
          name: "@ventora/analytics",
          owner: "other-worker",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      );
    }
    return super.put(key, value, options);
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    REGISTRY_BUCKET: new MemoryBucket(),
    REGISTRY_READ_TOKEN: "read-token",
    REGISTRY_ADMIN_TOKEN: "admin-token",
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://registry.test${path}`, init);
}

function auth(token = "read-token"): Headers {
  return new Headers({ Authorization: `Bearer ${token}` });
}

const validTarballBase64 = "H4sIAAAAAAAACitITM5OTE8FAJVnaN4HAAAA";
const validTarballIntegrity =
  "sha512-BzlEtrdcDdSE2+24qRMtgjNj52tT0+bTDYtz4E8N6QoV9hoDmCgoVwbZIyVeDwM2W3G9gO7kzAgdVvNFcdr09Q==";
const validTarballShasum = "c26b45088fe9ec9dc5d7d9edee0fa2ef9b8408e6";

function payload(version = "0.1.0"): Record<string, unknown> {
  return {
    name: "@ventora/analytics",
    version,
    tag: "latest",
    packageJson: {
      name: "@ventora/analytics",
      version,
      type: "module",
      exports: { ".": "./dist/index.js" },
    },
    tarballName: `ventora-analytics-${version}.tgz`,
    tarballBase64: validTarballBase64,
    integrity: validTarballIntegrity,
    shasum: validTarballShasum,
  };
}

async function publish(testEnv: Env, body: unknown = payload()): Promise<Response> {
  return worker.fetch(
    request("/-/ventora/packages", {
      method: "PUT",
      headers: auth("admin-token"),
      body: JSON.stringify(body),
    }),
    testEnv,
  );
}

describe("package registry worker", () => {
  it("answers health checks without authentication", async () => {
    const response = await worker.fetch(request("/-/ping"), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("requires read authentication for package metadata", async () => {
    const response = await worker.fetch(request("/@ventora%2Fanalytics"), env());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("requires admin authentication for publishing", async () => {
    const response = await worker.fetch(
      request("/-/ventora/packages", {
        method: "PUT",
        headers: auth("read-token"),
        body: JSON.stringify(payload()),
      }),
      env(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects non-gzip tarballs even when metadata shape is valid", async () => {
    const response = await publish(env(), {
      ...payload(),
      tarballBase64: Buffer.from("not a tgz").toString("base64"),
      integrity: "sha512-test",
      shasum: "a".repeat(40),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid tarball" });
  });

  it("publishes package metadata and serves the tarball to readers", async () => {
    const testEnv = env();
    const publishResponse = await publish(testEnv);

    expect(publishResponse.status).toBe(201);
    await expect(publishResponse.json()).resolves.toEqual({
      ok: true,
      name: "@ventora/analytics",
      version: "0.1.0",
      tag: "latest",
    });

    const metadataResponse = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      testEnv,
    );

    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json();
    expect(metadata).toMatchObject({
      _id: "@ventora/analytics",
      name: "@ventora/analytics",
      "dist-tags": { latest: "0.1.0" },
      versions: {
        "0.1.0": {
          name: "@ventora/analytics",
          version: "0.1.0",
          dist: {
            integrity: validTarballIntegrity,
            shasum: validTarballShasum,
            tarball: "https://registry.test/@ventora/analytics/-/ventora-analytics-0.1.0.tgz",
          },
        },
      },
    });

    const tarballResponse = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(tarballResponse.status).toBe(200);
    expect(tarballResponse.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(Buffer.from(await tarballResponse.arrayBuffer()).toString("base64")).toBe(
      validTarballBase64,
    );
  });

  it("lets the admin token install packages", async () => {
    const testEnv = env();
    await publish(testEnv);

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth("admin-token") }),
      testEnv,
    );

    expect(response.status).toBe(200);
  });

  it("supports read-only installs when no admin token is configured", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "metadata/@ventora/analytics/packument.json",
      JSON.stringify({
        _id: "@ventora/analytics",
        name: "@ventora/analytics",
        "dist-tags": { latest: "0.1.0" },
        versions: {},
        time: {},
      }),
    );
    const testEnv: Env = {
      REGISTRY_BUCKET: bucket,
      REGISTRY_READ_TOKEN: "read-token",
    };

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      testEnv,
    );

    expect(response.status).toBe(200);
  });

  it("updates an existing packument with a new version", async () => {
    const testEnv = env();
    await publish(testEnv);
    const secondPublish = await publish(testEnv, payload("0.2.0"));

    expect(secondPublish.status).toBe(201);

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      testEnv,
    );
    const metadata = await response.json();

    expect(metadata).toMatchObject({
      "dist-tags": { latest: "0.2.0" },
      versions: {
        "0.1.0": { version: "0.1.0" },
        "0.2.0": { version: "0.2.0" },
      },
    });
  });

  it("rejects malformed publish payloads", async () => {
    const invalidPayload = { ...payload(), name: "@other/analytics" };
    const response = await publish(env(), invalidPayload);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid publish payload" });
  });

  it("rejects publish payloads with invalid required fields", async () => {
    const cases: unknown[] = [
      null,
      { ...payload(), version: "" },
      { ...payload(), tag: "" },
      { ...payload(), tarballName: "analytics-0.1.0.zip" },
      { ...payload(), integrity: "md5-test" },
      { ...payload(), shasum: "not-a-sha" },
      { ...payload(), version: 1 },
      { ...payload(), packageJson: null },
      { ...payload(), packageJson: { name: "@ventora/analytics", version: "9.9.9" } },
    ];

    for (const testCase of cases) {
      const response = await publish(env(), testCase);

      expect(response.status).toBe(400);
    }
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await worker.fetch(
      request("/-/ventora/packages", {
        method: "PUT",
        headers: auth("admin-token"),
        body: "{",
      }),
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("returns not found for missing packages and tarballs", async () => {
    const testEnv = env();
    const missingPackage = await worker.fetch(
      request("/@ventora%2Fmissing", { headers: auth() }),
      testEnv,
    );

    expect(missingPackage.status).toBe(404);

    await publish(testEnv);
    const missingTarball = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-9.9.9.tgz", { headers: auth() }),
      testEnv,
    );

    expect(missingTarball.status).toBe(404);
  });

  it("requires read authentication for tarball downloads", async () => {
    const testEnv = env();
    await publish(testEnv);

    const response = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz"),
      testEnv,
    );

    expect(response.status).toBe(401);
  });

  it("returns not found when tarball metadata exists but the R2 object is missing", async () => {
    const bucket = new MemoryBucket();
    const testEnv = env({ REGISTRY_BUCKET: bucket });
    await publish(testEnv);
    bucket.values.delete("tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz");

    const response = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(response.status).toBe(404);
  });

  it("uses the default tarball content type when R2 metadata is absent", async () => {
    const bucket = new MemoryBucket();
    const testEnv = env({ REGISTRY_BUCKET: bucket });
    await publish(testEnv);
    const stored = bucket.values.get(
      "tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz",
    );
    expect(stored).toBeTruthy();
    if (stored) {
      bucket.values.set(
        "tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz",
        new MemoryObject(await stored.arrayBuffer()),
      );
    }

    const response = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("returns not found when downloading a tarball for a package with no metadata", async () => {
    const response = await worker.fetch(
      request("/@ventora/missing/-/ventora-missing-0.1.0.tgz", { headers: auth() }),
      env(),
    );

    expect(response.status).toBe(404);
  });

  it("rejects invalid tarball encoding", async () => {
    const response = await publish(env(), { ...payload(), tarballBase64: "*" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid tarball encoding" });
  });

  it("rejects attempts to overwrite an existing package version", async () => {
    const testEnv = env();
    await publish(testEnv);

    const response = await publish(testEnv);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Package version already exists" });
  });

  it("keeps the original tarball bytes when rejecting an existing package version", async () => {
    const testEnv = env();
    await publish(testEnv);

    const response = await publish(testEnv, payload());

    expect(response.status).toBe(409);

    const tarballResponse = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(tarballResponse.status).toBe(200);
    expect(Buffer.from(await tarballResponse.arrayBuffer()).toString("base64")).toBe(
      validTarballBase64,
    );
  });

  it("rejects publishing when a stale version claim already exists", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "claims/@ventora/analytics/0.1.0.json",
      JSON.stringify({ name: "@ventora/analytics", version: "0.1.0" }),
    );
    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Package version already exists" });
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("cleans up the claim when tarball bytes already exist", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz",
      "existing-tarball",
    );
    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Package version already exists" });
    expect(bucket.values.has("claims/@ventora/analytics/0.1.0.json")).toBe(false);
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("allows only one concurrent publish for the same package version", async () => {
    const bucket = new BlockingPackumentBucket();
    const testEnv = env({ REGISTRY_BUCKET: bucket });

    const [first, second] = await Promise.all([publish(testEnv), publish(testEnv, payload())]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const tarballResponse = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(tarballResponse.status).toBe(200);
    expect(Buffer.from(await tarballResponse.arrayBuffer()).toString("base64")).toBe(
      validTarballBase64,
    );
  });

  it("preserves all versions from concurrent publishes of the same package", async () => {
    const bucket = new RaceyPackumentWriteBucket();
    const testEnv = env({ REGISTRY_BUCKET: bucket });

    const [first, second] = await Promise.all([
      publish(testEnv, payload("0.1.0")),
      publish(testEnv, payload("0.2.0")),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 201]);

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      testEnv,
    );
    const metadata = await response.json();

    expect(metadata).toMatchObject({
      versions: {
        "0.1.0": { version: "0.1.0" },
        "0.2.0": { version: "0.2.0" },
      },
    });
  });

  it("cleans up the tarball claim and bytes when metadata write fails", async () => {
    const bucket = new FailingPackumentWriteBucket();
    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(500);
    expect(bucket.values.has("tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz")).toBe(
      false,
    );
    expect(bucket.values.has("claims/@ventora/analytics/0.1.0.json")).toBe(false);
  });

  it("reclaims an expired publish lock and releases it after publishing", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "locks/@ventora/analytics/publish.json",
      JSON.stringify({
        name: "@ventora/analytics",
        owner: "dead-worker",
        createdAt: "2024-01-01T00:00:00.000Z",
        expiresAt: "2024-01-01T00:15:00.000Z",
      }),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );

    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(201);
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("reclaims a legacy publish lock that has no expiresAt", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "locks/@ventora/analytics/publish.json",
      JSON.stringify({
        name: "@ventora/analytics",
        owner: "legacy-worker",
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );

    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(201);
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("reclaims malformed publish lock bodies", async () => {
    const bucket = new MemoryBucket();
    await bucket.put("locks/@ventora/analytics/publish.json", JSON.stringify("broken"));

    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(201);
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("reclaims incomplete publish lock objects", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "locks/@ventora/analytics/publish.json",
      JSON.stringify({ name: "@ventora/analytics" }),
    );

    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(201);
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(false);
  });

  it("returns 409 when a fresh publish lock already exists", async () => {
    const bucket = new MemoryBucket();
    const now = Date.now();
    await bucket.put(
      "locks/@ventora/analytics/publish.json",
      JSON.stringify({
        name: "@ventora/analytics",
        owner: "active-worker",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );

    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Package publish already in progress",
    });
    expect(bucket.values.has("locks/@ventora/analytics/publish.json")).toBe(true);
  });

  it("does not release a publish lock now owned by another worker", async () => {
    const bucket = new HijackingPackumentWriteBucket();
    const response = await publish(env({ REGISTRY_BUCKET: bucket }));

    expect(response.status).toBe(201);
    const lock = await bucket.values.get("locks/@ventora/analytics/publish.json")?.json();
    expect(lock).toMatchObject({ owner: "other-worker" });
  });

  it("streams tarball downloads when the R2 object has a body stream", async () => {
    const bucket = new MemoryBucket();
    const testEnv = env({ REGISTRY_BUCKET: bucket });
    await publish(testEnv);
    const key = "tarballs/@ventora/analytics/0.1.0/ventora-analytics-0.1.0.tgz";
    const stored = bucket.values.get(key);
    expect(stored).toBeTruthy();
    if (stored) {
      bucket.values.set(key, new MemoryObject(await stored.arrayBuffer(), undefined, true));
    }

    const response = await worker.fetch(
      request("/@ventora/analytics/-/ventora-analytics-0.1.0.tgz", { headers: auth() }),
      testEnv,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(validTarballBase64);
  });

  it("returns a server error if stored metadata is corrupt", async () => {
    const bucket = new MemoryBucket();
    await bucket.put(
      "metadata/@ventora/analytics/packument.json",
      JSON.stringify({ name: "@ventora/analytics" }),
    );

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      env({ REGISTRY_BUCKET: bucket }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid metadata for @ventora/analytics",
    });
  });

  it("returns a server error if stored metadata is not an object", async () => {
    const bucket = new MemoryBucket();
    await bucket.put("metadata/@ventora/analytics/packument.json", JSON.stringify("broken"));

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      env({ REGISTRY_BUCKET: bucket }),
    );

    expect(response.status).toBe(500);
  });

  it("returns a generic server error for non-Error failures", async () => {
    const bucket: BucketBinding = {
      async get(): Promise<null> {
        throw "broken";
      },
      async put(): Promise<null> {
        return null;
      },
      async delete(): Promise<void> {},
    };

    const response = await worker.fetch(
      request("/@ventora%2Fanalytics", { headers: auth() }),
      env({ REGISTRY_BUCKET: bucket }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal error" });
  });

  it("returns not found for unsupported routes", async () => {
    const response = await worker.fetch(request("/-/unknown", { method: "POST" }), env());

    expect(response.status).toBe(404);
  });
});

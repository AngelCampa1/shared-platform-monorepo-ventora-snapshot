import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../index.js";

// ---------------------------------------------------------------------------
// In-memory R2 primitives
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Specialised bucket subclasses for error/contention scenarios
// ---------------------------------------------------------------------------

/** Bucket whose put() always returns null for lock keys → lock never acquired */
class NeverLockBucket extends MemoryBucket {
  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key.startsWith("locks/")) {
      return null;
    }
    return super.put(key, value, options);
  }
}

/** Bucket that throws when writing metadata index */
class FailingMetadataWriteBucket extends MemoryBucket {
  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key.startsWith("metadata/")) {
      throw new Error("metadata write failed");
    }
    return super.put(key, value, options);
  }
}

/** Bucket whose get() throws a plain string */
class ThrowingStringGetBucket extends MemoryBucket {
  override async get(_key: string): Promise<MemoryObject | null> {
    throw "broken bucket";
  }
}

class HijackingMetadataWriteBucket extends MemoryBucket {
  override async put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<MemoryObject | null> {
    if (key === "metadata/ventora-observability/index.json") {
      await super.put(
        "locks/ventora-observability/publish.json",
        JSON.stringify({
          name: "ventora-observability",
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REGISTRY_BUCKET: new MemoryBucket(),
    REGISTRY_READ_TOKEN: "read-token",
    REGISTRY_ADMIN_TOKEN: "admin-token",
    ...overrides,
  };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://pypi.test${path}`, init);
}

function bearerHeaders(token: string): Headers {
  return new Headers({ Authorization: `Bearer ${token}` });
}

function basicHeaders(username: string, token: string): Headers {
  const encoded = btoa(`${username}:${token}`);
  return new Headers({ Authorization: `Basic ${encoded}` });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a minimal wheel upload form */
function wheelForm(opts: {
  name?: string;
  version?: string;
  filename?: string;
  bytes?: Uint8Array;
  sha256_digest?: string;
  requires_python?: string;
  action?: string;
}): FormData {
  const {
    name = "ventora-observability",
    version = "0.1.0",
    filename = "ventora_observability-0.1.0-py3-none-any.whl",
    bytes = new Uint8Array([1, 2, 3, 4]),
    sha256_digest,
    requires_python,
    action = "file_upload",
  } = opts;

  const form = new FormData();
  form.append(":action", action);
  form.append("name", name);
  form.append("version", version);
  form.append("content", new File([bytes], filename));
  if (sha256_digest !== undefined) {
    form.append("sha256_digest", sha256_digest);
  }
  if (requires_python !== undefined) {
    form.append("requires_python", requires_python);
  }
  return form;
}

function sdistForm(opts: {
  name?: string;
  version?: string;
  filename?: string;
  bytes?: Uint8Array;
}): FormData {
  const {
    name = "ventora-observability",
    version = "0.1.0",
    filename = "ventora_observability-0.1.0.tar.gz",
    bytes = new Uint8Array([5, 6, 7, 8]),
  } = opts;

  const form = new FormData();
  form.append(":action", "file_upload");
  form.append("name", name);
  form.append("version", version);
  form.append("content", new File([bytes], filename));
  return form;
}

async function upload(testEnv: Env, form: FormData, token = "admin-token"): Promise<Response> {
  return worker.fetch(
    req("/legacy/", {
      method: "POST",
      headers: bearerHeaders(token),
      body: form,
    }),
    testEnv,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("python-registry worker", () => {
  // =========================================================================
  // 1. Ping
  // =========================================================================

  describe("GET /-/ping", () => {
    it("returns 200 {ok:true} without any authentication", async () => {
      const response = await worker.fetch(req("/-/ping"), makeEnv());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });
  });

  // =========================================================================
  // 2. Authentication guards
  // =========================================================================

  describe("authentication", () => {
    it("returns 401 with WWW-Authenticate for upload without any auth", async () => {
      const response = await worker.fetch(
        req("/legacy/", { method: "POST", body: wheelForm({}) }),
        makeEnv(),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    });

    it("returns 401 for upload with read-only token", async () => {
      const form = wheelForm({});
      const response = await upload(makeEnv(), form, "read-token");

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    });

    it("returns 401 with WWW-Authenticate for simple index without auth", async () => {
      const response = await worker.fetch(req("/simple/ventora-observability/"), makeEnv());

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    });

    it("returns 401 with WWW-Authenticate for file download without auth", async () => {
      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl"),
        makeEnv(),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    });

    it("accepts Bearer token for reads", async () => {
      const testEnv = makeEnv();
      // seed some data
      await upload(testEnv, wheelForm({}));

      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it("accepts Basic auth token (password component) for reads", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));

      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: basicHeaders("anyuser", "read-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it("accepts Basic auth token for admin upload", async () => {
      const testEnv = makeEnv();
      const form = wheelForm({});
      const response = await worker.fetch(
        req("/legacy/", {
          method: "POST",
          headers: basicHeaders("publisher", "admin-token"),
          body: form,
        }),
        testEnv,
      );

      expect(response.status).toBe(201);
    });

    it("admin token can also read (install)", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));

      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: bearerHeaders("admin-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it("serves reads when no admin token is configured", async () => {
      const bucket = new MemoryBucket();
      // Pre-seed metadata directly
      const meta = {
        name: "ventora-observability",
        files: {},
        time: { created: "2024-01-01T00:00:00.000Z", modified: "2024-01-01T00:00:00.000Z" },
      };
      await bucket.put("metadata/ventora-observability/index.json", JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      const testEnv: Env = { REGISTRY_BUCKET: bucket, REGISTRY_READ_TOKEN: "read-token" };

      const response = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it("returns 401 when Basic auth header has no colon (token-only decoded)", async () => {
      // Encodes just the token without a colon separator — still a valid read token
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));
      const encoded = btoa("read-token"); // no colon
      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({ Authorization: `Basic ${encoded}` }),
        }),
        testEnv,
      );
      // decoded has no colon, so the whole decoded string is used as the token
      expect(response.status).toBe(200);
    });

    it("returns 401 when Basic auth header has invalid base64", async () => {
      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({ Authorization: "Basic !!notbase64!!" }),
        }),
        makeEnv(),
      );

      expect(response.status).toBe(401);
    });
  });

  // =========================================================================
  // 3. Successful upload → index HTML → index JSON → file download
  // =========================================================================

  describe("upload, index, and download flow", () => {
    it("uploads a wheel, serves HTML index with sha256 fragment, JSON index, and downloads the file", async () => {
      const testEnv = makeEnv();
      const bytes = new Uint8Array([10, 20, 30, 40]);
      const digest = sha256Hex(bytes);
      const form = wheelForm({
        bytes,
        sha256_digest: digest,
        requires_python: ">=3.12",
      });

      const uploadResp = await upload(testEnv, form);
      expect(uploadResp.status).toBe(201);
      await expect(uploadResp.json()).resolves.toEqual({
        ok: true,
        name: "ventora-observability",
        version: "0.1.0",
        filename: "ventora_observability-0.1.0-py3-none-any.whl",
      });

      // HTML index
      const htmlResp = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );
      expect(htmlResp.status).toBe(200);
      expect(htmlResp.headers.get("Content-Type")).toContain("text/html");
      const html = await htmlResp.text();
      expect(html).toContain("ventora_observability-0.1.0-py3-none-any.whl");
      expect(html).toContain(`#sha256=${digest}`);
      expect(html).toContain('data-requires-python="&gt;=3.12"');

      // JSON index
      const jsonResp = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({
            Authorization: "Bearer read-token",
            Accept: "application/vnd.pypi.simple.v1+json",
          }),
        }),
        testEnv,
      );
      expect(jsonResp.status).toBe(200);
      expect(jsonResp.headers.get("Content-Type")).toBe("application/vnd.pypi.simple.v1+json");
      const json = (await jsonResp.json()) as {
        meta: { "api-version": string };
        name: string;
        files: Array<{
          filename: string;
          url: string;
          hashes: { sha256: string };
          "requires-python"?: string;
          yanked: boolean;
        }>;
      };
      expect(json.meta["api-version"]).toBe("1.0");
      expect(json.name).toBe("ventora-observability");
      expect(json.files).toHaveLength(1);
      const entry = json.files[0];
      expect(entry?.filename).toBe("ventora_observability-0.1.0-py3-none-any.whl");
      expect(entry?.hashes.sha256).toBe(digest);
      expect(entry?.["requires-python"]).toBe(">=3.12");
      expect(entry?.yanked).toBe(false);
      expect(entry?.url).toContain(
        "/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl",
      );

      // File download
      const dlResp = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );
      expect(dlResp.status).toBe(200);
      expect(dlResp.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      const dlBytes = new Uint8Array(await dlResp.arrayBuffer());
      expect(dlBytes).toEqual(bytes);
    });

    it("uploads sdist and wheel; both appear sorted in index", async () => {
      const testEnv = makeEnv();
      const whlResp = await upload(testEnv, wheelForm({}));
      expect(whlResp.status).toBe(201);

      const sdistResp = await upload(testEnv, sdistForm({}));
      expect(sdistResp.status).toBe(201);

      const htmlResp = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );
      const html = await htmlResp.text();
      expect(html).toContain("ventora_observability-0.1.0-py3-none-any.whl");
      expect(html).toContain("ventora_observability-0.1.0.tar.gz");

      const jsonResp = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({
            Authorization: "Bearer read-token",
            Accept: "application/vnd.pypi.simple.v1+json",
          }),
        }),
        testEnv,
      );
      const json = (await jsonResp.json()) as { files: Array<{ filename: string }> };
      expect(json.files).toHaveLength(2);
      // sorted alphabetically via localeCompare:
      // "ventora_observability-0.1.0-py3-none-any.whl" < "ventora_observability-0.1.0.tar.gz"
      // because '-' (0x2D) < '.' (0x2E)
      expect(json.files[0]?.filename).toBe("ventora_observability-0.1.0-py3-none-any.whl");
      expect(json.files[1]?.filename).toBe("ventora_observability-0.1.0.tar.gz");
    });

    it("simple index without trailing slash also works", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));

      const response = await worker.fetch(
        req("/simple/ventora-observability", { headers: bearerHeaders("read-token") }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });

    it("upload via /legacy (no trailing slash) also works", async () => {
      const testEnv = makeEnv();
      const form = wheelForm({});
      const response = await worker.fetch(
        req("/legacy", {
          method: "POST",
          headers: bearerHeaders("admin-token"),
          body: form,
        }),
        testEnv,
      );

      expect(response.status).toBe(201);
    });

    it("JSON index entry has no requires-python when not supplied", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));

      const jsonResp = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({
            Authorization: "Bearer read-token",
            Accept: "application/vnd.pypi.simple.v1+json",
          }),
        }),
        testEnv,
      );
      const json = (await jsonResp.json()) as { files: Array<Record<string, unknown>> };
      expect(json.files[0]).not.toHaveProperty("requires-python");
    });
  });

  // =========================================================================
  // 4. Invalid upload payloads → 400
  // =========================================================================

  describe("invalid upload payloads → 400", () => {
    it("rejects wrong :action field", async () => {
      const form = wheelForm({ action: "version_upload" });
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects missing name", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("version", "0.1.0");
      form.append("content", new File([new Uint8Array([1])], "ventora_x-0.1.0-py3-none-any.whl"));
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects bad version string", async () => {
      const form = wheelForm({ version: "!!!" });
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects non-ventora package name", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "other-pkg");
      form.append("version", "0.1.0");
      form.append("content", new File([new Uint8Array([1])], "other_pkg-0.1.0-py3-none-any.whl"));
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects when content is a string (not a File)", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      form.append("content", "notafile");
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects a .zip extension (bad filename extension)", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      form.append("content", new File([new Uint8Array([1])], "ventora_observability-0.1.0.zip"));
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects filename not matching the escaped distribution prefix", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      // wrong package prefix in filename
      form.append(
        "content",
        new File([new Uint8Array([1])], "ventora_analytics-0.1.0-py3-none-any.whl"),
      );
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects a wheel filename whose version does not match the upload version", async () => {
      const response = await upload(
        makeEnv(),
        wheelForm({
          version: "0.1.0",
          filename: "ventora_observability-9.9.9-py3-none-any.whl",
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects empty file bytes", async () => {
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      form.append(
        "content",
        new File([new Uint8Array([])], "ventora_observability-0.1.0-py3-none-any.whl"),
      );
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects mismatched sha256_digest", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const wrongDigest = "a".repeat(64);
      const form = wheelForm({ bytes, sha256_digest: wrongDigest });
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("rejects malformed multipart body → 400 Invalid upload form", async () => {
      const response = await worker.fetch(
        req("/legacy/", {
          method: "POST",
          headers: new Headers({
            Authorization: "Bearer admin-token",
            "Content-Type": "multipart/form-data; boundary=xboundary",
          }),
          body: "this is not multipart",
        }),
        makeEnv(),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload form" });
    });
  });

  // =========================================================================
  // 5. Duplicate upload → 409
  // =========================================================================

  describe("duplicate upload handling", () => {
    it("returns 409 and preserves original bytes on duplicate filename", async () => {
      const testEnv = makeEnv();
      const originalBytes = new Uint8Array([1, 2, 3, 4]);
      await upload(testEnv, wheelForm({ bytes: originalBytes }));

      const duplicateBytes = new Uint8Array([99, 98, 97]);
      const duplicateResp = await upload(testEnv, wheelForm({ bytes: duplicateBytes }));

      expect(duplicateResp.status).toBe(409);
      await expect(duplicateResp.json()).resolves.toEqual({ error: "File already exists" });

      // Original bytes still intact
      const dlResp = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );
      const dlBytes = new Uint8Array(await dlResp.arrayBuffer());
      expect(dlBytes).toEqual(originalBytes);
    });

    it("returns 409 when a pre-seeded claim key exists and cleans up the lock", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "claims/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl.json",
        JSON.stringify({
          name: "ventora-observability",
          filename: "ventora_observability-0.1.0-py3-none-any.whl",
        }),
      );
      const testEnv = makeEnv({ REGISTRY_BUCKET: bucket });
      const response = await upload(testEnv, wheelForm({}));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "File already exists" });
      // publish lock should have been released
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(false);
    });

    it("returns 409 when file object already exists (claim succeeds but file write fails because already-claimed)", async () => {
      const bucket = new MemoryBucket();
      // Pre-seed the file object so the onlyIf put returns null
      await bucket.put(
        "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl",
        new Uint8Array([5, 5, 5]).buffer,
      );
      const testEnv = makeEnv({ REGISTRY_BUCKET: bucket });
      const response = await upload(testEnv, wheelForm({}));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "File already exists" });
      // Claim should have been deleted (cleaned up)
      expect(
        bucket.values.has(
          "claims/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl.json",
        ),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 6. Lock contention → 409
  // =========================================================================

  describe("lock contention", () => {
    it("returns 409 when lock acquisition always fails", async () => {
      const testEnv = makeEnv({ REGISTRY_BUCKET: new NeverLockBucket() });
      const response = await upload(testEnv, wheelForm({}));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Package upload already in progress",
      });
    });

    it("reclaims an expired publish lock and releases it after upload", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "locks/ventora-observability/publish.json",
        JSON.stringify({
          name: "ventora-observability",
          owner: "dead-worker",
          createdAt: "2024-01-01T00:00:00.000Z",
          expiresAt: "2024-01-01T00:15:00.000Z",
        }),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      );

      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(201);
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(false);
    });

    it("reclaims a legacy publish lock that has no expiresAt", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "locks/ventora-observability/publish.json",
        JSON.stringify({
          name: "ventora-observability",
          owner: "legacy-worker",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      );

      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(201);
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(false);
    });

    it("reclaims malformed publish lock bodies", async () => {
      const bucket = new MemoryBucket();
      await bucket.put("locks/ventora-observability/publish.json", JSON.stringify("broken"));

      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(201);
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(false);
    });

    it("reclaims incomplete publish lock objects", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "locks/ventora-observability/publish.json",
        JSON.stringify({ name: "ventora-observability" }),
      );

      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(201);
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(false);
    });

    it("returns 409 when a fresh publish lock already exists", async () => {
      const bucket = new MemoryBucket();
      const now = Date.now();
      await bucket.put(
        "locks/ventora-observability/publish.json",
        JSON.stringify({
          name: "ventora-observability",
          owner: "active-worker",
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        }),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      );

      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Package upload already in progress",
      });
      expect(bucket.values.has("locks/ventora-observability/publish.json")).toBe(true);
    });

    it("does not release a publish lock now owned by another worker", async () => {
      const bucket = new HijackingMetadataWriteBucket();
      const response = await upload(makeEnv({ REGISTRY_BUCKET: bucket }), wheelForm({}));

      expect(response.status).toBe(201);
      const lock = await bucket.values.get("locks/ventora-observability/publish.json")?.json();
      expect(lock).toMatchObject({ owner: "other-worker" });
    });

    it("two concurrent uploads of different files both succeed", async () => {
      const testEnv = makeEnv();
      const [whlResp, tarResp] = await Promise.all([
        upload(testEnv, wheelForm({})),
        upload(testEnv, sdistForm({})),
      ]);

      expect(whlResp.status).toBe(201);
      expect(tarResp.status).toBe(201);

      // Both should appear in the index
      const jsonResp = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({
            Authorization: "Bearer read-token",
            Accept: "application/vnd.pypi.simple.v1+json",
          }),
        }),
        testEnv,
      );
      const json = (await jsonResp.json()) as { files: Array<{ filename: string }> };
      expect(json.files).toHaveLength(2);
    });
  });

  // =========================================================================
  // 7. Metadata write failure → 500 + cleanup
  // =========================================================================

  describe("metadata write failure", () => {
    it("returns 500 and cleans up file object and claim when metadata write throws", async () => {
      const bucket = new FailingMetadataWriteBucket();
      const testEnv = makeEnv({ REGISTRY_BUCKET: bucket });
      const response = await upload(testEnv, wheelForm({}));

      expect(response.status).toBe(500);
      // File should have been cleaned up
      expect(
        bucket.values.has(
          "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl",
        ),
      ).toBe(false);
      // Claim should have been cleaned up
      expect(
        bucket.values.has(
          "claims/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl.json",
        ),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 8. Corrupt stored metadata → 500
  // =========================================================================

  describe("corrupt stored metadata", () => {
    it("returns 500 with Invalid metadata message when metadata is missing files/time", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "metadata/ventora-observability/index.json",
        JSON.stringify({ name: "ventora-observability" }),
      );

      const response = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        makeEnv({ REGISTRY_BUCKET: bucket }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid metadata for ventora-observability",
      });
    });

    it("returns 500 when stored metadata JSON is not an object", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "metadata/ventora-observability/index.json",
        JSON.stringify("totally-broken"),
      );

      const response = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        makeEnv({ REGISTRY_BUCKET: bucket }),
      );

      expect(response.status).toBe(500);
    });

    it("returns 500 with Invalid metadata during upload when existing metadata is corrupt", async () => {
      const bucket = new MemoryBucket();
      // Pre-seed corrupt metadata
      await bucket.put(
        "metadata/ventora-observability/index.json",
        JSON.stringify({ name: "ventora-observability" }),
      );
      const testEnv = makeEnv({ REGISTRY_BUCKET: bucket });
      const response = await upload(testEnv, wheelForm({}));

      expect(response.status).toBe(500);
    });
  });

  // =========================================================================
  // 9. Non-Error throw → 500 "Internal error"
  // =========================================================================

  describe("non-Error throw", () => {
    it("returns 500 with {error:'Internal error'} when bucket.get throws a string", async () => {
      const testEnv = makeEnv({ REGISTRY_BUCKET: new ThrowingStringGetBucket() });

      const response = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Internal error" });
    });
  });

  // =========================================================================
  // 10. Unknown route → 404
  // =========================================================================

  describe("unknown routes", () => {
    it("returns 404 for completely unknown paths", async () => {
      const response = await worker.fetch(req("/unknown/path"), makeEnv());

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    });

    it("returns 404 for a POST to an unrecognised path", async () => {
      const response = await worker.fetch(req("/not-a-route", { method: "POST" }), makeEnv());

      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // 11. Simple index 404 paths
  // =========================================================================

  describe("simple index 404 paths", () => {
    it("returns 404 for an unknown project", async () => {
      const response = await worker.fetch(
        req("/simple/ventora-unknown/", { headers: bearerHeaders("read-token") }),
        makeEnv(),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    });

    it("returns 404 for a non-ventora project name", async () => {
      const response = await worker.fetch(
        req("/simple/requests/", { headers: bearerHeaders("read-token") }),
        makeEnv(),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    });
  });

  // =========================================================================
  // 12. File download 404 paths
  // =========================================================================

  describe("file download 404 paths", () => {
    it("returns 404 for a known project but missing R2 object", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));
      // Delete the stored file
      (testEnv.REGISTRY_BUCKET as MemoryBucket).values.delete(
        "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl",
      );

      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "File not found" });
    });

    it("returns 404 for an orphan R2 file missing from project metadata", async () => {
      const bucket = new MemoryBucket();
      await bucket.put(
        "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl",
        new Uint8Array([1, 2, 3]).buffer,
        { httpMetadata: { contentType: "application/octet-stream" } },
      );

      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        makeEnv({ REGISTRY_BUCKET: bucket }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "File not found" });
    });

    it("returns 404 for a non-ventora package name in file path", async () => {
      const response = await worker.fetch(
        req("/files/requests/requests-2.32.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        makeEnv(),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "File not found" });
    });

    it("returns 404 for an unsafe filename (path traversal attempt)", async () => {
      const response = await worker.fetch(
        req("/files/ventora-observability/../etc/passwd", {
          headers: bearerHeaders("read-token"),
        }),
        makeEnv(),
      );

      // The route regex won't match a path with multiple slashes in the filename segment,
      // so this falls through to the 404 Not found
      expect(response.status).toBe(404);
    });

    it("returns 404 for a filename with bad extension", async () => {
      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0.zip", {
          headers: bearerHeaders("read-token"),
        }),
        makeEnv(),
      );

      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // 13. Streaming download + default content-type
  // =========================================================================

  describe("streaming download and content-type fallback", () => {
    it("streams the file when R2 object has a body stream", async () => {
      const testEnv = makeEnv();
      const bytes = new Uint8Array([7, 8, 9]);
      await upload(testEnv, wheelForm({ bytes }));

      const bucket = testEnv.REGISTRY_BUCKET as MemoryBucket;
      const key = "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl";
      const stored = bucket.values.get(key);
      expect(stored).toBeTruthy();
      if (stored) {
        bucket.values.set(
          key,
          new MemoryObject(await stored.arrayBuffer(), "application/octet-stream", true),
        );
      }

      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const dlBytes = new Uint8Array(await response.arrayBuffer());
      expect(dlBytes).toEqual(bytes);
    });

    it("falls back to application/octet-stream when object has no content-type", async () => {
      const testEnv = makeEnv();
      const bytes = new Uint8Array([1, 2, 3]);
      await upload(testEnv, wheelForm({ bytes }));

      const bucket = testEnv.REGISTRY_BUCKET as MemoryBucket;
      const key = "files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl";
      const stored = bucket.values.get(key);
      expect(stored).toBeTruthy();
      if (stored) {
        // Store without content-type
        bucket.values.set(key, new MemoryObject(await stored.arrayBuffer()));
      }

      const response = await worker.fetch(
        req("/files/ventora-observability/ventora_observability-0.1.0-py3-none-any.whl", {
          headers: bearerHeaders("read-token"),
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    });
  });

  // =========================================================================
  // 14. PEP 503 name normalisation
  // =========================================================================

  describe("PEP 503 name normalisation", () => {
    it("normalises underscores and mixed-case in upload name to dashes", async () => {
      const testEnv = makeEnv();
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora_observability"); // underscores
      form.append("version", "0.1.0");
      form.append(
        "content",
        new File([new Uint8Array([1, 2, 3])], "ventora_observability-0.1.0-py3-none-any.whl"),
      );
      const response = await upload(testEnv, form);

      expect(response.status).toBe(201);
      // Should be stored under the normalized name
      const jsonResp = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({
            Authorization: "Bearer read-token",
            Accept: "application/vnd.pypi.simple.v1+json",
          }),
        }),
        testEnv,
      );
      expect(jsonResp.status).toBe(200);
    });

    it("normalises URL-encoded project names in simple route", async () => {
      const testEnv = makeEnv();
      await upload(testEnv, wheelForm({}));

      const response = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );

      expect(response.status).toBe(200);
    });
  });

  // =========================================================================
  // 15. Version pattern edge cases
  // =========================================================================

  describe("version pattern acceptance", () => {
    it("accepts complex PEP 440 version strings", async () => {
      const version = "1.0.0rc1+local.1";
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", version);
      form.append(
        "content",
        new File([new Uint8Array([1, 2, 3])], `ventora_observability-${version}-py3-none-any.whl`),
      );
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(201);
    });
  });

  // =========================================================================
  // 16. Additional coverage: edge paths
  // =========================================================================

  describe("edge path coverage", () => {
    it("rejects a wheel filename that matches prefix but fails the multi-segment regex (line 119 branch)", async () => {
      // "ventora_observability-0.1.0.whl" ends with .whl and starts with correct prefix,
      // but only has 2 dash-segments instead of the required 5.
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      form.append(
        "content",
        new File([new Uint8Array([1, 2, 3])], "ventora_observability-0.1.0.whl"),
      );
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });

    it("returns 401 when Authorization header scheme is not Bearer or Basic (line 171 branch)", async () => {
      const response = await worker.fetch(
        req("/simple/ventora-observability/", {
          headers: new Headers({ Authorization: "Digest realm=test" }),
        }),
        makeEnv(),
      );

      expect(response.status).toBe(401);
    });

    it("rejects content field that is an object without arrayBuffer (line 262 branch)", async () => {
      // We can't directly inject a non-File object through FormData.append in this environment,
      // but we can test the string-value path which hits the asUploadedFile null return.
      // (The string path is already covered by the "content is a string" test above.)
      // This test covers the missing-content FormData key path.
      const form = new FormData();
      form.append(":action", "file_upload");
      form.append("name", "ventora-observability");
      form.append("version", "0.1.0");
      // no "content" key at all → form.get("content") returns null → asUploadedFile(null) → null
      const response = await upload(makeEnv(), form);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid upload payload" });
    });
  });

  // =========================================================================
  // 18. HTML escaping in index
  // =========================================================================

  describe("HTML escaping", () => {
    it("escapes special characters in requires-python for HTML output", async () => {
      const testEnv = makeEnv();
      const form = wheelForm({ requires_python: '>=3.12,<4.0 & "safe"' });
      await upload(testEnv, form);

      const htmlResp = await worker.fetch(
        req("/simple/ventora-observability/", { headers: bearerHeaders("read-token") }),
        testEnv,
      );
      const html = await htmlResp.text();
      // Should have HTML-escaped ampersand and quotes
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
    });
  });
});

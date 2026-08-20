type RegistryObject = {
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
};

type RegistryBucket = {
  get(key: string): Promise<RegistryObject | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<RegistryObject | null | undefined>;
  delete(key: string): Promise<void>;
};

export type Env = {
  REGISTRY_BUCKET: RegistryBucket;
  REGISTRY_READ_TOKEN?: string;
  REGISTRY_ADMIN_TOKEN?: string;
};

type IndexFile = {
  filename: string;
  sha256: string;
  size: number;
  requiresPython?: string;
  uploadedAt: string;
};

type ProjectIndex = {
  name: string;
  files: Record<string, IndexFile>;
  time: { created: string; modified: string };
};

type UploadPayload = {
  name: string;
  version: string;
  filename: string;
  bytes: ArrayBuffer;
  sha256: string;
  requiresPython?: string;
};

type PublishLock = {
  name: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
};

// PEP 503 normalized project names for this private index are always `ventora-*`.
const PROJECT_NAME_PATTERN = /^ventora-[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Permissive PEP 440 surface: digits, separators, and local/dev/pre tags.
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.!+_-]*$/;
const JSON_CONTENT_TYPE = "application/vnd.pypi.simple.v1+json";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const PUBLISH_LOCK_TTL_MS = 15 * 60 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  // Prompt CLI tooling (uv/pip) to supply Basic credentials.
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="ventora-python-registry"',
    },
  });
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function escapedDistribution(normalizedName: string): string {
  return normalizedName.replace(/-/g, "_");
}

function metadataKey(name: string): string {
  return `metadata/${name}/index.json`;
}

function fileKey(name: string, filename: string): string {
  return `files/${name}/${filename}`;
}

function fileClaimKey(name: string, filename: string): string {
  return `claims/${name}/${filename}.json`;
}

function publishLockKey(name: string): string {
  return `locks/${name}/publish.json`;
}

function isSafeFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.includes("..")
  );
}

function classifyFilename(escaped: string, filename: string): "wheel" | "sdist" | null {
  if (!isSafeFilename(filename) || !filename.startsWith(`${escaped}-`)) {
    return null;
  }
  if (filename.endsWith(".whl")) {
    // {dist}-{version}(-{build})?-{python}-{abi}-{platform}.whl
    return /^[A-Za-z0-9_.]+-[^-]+(?:-[^-]+)?-[^-]+-[^-]+-[^-]+\.whl$/.test(filename)
      ? "wheel"
      : null;
  }
  if (filename.endsWith(".tar.gz")) {
    return /^[A-Za-z0-9_.]+-[^-]+\.tar\.gz$/.test(filename) ? "sdist" : null;
  }
  return null;
}

function filenameVersion(escaped: string, filename: string): string | null {
  if (!filename.startsWith(`${escaped}-`)) {
    return null;
  }
  const remainder = filename.slice(escaped.length + 1);
  if (filename.endsWith(".whl")) {
    const separator = remainder.indexOf("-");
    return separator === -1 ? null : remainder.slice(0, separator);
  }
  if (filename.endsWith(".tar.gz")) {
    return remainder.slice(0, -".tar.gz".length);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function lockTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function readPublishLock(value: unknown): PublishLock | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = readString(value, "name");
  const owner = readString(value, "owner");
  const createdAt = readString(value, "createdAt");
  const expiresAt = readString(value, "expiresAt");
  if (!name || !owner || !createdAt) {
    return null;
  }
  return {
    name,
    owner,
    createdAt,
    expiresAt:
      expiresAt ?? new Date((lockTimestamp(createdAt) ?? 0) + PUBLISH_LOCK_TTL_MS).toISOString(),
  };
}

async function readExistingPublishLock(env: Env, key: string): Promise<PublishLock | null> {
  const object = await env.REGISTRY_BUCKET.get(key);
  if (!object) {
    return null;
  }
  return readPublishLock(await object.json());
}

function isExpiredPublishLock(lock: PublishLock | null, now: number): boolean {
  if (!lock) {
    return true;
  }
  return (lockTimestamp(lock.expiresAt) ?? 0) <= now;
}

function isProjectIndex(value: unknown, name: string): value is ProjectIndex {
  if (!isRecord(value)) {
    return false;
  }
  return value.name === name && isRecord(value.files) && isRecord(value.time);
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function presentedToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return null;
  }
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  if (authorization.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(authorization.slice("Basic ".length));
    } catch {
      return null;
    }
    const separator = decoded.indexOf(":");
    // uv/pip send `<username>:<token>`; the token is the password component.
    return separator === -1 ? decoded : decoded.slice(separator + 1);
  }
  return null;
}

function canRead(request: Request, env: Env): boolean {
  const token = presentedToken(request);
  if (!token) {
    return false;
  }
  return (
    (env.REGISTRY_READ_TOKEN ? timingSafeEqual(token, env.REGISTRY_READ_TOKEN) : false) ||
    (env.REGISTRY_ADMIN_TOKEN ? timingSafeEqual(token, env.REGISTRY_ADMIN_TOKEN) : false)
  );
}

function canAdmin(request: Request, env: Env): boolean {
  const token = presentedToken(request);
  return Boolean(
    token && env.REGISTRY_ADMIN_TOKEN && timingSafeEqual(token, env.REGISTRY_ADMIN_TOKEN),
  );
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readProjectIndex(env: Env, name: string): Promise<ProjectIndex | null> {
  const object = await env.REGISTRY_BUCKET.get(metadataKey(name));
  if (!object) {
    return null;
  }
  const existing = await object.json();
  if (!isProjectIndex(existing, name)) {
    throw new Error(`Invalid metadata for ${name}`);
  }
  return existing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePublishLock(env: Env, name: string): Promise<string | null> {
  const key = publishLockKey(name);
  const owner = crypto.randomUUID();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + PUBLISH_LOCK_TTL_MS).toISOString();
    const lock = await env.REGISTRY_BUCKET.put(
      key,
      JSON.stringify({ name, owner, createdAt, expiresAt }),
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { package: name, owner },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (lock !== null) {
      return owner;
    }
    if (isExpiredPublishLock(await readExistingPublishLock(env, key), now)) {
      await env.REGISTRY_BUCKET.delete(key);
      continue;
    }
    await sleep(20);
  }
  return null;
}

async function releasePublishLock(env: Env, name: string, owner: string): Promise<void> {
  const key = publishLockKey(name);
  const lock = await readExistingPublishLock(env, key);
  if (lock?.owner === owner) {
    await env.REGISTRY_BUCKET.delete(key);
  }
}

function fileUrl(request: Request, name: string, filename: string): string {
  const url = new URL(request.url);
  url.pathname = `/files/${name}/${filename}`;
  url.search = "";
  return url.toString();
}

type UploadedFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> };

function formString(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" ? value : null;
}

function asUploadedFile(value: unknown): UploadedFile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.arrayBuffer === "function" && typeof candidate.name === "string") {
    return value as UploadedFile;
  }
  return null;
}

async function parseUploadPayload(form: FormData): Promise<UploadPayload | null> {
  if (formString(form, ":action") !== "file_upload") {
    return null;
  }
  const rawName = formString(form, "name");
  const version = formString(form, "version");
  const content = asUploadedFile(form.get("content"));
  if (!rawName || !version || !VERSION_PATTERN.test(version) || !content) {
    return null;
  }

  const name = normalizeName(rawName);
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return null;
  }

  const filename = content.name;
  const escaped = escapedDistribution(name);
  if (!classifyFilename(escaped, filename) || filenameVersion(escaped, filename) !== version) {
    return null;
  }

  const bytes = await content.arrayBuffer();
  if (bytes.byteLength === 0) {
    return null;
  }
  const sha256 = await sha256Hex(bytes);

  const declaredDigest = formString(form, "sha256_digest");
  if (declaredDigest && !timingSafeEqual(sha256, declaredDigest.toLowerCase())) {
    return null;
  }

  const requiresPython = formString(form, "requires_python");
  const payload: UploadPayload = { name, version, filename, bytes, sha256 };
  if (requiresPython) {
    payload.requiresPython = requiresPython;
  }
  return payload;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!canAdmin(request, env)) {
    return unauthorized();
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid upload form" }, 400);
  }

  const payload = await parseUploadPayload(form);
  if (!payload) {
    return jsonResponse({ error: "Invalid upload payload" }, 400);
  }

  const lockOwner = await acquirePublishLock(env, payload.name);
  if (!lockOwner) {
    return jsonResponse({ error: "Package upload already in progress" }, 409);
  }

  const claimKey = fileClaimKey(payload.name, payload.filename);
  const objectKey = fileKey(payload.name, payload.filename);
  let wroteFile = false;
  try {
    const existing = await readProjectIndex(env, payload.name);
    if (existing?.files[payload.filename]) {
      return jsonResponse({ error: "File already exists" }, 409);
    }

    const claim = await env.REGISTRY_BUCKET.put(
      claimKey,
      JSON.stringify({ name: payload.name, filename: payload.filename }),
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { package: payload.name, filename: payload.filename },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (claim === null) {
      return jsonResponse({ error: "File already exists" }, 409);
    }

    const fileWrite = await env.REGISTRY_BUCKET.put(objectKey, payload.bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        sha256: payload.sha256,
        package: payload.name,
        version: payload.version,
      },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (fileWrite === null) {
      await env.REGISTRY_BUCKET.delete(claimKey);
      return jsonResponse({ error: "File already exists" }, 409);
    }
    wroteFile = true;

    const now = new Date().toISOString();
    const index: ProjectIndex = existing ?? {
      name: payload.name,
      files: {},
      time: { created: now, modified: now },
    };
    const record: IndexFile = {
      filename: payload.filename,
      sha256: payload.sha256,
      size: payload.bytes.byteLength,
      uploadedAt: now,
    };
    if (payload.requiresPython) {
      record.requiresPython = payload.requiresPython;
    }
    index.files[payload.filename] = record;
    index.time.modified = now;

    await env.REGISTRY_BUCKET.put(metadataKey(payload.name), JSON.stringify(index), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    if (wroteFile) {
      await env.REGISTRY_BUCKET.delete(objectKey);
    }
    await env.REGISTRY_BUCKET.delete(claimKey);
    throw error;
  } finally {
    await releasePublishLock(env, payload.name, lockOwner);
  }

  return jsonResponse(
    { ok: true, name: payload.name, version: payload.version, filename: payload.filename },
    201,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sortedFiles(index: ProjectIndex): IndexFile[] {
  return Object.values(index.files).sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
}

function simpleJson(request: Request, index: ProjectIndex): Response {
  const files = sortedFiles(index).map((file) => {
    const entry: {
      filename: string;
      url: string;
      hashes: { sha256: string };
      "requires-python"?: string;
      yanked: false;
    } = {
      filename: file.filename,
      url: fileUrl(request, index.name, file.filename),
      hashes: { sha256: file.sha256 },
      yanked: false,
    };
    if (file.requiresPython) {
      entry["requires-python"] = file.requiresPython;
    }
    return entry;
  });

  return new Response(JSON.stringify({ meta: { "api-version": "1.0" }, name: index.name, files }), {
    status: 200,
    headers: { "Content-Type": JSON_CONTENT_TYPE },
  });
}

function simpleHtml(request: Request, index: ProjectIndex): Response {
  const links = sortedFiles(index)
    .map((file) => {
      const href = `${fileUrl(request, index.name, file.filename)}#sha256=${file.sha256}`;
      const requires = file.requiresPython
        ? ` data-requires-python="${escapeHtml(file.requiresPython)}"`
        : "";
      return `    <a href="${escapeHtml(href)}"${requires}>${escapeHtml(file.filename)}</a><br/>`;
    })
    .join("\n");

  const body = `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="1.0">
    <title>Links for ${escapeHtml(index.name)}</title>
  </head>
  <body>
    <h1>Links for ${escapeHtml(index.name)}</h1>
${links}
  </body>
</html>
`;

  return new Response(body, { status: 200, headers: { "Content-Type": HTML_CONTENT_TYPE } });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("application/vnd.pypi.simple.v1+json");
}

async function handleSimple(request: Request, env: Env, rawName: string): Promise<Response> {
  if (!canRead(request, env)) {
    return unauthorized();
  }
  const name = normalizeName(decodeURIComponent(rawName));
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return jsonResponse({ error: "Project not found" }, 404);
  }
  const index = await readProjectIndex(env, name);
  if (!index) {
    return jsonResponse({ error: "Project not found" }, 404);
  }
  return wantsJson(request) ? simpleJson(request, index) : simpleHtml(request, index);
}

async function handleFile(
  request: Request,
  env: Env,
  rawName: string,
  rawFilename: string,
): Promise<Response> {
  if (!canRead(request, env)) {
    return unauthorized();
  }
  const name = normalizeName(decodeURIComponent(rawName));
  const filename = decodeURIComponent(rawFilename);
  if (!PROJECT_NAME_PATTERN.test(name) || !classifyFilename(escapedDistribution(name), filename)) {
    return jsonResponse({ error: "File not found" }, 404);
  }

  const index = await readProjectIndex(env, name);
  if (!index?.files[filename]) {
    return jsonResponse({ error: "File not found" }, 404);
  }

  const object = await env.REGISTRY_BUCKET.get(fileKey(name, filename));
  if (!object) {
    return jsonResponse({ error: "File not found" }, 404);
  }

  const headers = new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
  });
  object.writeHttpMetadata(headers);
  return new Response(object.body ?? (await object.arrayBuffer()), { status: 200, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/-/ping") {
    return jsonResponse({ ok: true }, 200);
  }

  if (request.method === "POST" && (url.pathname === "/legacy/" || url.pathname === "/legacy")) {
    return handleUpload(request, env);
  }

  const simpleMatch = /^\/simple\/([^/]+)\/?$/.exec(url.pathname);
  if (request.method === "GET" && simpleMatch?.[1]) {
    return handleSimple(request, env, simpleMatch[1]);
  }

  const fileMatch = /^\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && fileMatch?.[1] && fileMatch[2]) {
    return handleFile(request, env, fileMatch[1], fileMatch[2]);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      return jsonResponse({ error: message }, 500);
    }
  },
};

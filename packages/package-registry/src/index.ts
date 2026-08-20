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

type PackageJson = {
  name: string;
  version: string;
  [key: string]: unknown;
};

type PackageVersion = PackageJson & {
  dist: {
    tarball: string;
    integrity: string;
    shasum: string;
  };
};

type Packument = {
  _id: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageVersion>;
  time: Record<string, string>;
};

type PublishPayload = {
  name: string;
  version: string;
  tag: string;
  packageJson: PackageJson;
  tarballName: string;
  tarballBase64: string;
  integrity: string;
  shasum: string;
};

type PublishLock = {
  name: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
};

const PACKAGE_NAME_PATTERN = /^@ventora\/[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SHASUM_PATTERN = /^[a-f0-9]{40}$/;
const TARBALL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.tgz$/;
const PUBLISH_LOCK_TTL_MS = 15 * 60 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, 401);
}

function packumentKey(name: string): string {
  return `metadata/${name}/packument.json`;
}

function tarballKey(name: string, version: string, tarballName: string): string {
  return `tarballs/${name}/${version}/${tarballName}`;
}

function versionClaimKey(name: string, version: string): string {
  return `claims/${name}/${version}.json`;
}

function packagePublishLockKey(name: string): string {
  return `locks/${name}/publish.json`;
}

function expectedTarballName(name: string, version: string): string {
  return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

function parsePackagePath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const withoutSlash = decoded.slice(1);
  if (!PACKAGE_NAME_PATTERN.test(withoutSlash)) {
    return null;
  }
  return withoutSlash;
}

function parseTarballPath(pathname: string): { name: string; tarballName: string } | null {
  const decoded = decodeURIComponent(pathname);
  const match = /^\/(@ventora\/[a-z0-9][a-z0-9-]*)\/-\/([^/]+\.tgz)$/.exec(decoded);
  if (!match) {
    return null;
  }
  const [, name, tarballName] = match;
  return { name: name as string, tarballName: tarballName as string };
}

function tarballUrl(request: Request, name: string, tarballName: string): string {
  const url = new URL(request.url);
  url.pathname = `/${name}/-/${tarballName}`;
  url.search = "";
  return url.toString();
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

function validatePackageJson(value: unknown, name: string, version: string): PackageJson | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.name !== name || value.version !== version) {
    return null;
  }
  return { ...value, name, version };
}

function validatePublishPayload(value: unknown): PublishPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = readString(value, "name");
  const version = readString(value, "version");
  const tag = readString(value, "tag");
  const tarballName = readString(value, "tarballName");
  const tarballBase64 = readString(value, "tarballBase64");
  const integrity = readString(value, "integrity");
  const shasum = readString(value, "shasum");

  if (
    !name ||
    !version ||
    !tag ||
    !tarballName ||
    !tarballBase64 ||
    !integrity ||
    !shasum ||
    !PACKAGE_NAME_PATTERN.test(name) ||
    !VERSION_PATTERN.test(version) ||
    !TAG_PATTERN.test(tag) ||
    !TARBALL_NAME_PATTERN.test(tarballName) ||
    tarballName !== expectedTarballName(name, version) ||
    !integrity.startsWith("sha512-") ||
    !SHASUM_PATTERN.test(shasum)
  ) {
    return null;
  }

  const packageJson = validatePackageJson(value.packageJson, name, version);
  if (!packageJson) {
    return null;
  }

  return { name, version, tag, packageJson, tarballName, tarballBase64, integrity, shasum };
}

function isPackument(value: unknown, name: string): value is Packument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value._id === name &&
    value.name === name &&
    isRecord(value["dist-tags"]) &&
    isRecord(value.versions) &&
    isRecord(value.time)
  );
}

function decodeBase64(base64: string): ArrayBuffer | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function shaDigest(bytes: ArrayBuffer, algorithm: "SHA-1" | "SHA-512"): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

async function validateTarball(
  tarball: ArrayBuffer,
  integrity: string,
  shasum: string,
): Promise<boolean> {
  const bytes = new Uint8Array(tarball);
  if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) {
    return false;
  }

  const actualIntegrity = `sha512-${bytesToBase64(await shaDigest(tarball, "SHA-512"))}`;
  if (!timingSafeEqual(actualIntegrity, integrity)) {
    return false;
  }

  const actualShasum = bytesToHex(await shaDigest(tarball, "SHA-1"));
  return timingSafeEqual(actualShasum, shasum.toLowerCase());
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

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length);
}

function canRead(request: Request, env: Env): boolean {
  const token = bearerToken(request);
  if (!token) {
    return false;
  }
  return (
    (env.REGISTRY_READ_TOKEN ? timingSafeEqual(token, env.REGISTRY_READ_TOKEN) : false) ||
    (env.REGISTRY_ADMIN_TOKEN ? timingSafeEqual(token, env.REGISTRY_ADMIN_TOKEN) : false)
  );
}

function canAdmin(request: Request, env: Env): boolean {
  const token = bearerToken(request);
  return Boolean(
    token && env.REGISTRY_ADMIN_TOKEN && timingSafeEqual(token, env.REGISTRY_ADMIN_TOKEN),
  );
}

async function readPackument(env: Env, name: string): Promise<Packument | null> {
  const existingObject = await env.REGISTRY_BUCKET.get(packumentKey(name));
  if (!existingObject) {
    return null;
  }

  const existing = await existingObject.json();
  if (!existing) {
    return null;
  }
  if (!isPackument(existing, name)) {
    throw new Error(`Invalid metadata for ${name}`);
  }
  return existing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePackagePublishLock(env: Env, name: string): Promise<string | null> {
  const key = packagePublishLockKey(name);
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

async function releasePackagePublishLock(env: Env, name: string, owner: string): Promise<void> {
  const key = packagePublishLockKey(name);
  const lock = await readExistingPublishLock(env, key);
  if (lock?.owner === owner) {
    await env.REGISTRY_BUCKET.delete(key);
  }
}

async function handlePublish(request: Request, env: Env): Promise<Response> {
  if (!canAdmin(request, env)) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const payload = validatePublishPayload(body);
  if (!payload) {
    return jsonResponse({ error: "Invalid publish payload" }, 400);
  }

  const tarball = decodeBase64(payload.tarballBase64);
  if (!tarball) {
    return jsonResponse({ error: "Invalid tarball encoding" }, 400);
  }
  if (!(await validateTarball(tarball, payload.integrity, payload.shasum))) {
    return jsonResponse({ error: "Invalid tarball" }, 400);
  }

  const packageLockOwner = await acquirePackagePublishLock(env, payload.name);
  if (!packageLockOwner) {
    return jsonResponse({ error: "Package publish already in progress" }, 409);
  }

  const claimKey = versionClaimKey(payload.name, payload.version);
  const key = tarballKey(payload.name, payload.version, payload.tarballName);
  let wroteTarball = false;
  try {
    const existing = await readPackument(env, payload.name);
    if (existing?.versions[payload.version]) {
      return jsonResponse({ error: "Package version already exists" }, 409);
    }

    const claim = await env.REGISTRY_BUCKET.put(
      claimKey,
      JSON.stringify({ name: payload.name, version: payload.version }),
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { package: payload.name, version: payload.version },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (claim === null) {
      return jsonResponse({ error: "Package version already exists" }, 409);
    }

    const tarballWrite = await env.REGISTRY_BUCKET.put(key, tarball, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        integrity: payload.integrity,
        shasum: payload.shasum,
        package: payload.name,
        version: payload.version,
      },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (tarballWrite === null) {
      await env.REGISTRY_BUCKET.delete(claimKey);
      return jsonResponse({ error: "Package version already exists" }, 409);
    }
    wroteTarball = true;

    const now = new Date().toISOString();
    const packument: Packument = existing ?? {
      _id: payload.name,
      name: payload.name,
      "dist-tags": {},
      versions: {},
      time: { created: now, modified: now },
    };

    packument["dist-tags"][payload.tag] = payload.version;
    packument.time.modified = now;
    packument.time[payload.version] = packument.time[payload.version] ?? now;
    packument.versions[payload.version] = {
      ...payload.packageJson,
      dist: {
        tarball: tarballUrl(request, payload.name, payload.tarballName),
        integrity: payload.integrity,
        shasum: payload.shasum,
      },
    };

    await env.REGISTRY_BUCKET.put(packumentKey(payload.name), JSON.stringify(packument), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    if (wroteTarball) {
      await env.REGISTRY_BUCKET.delete(key);
    }
    await env.REGISTRY_BUCKET.delete(claimKey);
    throw error;
  } finally {
    await releasePackagePublishLock(env, payload.name, packageLockOwner);
  }

  return jsonResponse(
    { ok: true, name: payload.name, version: payload.version, tag: payload.tag },
    201,
  );
}

async function handlePackageMetadata(request: Request, env: Env, name: string): Promise<Response> {
  if (!canRead(request, env)) {
    return unauthorized();
  }
  const packument = await readPackument(env, name);
  if (!packument) {
    return jsonResponse({ error: "Package not found" }, 404);
  }
  return jsonResponse(packument, 200);
}

async function handleTarball(
  request: Request,
  env: Env,
  name: string,
  tarballName: string,
): Promise<Response> {
  if (!canRead(request, env)) {
    return unauthorized();
  }

  const packument = await readPackument(env, name);
  if (!packument) {
    return jsonResponse({ error: "Package not found" }, 404);
  }

  const version = Object.entries(packument.versions).find(([, packageVersion]) =>
    packageVersion.dist.tarball.endsWith(`/-/${tarballName}`),
  )?.[0];
  if (!version) {
    return jsonResponse({ error: "Tarball not found" }, 404);
  }

  const object = await env.REGISTRY_BUCKET.get(tarballKey(name, version, tarballName));
  if (!object) {
    return jsonResponse({ error: "Tarball not found" }, 404);
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

  if (request.method === "PUT" && url.pathname === "/-/ventora/packages") {
    return handlePublish(request, env);
  }

  const tarballPath = parseTarballPath(url.pathname);
  if (request.method === "GET" && tarballPath) {
    return handleTarball(request, env, tarballPath.name, tarballPath.tarballName);
  }

  const packageName = parsePackagePath(url.pathname);
  if (request.method === "GET" && packageName) {
    return handlePackageMetadata(request, env, packageName);
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

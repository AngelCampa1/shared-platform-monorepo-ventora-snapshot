// UUID v4 pattern
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// CF Workers fallback storage — module-level variable.
// Safe because Workers are single-tenant per request invocation.
let _cfCorrelationId: string | undefined;

// AsyncLocalStorage instance (Node only) — lazily resolved on first call.
let _storageResolved = false;
let _nodeStorage:
  | {
      run<T>(value: string, fn: () => T): T;
      getStore(): string | undefined;
    }
  | undefined;

function resolveStorage():
  | { run<T>(value: string, fn: () => T): T; getStore(): string | undefined }
  | undefined {
  if (_storageResolved) return _nodeStorage;
  _storageResolved = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:async_hooks") as {
      AsyncLocalStorage: new <T>() => {
        run<U>(value: T, fn: () => U): U;
        getStore(): T | undefined;
      };
    };
    /* v8 ignore next 3 */
    if (typeof mod.AsyncLocalStorage === "function") {
      _nodeStorage = new mod.AsyncLocalStorage<string>();
    }
    /* v8 ignore next 3 */
  } catch {
    // Not in a Node environment — use the CF Workers fallback
  }
  return _nodeStorage;
}

// Internal: run fn using the CF Workers fallback (module-level variable).
// Exported so tests can exercise this path directly.
export function _withCorrelationIdCF<T>(id: string, fn: () => T): T {
  const previous = _cfCorrelationId;
  _cfCorrelationId = id;
  try {
    return fn();
  } finally {
    _cfCorrelationId = previous;
  }
}

// Internal: get correlation ID from CF Workers fallback.
// Exported so tests can exercise this path directly.
export function _getCorrelationIdCF(): string | undefined {
  return _cfCorrelationId;
}

/**
 * Runs `fn` with the given correlation ID in scope.
 * In Node environments this uses AsyncLocalStorage (concurrency-safe).
 * In Cloudflare Workers a module-level variable is used (safe because Workers
 * are single-tenant per request invocation).
 */
export function withCorrelationId<T>(id: string, fn: () => T): T {
  const storage = resolveStorage();
  /* v8 ignore next 3 */
  if (storage === undefined) return _withCorrelationIdCF(id, fn);
  return storage.run(id, fn);
}

/**
 * Returns the current correlation ID, or undefined if none is set.
 */
export function getCorrelationId(): string | undefined {
  const storage = resolveStorage();
  /* v8 ignore next 3 */
  if (storage === undefined) return _getCorrelationIdCF();
  return storage.getStore();
}

/**
 * Generates a new UUID v4 request ID using the platform's crypto API.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Returns true if `id` is a valid UUID v4 string.
 */
export function isValidRequestId(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}

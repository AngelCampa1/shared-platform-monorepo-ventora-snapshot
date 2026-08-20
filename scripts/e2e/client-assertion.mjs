#!/usr/bin/env node
/**
 * Real HMAC client-assertion signer for the local E2E harness.
 *
 * This mints valid `X-Ventora-Timestamp` / `X-Ventora-Nonce` / `X-Ventora-Signature`
 * headers that the ai-cs-worker and ai-sdr-worker accept on their authenticated
 * `/v1/*` endpoints. It exercises the *real* production signing path — the worker
 * recomputes the same HMAC and rejects any request whose signature does not match.
 *
 * The algorithm here MUST stay byte-identical to `@ventora/ai-assistant-contracts`
 * (`stableJson` / `buildHmacPayload` / `signHmacPayload`):
 *   - stableJson: JSON.stringify with object keys sorted lexicographically,
 *     undefined-valued keys dropped, arrays left in order, recursively.
 *   - payload:    `${timestamp}.${nonce}.${METHOD}.${path}.${sha256Hex(stableJson(body))}`
 *   - signature:  HMAC-SHA256(secret, payload) as lowercase hex.
 * The auth-contract E2E test is the live cross-check: if the booted worker accepts
 * a harness-signed request, the two implementations agree by construction.
 *
 * Nothing here is committed into worker config — the harness injects the test
 * secret and the localhost allowed-origin via `wrangler dev --var` at boot only.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

/** Test-only client-assertion secret injected via `--var` in E2E boot mode. */
export const E2E_CLIENT_ASSERTION_SECRET = "e2e-harness-client-assertion-secret";

/** The single localhost origin the E2E harness allowlists via `--var`. */
export const E2E_ALLOWED_ORIGIN = "http://localhost:5173";

/** An origin deliberately NOT in the allowlist, used to assert 403 rejection. */
export const E2E_FOREIGN_ORIGIN = "https://evil.example.com";

/**
 * Recursively produce a stable, key-sorted clone of a JSON value.
 * Mirrors `sortStable` in @ventora/ai-assistant-contracts exactly.
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortStable(value) {
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
    const child = /** @type {Record<string, unknown>} */ (value)[key];
    if (child !== undefined) {
      sorted[key] = sortStable(child);
    }
  }
  return sorted;
}

/**
 * Deterministic JSON serialization with sorted keys. Mirrors `stableJson`.
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  return JSON.stringify(sortStable(value));
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string. Mirrors `sha256Hex`.
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build the canonical HMAC payload string. Mirrors `buildHmacPayload`.
 * @param {{ timestamp: string, nonce: string, method: string, path: string, body: unknown }} input
 * @returns {string}
 */
export function buildHmacPayload(input) {
  return `${input.timestamp}.${input.nonce}.${input.method.toUpperCase()}.${input.path}.${sha256Hex(stableJson(input.body))}`;
}

/**
 * HMAC-SHA256(secret, payload) as lowercase hex. Mirrors `signHmacPayload`.
 * @param {string} payload
 * @param {string} secret
 * @returns {string}
 */
export function signHmacPayload(payload, secret) {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(payload, "utf8").digest("hex");
}

/**
 * Mint the three signed-request headers a Ventora AI worker requires.
 *
 * @param {object} input
 * @param {string} input.path        Request pathname, e.g. "/v1/sessions".
 * @param {unknown} input.body       The exact JSON body object that will be sent.
 * @param {string} [input.method]    HTTP method (default "POST").
 * @param {string} [input.secret]    Signing secret (default E2E_CLIENT_ASSERTION_SECRET).
 * @param {string} [input.timestamp] ISO timestamp (default: now). Override for skew tests.
 * @param {string} [input.nonce]     Unique nonce (default: random UUID). Override for replay tests.
 * @returns {{ "X-Ventora-Timestamp": string, "X-Ventora-Nonce": string, "X-Ventora-Signature": string }}
 */
export function signClientAssertion(input) {
  const method = input.method ?? "POST";
  const secret = input.secret ?? E2E_CLIENT_ASSERTION_SECRET;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const nonce = input.nonce ?? randomUUID();
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method,
    path: input.path,
    body: input.body,
  });
  return {
    "X-Ventora-Timestamp": timestamp,
    "X-Ventora-Nonce": nonce,
    "X-Ventora-Signature": signHmacPayload(payload, secret),
  };
}

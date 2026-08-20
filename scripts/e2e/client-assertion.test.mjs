import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  E2E_ALLOWED_ORIGIN,
  E2E_CLIENT_ASSERTION_SECRET,
  E2E_FOREIGN_ORIGIN,
  buildHmacPayload,
  sha256Hex,
  signClientAssertion,
  signHmacPayload,
  sortStable,
  stableJson,
} from "./client-assertion.mjs";

// ---------------------------------------------------------------------------
// sortStable / stableJson — key ordering must match @ventora/ai-assistant-contracts
// ---------------------------------------------------------------------------

test("stableJson sorts object keys lexicographically", () => {
  assert.equal(stableJson({ b: 1, a: 2, c: 3 }), '{"a":2,"b":1,"c":3}');
});

test("stableJson sorts nested object keys recursively", () => {
  const value = { z: { y: 1, x: 2 }, a: [{ n: 1, m: 2 }] };
  assert.equal(stableJson(value), '{"a":[{"m":2,"n":1}],"z":{"x":2,"y":1}}');
});

test("stableJson preserves array order", () => {
  assert.equal(stableJson([3, 1, 2]), "[3,1,2]");
});

test("stableJson drops undefined-valued keys", () => {
  assert.equal(stableJson({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
});

test("sortStable returns primitives unchanged", () => {
  assert.equal(sortStable("x"), "x");
  assert.equal(sortStable(7), 7);
  assert.equal(sortStable(null), null);
  assert.equal(sortStable(true), true);
});

// ---------------------------------------------------------------------------
// sha256Hex — known-answer vector
// ---------------------------------------------------------------------------

test("sha256Hex matches the SHA-256 known-answer vector for the empty string", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256Hex matches an independent node:crypto digest", () => {
  const input = '{"a":1}';
  assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf8").digest("hex"));
});

// ---------------------------------------------------------------------------
// buildHmacPayload — canonical payload string
// ---------------------------------------------------------------------------

test("buildHmacPayload composes timestamp.nonce.METHOD.path.bodyHash and upper-cases the method", () => {
  const bodyHash = sha256Hex(stableJson({ appId: "lextract", userId: "u1" }));
  assert.equal(
    buildHmacPayload({
      timestamp: "2026-05-31T00:00:00.000Z",
      nonce: "nonce-1",
      method: "post",
      path: "/v1/sessions",
      body: { userId: "u1", appId: "lextract" },
    }),
    `2026-05-31T00:00:00.000Z.nonce-1.POST./v1/sessions.${bodyHash}`,
  );
});

// ---------------------------------------------------------------------------
// signHmacPayload — independent HMAC recomputation
// ---------------------------------------------------------------------------

test("signHmacPayload matches an independent node:crypto HMAC-SHA256 hex digest", () => {
  const payload = "a.b.POST./v1/sessions.deadbeef";
  const expected = createHmac("sha256", Buffer.from("secret", "utf8"))
    .update(payload, "utf8")
    .digest("hex");
  assert.equal(signHmacPayload(payload, "secret"), expected);
});

test("signHmacPayload produces a 64-char lowercase hex string", () => {
  assert.match(signHmacPayload("x", E2E_CLIENT_ASSERTION_SECRET), /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// signClientAssertion — header minting end to end
// ---------------------------------------------------------------------------

test("signClientAssertion returns the three signed headers with a recomputable signature", () => {
  const body = { appId: "lextract", userId: "u1" };
  const headers = signClientAssertion({
    path: "/v1/sessions",
    body,
    timestamp: "2026-05-31T12:00:00.000Z",
    nonce: "fixed-nonce",
  });
  assert.equal(headers["X-Ventora-Timestamp"], "2026-05-31T12:00:00.000Z");
  assert.equal(headers["X-Ventora-Nonce"], "fixed-nonce");
  const expectedPayload = buildHmacPayload({
    timestamp: "2026-05-31T12:00:00.000Z",
    nonce: "fixed-nonce",
    method: "POST",
    path: "/v1/sessions",
    body,
  });
  assert.equal(
    headers["X-Ventora-Signature"],
    signHmacPayload(expectedPayload, E2E_CLIENT_ASSERTION_SECRET),
  );
});

test("signClientAssertion defaults method to POST, timestamp to an ISO string, nonce to a UUID", () => {
  const headers = signClientAssertion({ path: "/v1/sessions", body: { productId: "lextract" } });
  assert.match(headers["X-Ventora-Timestamp"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(
    headers["X-Ventora-Nonce"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.match(headers["X-Ventora-Signature"], /^[a-f0-9]{64}$/);
});

test("signClientAssertion honors a custom secret", () => {
  const body = { productId: "lextract" };
  const headers = signClientAssertion({
    path: "/v1/sessions",
    body,
    timestamp: "2026-05-31T12:00:00.000Z",
    nonce: "n",
    secret: "other-secret",
  });
  const payload = buildHmacPayload({
    timestamp: "2026-05-31T12:00:00.000Z",
    nonce: "n",
    method: "POST",
    path: "/v1/sessions",
    body,
  });
  assert.equal(headers["X-Ventora-Signature"], signHmacPayload(payload, "other-secret"));
  assert.notEqual(
    headers["X-Ventora-Signature"],
    signHmacPayload(payload, E2E_CLIENT_ASSERTION_SECRET),
  );
});

test("E2E origin constants are distinct and well-formed", () => {
  assert.equal(E2E_ALLOWED_ORIGIN, "http://localhost:5173");
  assert.notEqual(E2E_ALLOWED_ORIGIN, E2E_FOREIGN_ORIGIN);
  assert.match(E2E_FOREIGN_ORIGIN, /^https?:\/\//);
});

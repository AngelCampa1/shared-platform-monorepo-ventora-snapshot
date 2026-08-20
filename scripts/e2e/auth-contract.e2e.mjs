#!/usr/bin/env node
/**
 * E2E auth-contract test (X7.2(b) first slice).
 *
 * Boots ai-cs-worker + ai-sdr-worker locally with the founder-approved `--var`
 * override (real client-assertion secret + localhost allowed-origin, nothing
 * committed) and asserts the REAL HMAC auth/origin contract end to end:
 *
 *   1. allowed origin + valid HMAC signature        -> 201 { sessionId }
 *   2. allowed origin + no signature headers         -> 401
 *   3. allowed origin + tampered signature           -> 401
 *   4. foreign (non-allowlisted) origin + valid HMAC -> 403
 *   5. replayed timestamp+nonce+signature            -> 401 (second attempt)
 *
 * This proves prereq #1 (the `--var` mechanism) and prereq's signing fidelity
 * (real production HMAC path) before the browser + mock-LLM layers are built.
 *
 * Run:  pnpm run test:e2e        (builds worker deps, boots, asserts, tears down)
 *       E2E_NO_BUILD=1 pnpm run test:e2e   (skip the dep build)
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import {
  E2E_ALLOWED_ORIGIN,
  E2E_FOREIGN_ORIGIN,
  signClientAssertion,
} from "./client-assertion.mjs";

/** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
let harness;

before(async () => {
  harness = await startE2eWorkers({ build: process.env.E2E_NO_BUILD !== "1" });
});

after(() => {
  harness?.stop();
});

/**
 * POST to a worker session endpoint.
 * @param {string} baseUrl
 * @param {{ origin: string, body: unknown, headers?: Record<string, string> }} opts
 */
async function postSession(baseUrl, { origin, body, headers = {} }) {
  return fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * @param {"aiCs" | "aiSdr"} key
 * @param {() => unknown} makeBody  fresh body factory (distinct fields per worker)
 */
function describeWorker(key, makeBody) {
  describe(`${key} /v1/sessions auth contract`, () => {
    /** @returns {string} */
    const baseUrl = () => {
      assert.ok(harness, "harness not booted");
      return harness.workers[key].baseUrl;
    };

    test("allowed origin + valid HMAC -> 201 with sessionId", async () => {
      const body = makeBody();
      const headers = signClientAssertion({ path: "/v1/sessions", body });
      const res = await postSession(baseUrl(), { origin: E2E_ALLOWED_ORIGIN, body, headers });
      assert.equal(res.status, 201);
      const json = /** @type {{ sessionId?: unknown }} */ (await res.json());
      assert.equal(typeof json.sessionId, "string");
      assert.ok(/** @type {string} */ (json.sessionId).length > 0);
    });

    test("allowed origin + no signature -> 401", async () => {
      const body = makeBody();
      const res = await postSession(baseUrl(), { origin: E2E_ALLOWED_ORIGIN, body });
      assert.equal(res.status, 401);
    });

    test("allowed origin + tampered signature -> 401", async () => {
      const body = makeBody();
      const headers = signClientAssertion({ path: "/v1/sessions", body });
      const sig = headers["X-Ventora-Signature"];
      // Flip the final hex digit, keeping a valid 64-char lowercase-hex shape so
      // the worker reaches the signature-comparison (invalid_signature) path.
      const last = sig.slice(-1);
      headers["X-Ventora-Signature"] = sig.slice(0, -1) + (last === "0" ? "1" : "0");
      const res = await postSession(baseUrl(), { origin: E2E_ALLOWED_ORIGIN, body, headers });
      assert.equal(res.status, 401);
    });

    test("foreign origin + valid HMAC -> 403", async () => {
      const body = makeBody();
      const headers = signClientAssertion({ path: "/v1/sessions", body });
      const res = await postSession(baseUrl(), { origin: E2E_FOREIGN_ORIGIN, body, headers });
      assert.equal(res.status, 403);
    });

    test("replayed signature -> first 201, second 401", async () => {
      const body = makeBody();
      const headers = signClientAssertion({ path: "/v1/sessions", body });
      const first = await postSession(baseUrl(), { origin: E2E_ALLOWED_ORIGIN, body, headers });
      assert.equal(first.status, 201);
      const second = await postSession(baseUrl(), { origin: E2E_ALLOWED_ORIGIN, body, headers });
      assert.equal(second.status, 401);
    });
  });
}

describeWorker("aiCs", () => ({ appId: "lextract", userId: "e2e-user" }));
describeWorker("aiSdr", () => ({ productId: "lextract", visitorId: "e2e-visitor" }));

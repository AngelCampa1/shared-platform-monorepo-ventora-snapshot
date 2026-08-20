#!/usr/bin/env node
/**
 * E2E contract suite for the human-handoff endpoints of BOTH shared AI runtimes:
 *   - ai-sdr-worker  POST /v1/handoff      (lead-gen "talk to a human")
 *   - ai-cs-worker   POST /v1/escalations  (app-support "escalate to a human")
 *
 * These are the two APIs the goal names alongside session+chat ("session, chat,
 * and handoff APIs" / "session, chat, context, and escalation APIs") that had no
 * end-to-end coverage — the chat-SSE and browser slices stop at session→chat.
 * This slice closes that gap by driving each endpoint's FULL contract against the
 * locally-booted worker through the real HMAC client-assertion signer:
 *
 *   client (real HMAC signer)
 *     -> POST /v1/sessions     (create the session the handoff/escalation targets)
 *     -> POST /v1/handoff | /v1/escalations
 *          happy path           -> 202 { handoffId|escalationId, status: "queued" }
 *          missing sessionId     -> 400
 *          unknown session       -> 404 (valid signature, real-but-absent id)
 *          foreign origin        -> 403 (origin guard)
 *          tampered signature    -> 401 (client-assertion guard)
 *
 * Neither endpoint calls OpenRouter or a product/app-context endpoint — they only
 * mutate session state and enqueue the handoff — so no upstream mocks are needed;
 * the workers boot with the default E2E `--var` (test client-assertion secret +
 * localhost allowed origin) only.
 *
 * Run:  pnpm run test:e2e
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
 * POST a JSON body to a worker, signing the client assertion over the given path
 * and body. `origin` and `tamper` let the negative cases override the defaults.
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {{ origin?: string, tamper?: boolean }} [opts]
 * @returns {Promise<Response>}
 */
async function signedPost(
  baseUrl,
  path,
  body,
  { origin = E2E_ALLOWED_ORIGIN, tamper = false } = {},
) {
  const headers = signClientAssertion({ path, body });
  if (tamper) {
    // Flip the signature so it can no longer be recomputed by the worker.
    headers["X-Ventora-Signature"] = `${"0".repeat(64)}`;
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Create a session on the given worker and return its id.
 * @param {string} baseUrl
 * @param {Record<string, unknown>} body  e.g. { productId } (sdr) or { appId, userId } (cs)
 * @returns {Promise<string>}
 */
async function createSession(baseUrl, body) {
  const res = await signedPost(baseUrl, "/v1/sessions", body);
  assert.equal(res.status, 201, "session create should 201");
  const json = /** @type {{ sessionId?: unknown }} */ (await res.json());
  assert.equal(typeof json.sessionId, "string");
  return /** @type {string} */ (json.sessionId);
}

describe("ai-sdr /v1/handoff full contract (booted worker, real signer)", () => {
  /** @returns {string} */
  const baseUrl = () => {
    assert.ok(harness, "harness not booted");
    return harness.workers.aiSdr.baseUrl;
  };

  test("valid signed handoff queues and returns a handoffId", async () => {
    const sessionId = await createSession(baseUrl(), { productId: "lextract" });
    const res = await signedPost(baseUrl(), "/v1/handoff", {
      sessionId,
      message: "I'd like to talk to a human about pricing.",
      reason: "pricing",
    });
    assert.equal(res.status, 202);
    const json = /** @type {{ handoffId?: unknown, status?: unknown }} */ (await res.json());
    assert.equal(typeof json.handoffId, "string");
    assert.ok(/** @type {string} */ (json.handoffId).length > 0);
    assert.equal(json.status, "queued");
  });

  test("missing sessionId is rejected 400", async () => {
    const res = await signedPost(baseUrl(), "/v1/handoff", { message: "no session id here" });
    assert.equal(res.status, 400);
  });

  test("unknown session is 404 even with a valid signature", async () => {
    const res = await signedPost(baseUrl(), "/v1/handoff", {
      sessionId: "sdr-session-that-does-not-exist",
      message: "hello?",
    });
    assert.equal(res.status, 404);
  });

  test("foreign origin is rejected 403 by the origin guard", async () => {
    const sessionId = await createSession(baseUrl(), { productId: "lextract" });
    const res = await signedPost(
      baseUrl(),
      "/v1/handoff",
      { sessionId, message: "from a bad origin" },
      { origin: E2E_FOREIGN_ORIGIN },
    );
    assert.equal(res.status, 403);
  });

  test("tampered client-assertion signature is rejected 401", async () => {
    const sessionId = await createSession(baseUrl(), { productId: "lextract" });
    const res = await signedPost(
      baseUrl(),
      "/v1/handoff",
      { sessionId, message: "tampered" },
      { tamper: true },
    );
    assert.equal(res.status, 401);
  });
});

describe("ai-cs /v1/escalations full contract (booted worker, real signer)", () => {
  /** @returns {string} */
  const baseUrl = () => {
    assert.ok(harness, "harness not booted");
    return harness.workers.aiCs.baseUrl;
  };

  /** @returns {Record<string, unknown>} */
  const sessionBody = () => ({ appId: "lextract", userId: "e2e-handoff-user" });

  test("valid signed escalation queues and returns an escalationId", async () => {
    const owner = sessionBody();
    const sessionId = await createSession(baseUrl(), owner);
    const res = await signedPost(baseUrl(), "/v1/escalations", {
      ...owner,
      sessionId,
      reason: "bug",
      message: "I hit an error and need a human.",
    });
    assert.equal(res.status, 202);
    const json = /** @type {{ escalationId?: unknown, status?: unknown }} */ (await res.json());
    assert.equal(typeof json.escalationId, "string");
    assert.ok(/** @type {string} */ (json.escalationId).length > 0);
    assert.equal(json.status, "queued");
  });

  test("missing sessionId is rejected 400", async () => {
    const res = await signedPost(baseUrl(), "/v1/escalations", { reason: "no session id" });
    assert.equal(res.status, 400);
  });

  test("unknown session is 404 even with a valid signature", async () => {
    const res = await signedPost(baseUrl(), "/v1/escalations", {
      ...sessionBody(),
      sessionId: "cs-session-that-does-not-exist",
      message: "hello?",
    });
    assert.equal(res.status, 404);
  });

  test("foreign origin is rejected 403 by the origin guard", async () => {
    const owner = sessionBody();
    const sessionId = await createSession(baseUrl(), owner);
    const res = await signedPost(
      baseUrl(),
      "/v1/escalations",
      { ...owner, sessionId, message: "from a bad origin" },
      { origin: E2E_FOREIGN_ORIGIN },
    );
    assert.equal(res.status, 403);
  });

  test("tampered client-assertion signature is rejected 401", async () => {
    const owner = sessionBody();
    const sessionId = await createSession(baseUrl(), owner);
    const res = await signedPost(
      baseUrl(),
      "/v1/escalations",
      { ...owner, sessionId, message: "tampered" },
      { tamper: true },
    );
    assert.equal(res.status, 401);
  });
});

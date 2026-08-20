#!/usr/bin/env node
/**
 * E2E chat-SSE test (X7.2(b) second slice).
 *
 * Drives the ai-cs-worker's full authenticated chat pipeline end to end against
 * deterministic local mocks — no network, no real OpenRouter, no real product
 * context endpoint:
 *
 *   client (real HMAC signer)
 *     -> POST /v1/sessions               (create authenticated session)
 *     -> POST /v1/chat                    (signed, origin-matched)
 *          -> worker fetchSignedAppContext  -> mock-context.mjs (signed req + signed resp)
 *          -> worker callOpenRouter         -> mock-openrouter.mjs (canned completion)
 *          -> worker streams SSE            -> { navigation.suggestion, message.delta, message.done }
 *
 * This is the in-depth (non-smoke) verification the goal mandates for the shared
 * AI-CS runtime: it exercises the REAL production code paths for auth, the signed
 * app-context request/response round-trip, the OpenRouter upstream call shape, and
 * the SSE event framing — all wired together.
 *
 * The mock OpenRouter + signed-context endpoints are reachable only because the
 * worker's SSRF guards allow `http://localhost:*` when ENVIRONMENT is a non-prod
 * value (founder-approved dev-mode localhost allowance). In production the guards
 * stay https/openrouter.ai-locked — see the unit tests in
 * packages/ai-cs-worker/src/__tests__/index.test.ts.
 *
 * Run:  pnpm run test:e2e
 *       E2E_NO_BUILD=1 pnpm run test:e2e   (skip the dep build)
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { E2E_ALLOWED_ORIGIN, signClientAssertion } from "./client-assertion.mjs";
import { startMockContext } from "./mock-context.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";

/** appId shared between the created session and the mock context server. */
const APP_ID = "lextract";
/** Human-readable app name the mock context returns (asserts branding flows through). */
const APP_NAME = "Lextract";
/** Test-only shared secret for the signed app-context round-trip (AI_CS_CONTEXT_SECRET). */
const CONTEXT_SECRET = "e2e-harness-context-secret";
/** Test-only OpenRouter bearer key (the mock ignores it; the worker requires it to be set). */
const OPENROUTER_KEY = "e2e-openrouter-key";
/** Canned assistant content the mock OpenRouter returns; asserted verbatim in the delta. */
const MOCK_CONTENT = "Hello from the mock assistant via the chat-SSE E2E.";
/** Navigation target the mock context advertises so a navigation.suggestion prelude fires. */
const NAV = [{ label: "Open billing", path: "/billing", description: "Manage your subscription" }];

/**
 * Minimal SSE parser for the worker's `event: <name>\ndata: <json>\n\n` framing.
 * @param {string} text
 * @returns {Array<{ event: string, data: unknown }>}
 */
function parseSse(text) {
  return text
    .trim()
    .split(/(?:\r\n|\r|\n){2}/)
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split(/\r\n|\r|\n/);
      const event = (lines.find((line) => line.startsWith("event: ")) ?? "event: ").slice(7);
      const dataLine = lines.find((line) => line.startsWith("data: ")) ?? "data: null";
      return { event, data: JSON.parse(dataLine.slice(6)) };
    });
}

/** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
let harness;
/** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
let openRouter;
/** @type {Awaited<ReturnType<typeof startMockContext>> | undefined} */
let context;

before(async () => {
  openRouter = await startMockOpenRouter({ content: MOCK_CONTENT });
  context = await startMockContext({
    secret: CONTEXT_SECRET,
    appId: APP_ID,
    appName: APP_NAME,
    navigation: NAV,
  });
  harness = await startE2eWorkers({
    build: process.env.E2E_NO_BUILD !== "1",
    extraVars: {
      aiCs: [
        `OPENROUTER_ENDPOINT:${openRouter.url}`,
        `OPENROUTER_API_KEY:${OPENROUTER_KEY}`,
        `AI_CS_CONTEXT_ENDPOINT:${context.url}`,
        `AI_CS_CONTEXT_SECRET:${CONTEXT_SECRET}`,
      ],
    },
  });
});

after(async () => {
  harness?.stop();
  await openRouter?.close();
  await context?.close();
});

/** @returns {string} */
function aiCsBaseUrl() {
  assert.ok(harness, "harness not booted");
  return harness.workers.aiCs.baseUrl;
}

/**
 * Create an authenticated session and return its id.
 * @returns {Promise<string>}
 */
async function createSession() {
  const body = { appId: APP_ID, userId: "e2e-chat-user" };
  const headers = signClientAssertion({ path: "/v1/sessions", body });
  const res = await fetch(`${aiCsBaseUrl()}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: E2E_ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  const json = /** @type {{ sessionId?: unknown }} */ (await res.json());
  assert.equal(typeof json.sessionId, "string");
  return /** @type {string} */ (json.sessionId);
}

/**
 * Send a signed chat message and return the raw SSE response.
 * @param {string} sessionId
 * @param {string} message
 */
async function postChat(sessionId, message) {
  const body = { appId: APP_ID, userId: "e2e-chat-user", sessionId, message };
  const headers = signClientAssertion({ path: "/v1/chat", body });
  return fetch(`${aiCsBaseUrl()}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: E2E_ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("ai-cs /v1/chat SSE pipeline (mock OpenRouter + signed context)", () => {
  test("streams prelude + canned completion via message.delta/message.done", async () => {
    const sessionId = await createSession();
    const userMessage = "How do I manage my billing subscription?";

    const before = openRouter?.requests.length ?? 0;
    const res = await postChat(sessionId, userMessage);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);

    // The full prelude + LLM framing, in order.
    assert.deepEqual(names, ["navigation.suggestion", "message.delta", "message.done"]);

    const nav = events[0];
    assert.equal(
      /** @type {{ target?: { label?: unknown } }} */ (nav.data).target?.label,
      "Open billing",
    );

    const delta = events[1];
    const deltaData = /** @type {{ messageId?: unknown, delta?: unknown }} */ (delta.data);
    assert.equal(deltaData.delta, MOCK_CONTENT);
    assert.equal(typeof deltaData.messageId, "string");

    const done = events[2];
    const doneData = /** @type {{ messageId?: unknown }} */ (done.data);
    // delta + done carry the same messageId.
    assert.equal(doneData.messageId, deltaData.messageId);

    // The worker actually called the mock OpenRouter with the user's message.
    assert.equal(openRouter?.requests.length, before + 1);
    const upstream = /** @type {{ messages?: Array<{ content?: unknown }> }} */ (
      openRouter?.requests.at(-1)
    );
    assert.ok(Array.isArray(upstream.messages));
    assert.ok(
      upstream.messages.some(
        (m) => typeof m.content === "string" && m.content.includes(userMessage),
      ),
      "OpenRouter request should include the user message",
    );

    // The signed app-context round-trip happened and verified.
    assert.ok((context?.requests.length ?? 0) >= 1, "context endpoint should have been called");
    assert.ok(
      context?.requests.every((r) => r.verified),
      "every context request must pass HMAC verification",
    );
    const ctxReq = context?.requests.at(-1);
    assert.equal(ctxReq?.searchParams.get("appId"), APP_ID);
    assert.equal(ctxReq?.searchParams.get("userId"), "e2e-chat-user");
  });

  test("rejects an unsigned chat request with 401", async () => {
    const sessionId = await createSession();
    const res = await fetch(`${aiCsBaseUrl()}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: E2E_ALLOWED_ORIGIN },
      body: JSON.stringify({ appId: APP_ID, userId: "e2e-chat-user", sessionId, message: "hi" }),
    });
    assert.equal(res.status, 401);
  });
});

#!/usr/bin/env node
/**
 * E2E chat-SSE test for the ai-sdr-worker (X7.2(b) third slice).
 *
 * The ai-sdr sibling of chat-sse.e2e.mjs. Drives the ai-sdr-worker's full
 * lead-gen chat pipeline end to end against deterministic local mocks — no
 * network, no real OpenRouter, no real product-context endpoint:
 *
 *   client (real HMAC signer)
 *     -> POST /v1/sessions               (create session, origin-bound)
 *     -> POST /v1/chat                   (signed, origin-matched)
 *          -> worker fetchSignedProductContext -> mock-product-context.mjs (signed req + resp)
 *          -> worker callOpenRouter            -> mock-openrouter.mjs (canned completion)
 *          -> worker emits SSE                 -> { source, message.delta, message.done }
 *
 * This is the in-depth (non-smoke) verification the goal mandates for the shared
 * AI-SDR runtime: it exercises the REAL production code paths for client-assertion
 * auth, the MANDATORY signed product-context round-trip (chat 502s without it),
 * the OpenRouter upstream request shape, and the SSE event framing — all wired
 * together.
 *
 * The mock OpenRouter + signed-context endpoints are reachable only because the
 * worker's SSRF guards allow `http://localhost:*` when ENVIRONMENT is a non-prod
 * value (founder-approved dev-mode localhost allowance). In production the guards
 * stay https/openrouter.ai-locked — see the unit tests in
 * packages/ai-sdr-worker/src/__tests__/index.test.ts.
 *
 * Run:  pnpm run test:e2e
 *       E2E_NO_BUILD=1 pnpm run test:e2e   (skip the dep build)
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { E2E_ALLOWED_ORIGIN, signClientAssertion } from "./client-assertion.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";
import { startMockProductContext } from "./mock-product-context.mjs";

/** productId shared between the created session and the mock product-context server. */
const PRODUCT_ID = "lextract";
/** Test-only shared secret for the signed product-context round-trip (AI_SDR_CONTEXT_SECRET). */
const CONTEXT_SECRET = "e2e-harness-sdr-context-secret";
/** Test-only OpenRouter bearer key (the mock ignores it; the worker requires it to be set). */
const OPENROUTER_KEY = "e2e-openrouter-key";
/** Canned assistant content the mock OpenRouter returns; asserted verbatim in the delta. */
const MOCK_CONTENT = "Hello from the mock SDR assistant via the chat-SSE E2E.";
/**
 * The signed product context the mock returns. isProductContext only requires
 * productId + name; the single source makes the worker emit a `source` prelude.
 */
const PRODUCT = {
  productId: PRODUCT_ID,
  name: "Lextract",
  sources: [
    {
      id: "lextract-overview",
      title: "Lextract overview",
      excerpt: "Board management workspace for teams",
      url: "https://example.com/lextract",
    },
  ],
};

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
/** @type {Awaited<ReturnType<typeof startMockProductContext>> | undefined} */
let context;

before(async () => {
  openRouter = await startMockOpenRouter({ content: MOCK_CONTENT });
  context = await startMockProductContext({ secret: CONTEXT_SECRET, product: PRODUCT });
  harness = await startE2eWorkers({
    build: process.env.E2E_NO_BUILD !== "1",
    extraVars: {
      aiSdr: [
        `OPENROUTER_ENDPOINT:${openRouter.url}`,
        `OPENROUTER_API_KEY:${OPENROUTER_KEY}`,
        `AI_SDR_CONTEXT_ENDPOINT:${context.url}`,
        `AI_SDR_CONTEXT_SECRET:${CONTEXT_SECRET}`,
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
function aiSdrBaseUrl() {
  assert.ok(harness, "harness not booted");
  return harness.workers.aiSdr.baseUrl;
}

/**
 * Create a session and return its id.
 * @returns {Promise<string>}
 */
async function createSession() {
  const body = { productId: PRODUCT_ID };
  const headers = signClientAssertion({ path: "/v1/sessions", body });
  const res = await fetch(`${aiSdrBaseUrl()}/v1/sessions`, {
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
  const body = { sessionId, message };
  const headers = signClientAssertion({ path: "/v1/chat", body });
  return fetch(`${aiSdrBaseUrl()}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: E2E_ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("ai-sdr /v1/chat SSE pipeline (mock OpenRouter + signed product context)", () => {
  test("streams source prelude + canned completion via message.delta/message.done", async () => {
    const sessionId = await createSession();
    // Neutral product question: no price/trial keywords, so the route stays
    // "primary" and no plan.recommendation / trial.cta conditional events fire.
    const userMessage = "What does this product do for my team?";

    const before = openRouter?.requests.length ?? 0;
    const res = await postChat(sessionId, userMessage);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);

    // source prelude (the product context advertises a source) + LLM framing, in order.
    assert.deepEqual(names, ["source", "message.delta", "message.done"]);

    const source = events[0];
    assert.equal(
      /** @type {{ source?: { title?: unknown } }} */ (source.data).source?.title,
      "Lextract overview",
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

    // The signed product-context round-trip happened and verified.
    assert.ok((context?.requests.length ?? 0) >= 1, "context endpoint should have been called");
    assert.ok(
      context?.requests.every((r) => r.verified),
      "every context request must pass HMAC verification",
    );
    const ctxReq = context?.requests.at(-1);
    assert.equal(ctxReq?.searchParams.get("productId"), PRODUCT_ID);
  });

  test("rejects an unsigned chat request with 401", async () => {
    const sessionId = await createSession();
    const res = await fetch(`${aiSdrBaseUrl()}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: E2E_ALLOWED_ORIGIN },
      body: JSON.stringify({ sessionId, message: "hi" }),
    });
    assert.equal(res.status, 401);
  });
});

#!/usr/bin/env node
/**
 * Unit tests for mock-openrouter.mjs, mock-context.mjs, and
 * mock-product-context.mjs.
 *
 * Run standalone:
 *   node --test scripts/e2e/mock-servers.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildHmacPayload, signClientAssertion, signHmacPayload } from "./client-assertion.mjs";
import { startMockContext } from "./mock-context.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";
import { startMockProductContext } from "./mock-product-context.mjs";

// ---------------------------------------------------------------------------
// mock-openrouter
// ---------------------------------------------------------------------------

describe("mock-openrouter", () => {
  /** @type {import("./mock-openrouter.mjs").MockOpenRouterHandle | undefined} */
  let handle;

  before(async () => {
    handle = await startMockOpenRouter({ port: 0 });
  });

  after(async () => {
    await handle?.close();
  });

  test("url includes localhost and a non-zero port", () => {
    assert.ok(handle, "handle not set");
    assert.match(handle.url, /^http:\/\/localhost:\d+\/openrouter$/);
    assert.ok(handle.port > 0, "port should be > 0");
  });

  test("POST returns 200 with default canned choices", async () => {
    assert.ok(handle, "handle not set");
    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "minimax/minimax-m3",
        provider: { order: ["fireworks"] },
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(res.status, 200);
    const json = /** @type {unknown} */ (await res.json());
    assert.ok(
      typeof json === "object" && json !== null && !Array.isArray(json),
      "response should be an object",
    );
    const typed = /** @type {Record<string, unknown>} */ (json);
    assert.ok(Array.isArray(typed.choices), "choices should be an array");
    const first = /** @type {Record<string, unknown>} */ (typed.choices[0]);
    assert.ok(typeof first === "object" && first !== null, "first choice should be an object");
    const message = /** @type {Record<string, unknown>} */ (first.message);
    assert.ok(typeof message === "object" && message !== null, "message should be an object");
    assert.equal(message.content, "Hello from the mock assistant.");
  });

  test("records the request body", async () => {
    assert.ok(handle, "handle not set");
    const payload = {
      model: "openai/gpt-5.4-nano",
      provider: { order: ["openai"] },
      messages: [{ role: "user", content: "Test recording" }],
    };
    await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // At least one request must have been recorded by now (could be index 1 if prior test ran).
    const last = /** @type {Record<string, unknown>} */ (
      handle.requests[handle.requests.length - 1]
    );
    assert.ok(last !== null && typeof last === "object", "last request should be an object");
    assert.equal(last.model, "openai/gpt-5.4-nano");
    const messages = /** @type {Array<unknown>} */ (last.messages);
    assert.ok(Array.isArray(messages));
    const firstMsg = /** @type {Record<string, unknown>} */ (messages[0]);
    assert.equal(firstMsg.content, "Test recording");
  });

  test("custom content option is returned", async () => {
    const custom = await startMockOpenRouter({ port: 0, content: "Custom reply here." });
    try {
      const res = await fetch(custom.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      const json = /** @type {{ choices: [{ message: { content: string } }] }} */ (
        await res.json()
      );
      assert.equal(json.choices[0].message.content, "Custom reply here.");
    } finally {
      await custom.close();
    }
  });
});

// ---------------------------------------------------------------------------
// mock-context
// ---------------------------------------------------------------------------

const TEST_SECRET = "e2e-context-test-secret";
const TEST_APP_ID = "lextract";
const TEST_APP_NAME = "Lextract";

describe("mock-context", () => {
  /** @type {import("./mock-context.mjs").MockContextHandle | undefined} */
  let handle;

  before(async () => {
    handle = await startMockContext({
      secret: TEST_SECRET,
      appId: TEST_APP_ID,
      appName: TEST_APP_NAME,
      port: 0,
    });
  });

  after(async () => {
    await handle?.close();
  });

  test("url includes localhost and a non-zero port", () => {
    assert.ok(handle, "handle not set");
    assert.match(handle.url, /^http:\/\/localhost:\d+\/context$/);
    assert.ok(handle.port > 0, "port should be > 0");
  });

  /**
   * Build the signed GET request headers the worker would send.
   * @param {string} path  Full pathname+search, e.g. "/context?appId=...&userId=..."
   * @param {{ appId: string, userId: string, currentPath?: string }} body
   * @returns {Record<string, string>}
   */
  function signContextRequest(path, body) {
    return signClientAssertion({ path, body, method: "GET", secret: TEST_SECRET });
  }

  test("correctly-signed GET returns 200 with AiCsAppContext shape", async () => {
    assert.ok(handle, "handle not set");
    const userId = "user-abc";
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", userId);
    const path = `${url.pathname}${url.search}`;
    const headers = signContextRequest(path, { appId: TEST_APP_ID, userId });

    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const json = /** @type {Record<string, unknown>} */ (await res.json());
    assert.equal(json.assistantId, "ai-cs");
    assert.equal(json.appId, TEST_APP_ID);
    assert.equal(json.appName, TEST_APP_NAME);
    assert.equal(json.authenticatedOnly, true);
  });

  test("accepts a currentPath query param while the signed body stays {appId,userId}", async () => {
    // The worker signs the context request body as {appId,userId} ONLY, even
    // when it appends currentPath to the query string — see the regression test
    // "signs context request body as {appId,userId} only even when currentPath
    // is present" in packages/ai-cs-worker/src/__tests__/index.test.ts. Product
    // verifiers therefore never have to track which query params the worker
    // might add. This mock must verify the same way the real products do.
    assert.ok(handle, "handle not set");
    const userId = "user-path";
    const currentPath = "/billing";
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", userId);
    url.searchParams.set("currentPath", currentPath);
    const path = `${url.pathname}${url.search}`;
    const headers = signContextRequest(path, { appId: TEST_APP_ID, userId });

    const res = await fetch(url.toString(), { method: "GET", headers });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const last = handle.requests[handle.requests.length - 1];
    assert.equal(last.verified, true);
    assert.equal(last.searchParams.get("currentPath"), currentPath);
  });

  test("correctly-signed GET has valid response signature headers", async () => {
    assert.ok(handle, "handle not set");
    const userId = "user-def";
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", userId);
    const path = `${url.pathname}${url.search}`;
    const reqHeaders = signContextRequest(path, { appId: TEST_APP_ID, userId });

    const res = await fetch(url.toString(), { method: "GET", headers: reqHeaders });
    assert.equal(res.status, 200);

    const responseTimestamp = res.headers.get("X-Ventora-Timestamp");
    const responseNonce = res.headers.get("X-Ventora-Nonce");
    const responseSignature = res.headers.get("X-Ventora-Signature");
    assert.ok(responseTimestamp, "X-Ventora-Timestamp header missing");
    assert.ok(responseNonce, "X-Ventora-Nonce header missing");
    assert.ok(responseSignature, "X-Ventora-Signature header missing");

    const app = /** @type {unknown} */ (await res.json());

    // Replicate the worker's response-verification logic (index.ts L375-390):
    //   buildHmacPayload({ timestamp: responseTimestamp, nonce: responseNonce,
    //                      method: "GET", path, body: app })
    const payload = buildHmacPayload({
      timestamp: responseTimestamp,
      nonce: responseNonce,
      method: "GET",
      path,
      body: app,
    });
    const expected = signHmacPayload(payload, TEST_SECRET);
    assert.equal(
      responseSignature,
      expected,
      "response signature does not match worker's expected verification payload",
    );
  });

  test("wrongly-signed GET (tampered signature) returns 401", async () => {
    assert.ok(handle, "handle not set");
    const userId = "user-ghi";
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", userId);
    const path = `${url.pathname}${url.search}`;
    const headers = signContextRequest(path, { appId: TEST_APP_ID, userId });

    // Flip the last hex character of the signature.
    const sig = headers["X-Ventora-Signature"];
    const last = sig.slice(-1);
    headers["X-Ventora-Signature"] = sig.slice(0, -1) + (last === "0" ? "1" : "0");

    const res = await fetch(url.toString(), { method: "GET", headers });
    assert.equal(res.status, 401, "expected 401 for tampered signature");
  });

  test("missing signature headers returns 401", async () => {
    assert.ok(handle, "handle not set");
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", "user-jkl");

    const res = await fetch(url.toString(), { method: "GET" });
    assert.equal(res.status, 401, "expected 401 for missing signature headers");
  });

  test("records requests with verified flag", async () => {
    assert.ok(handle, "handle not set");
    const initialLength = handle.requests.length;

    const userId = "user-record";
    const url = new URL(handle.url);
    url.searchParams.set("appId", TEST_APP_ID);
    url.searchParams.set("userId", userId);
    const path = `${url.pathname}${url.search}`;
    const headers = signContextRequest(path, { appId: TEST_APP_ID, userId });

    await fetch(url.toString(), { method: "GET", headers });

    assert.equal(
      handle.requests.length,
      initialLength + 1,
      "should have recorded one more request",
    );
    const last = handle.requests[handle.requests.length - 1];
    assert.equal(last.verified, true, "verified flag should be true for valid request");
    assert.equal(last.searchParams.get("appId"), TEST_APP_ID);
    assert.equal(last.searchParams.get("userId"), userId);
  });
});

// ---------------------------------------------------------------------------
// mock-product-context (ai-sdr sibling of mock-context)
// ---------------------------------------------------------------------------

const SDR_SECRET = "e2e-sdr-context-test-secret";
const SDR_PRODUCT_ID = "lextract";
const SDR_PRODUCT = {
  productId: SDR_PRODUCT_ID,
  name: "Lextract",
  sources: [{ title: "Lextract overview", excerpt: "Pull facts from files" }],
};

describe("mock-product-context", () => {
  /** @type {import("./mock-product-context.mjs").MockProductContextHandle | undefined} */
  let handle;

  before(async () => {
    handle = await startMockProductContext({
      secret: SDR_SECRET,
      product: SDR_PRODUCT,
      port: 0,
    });
  });

  after(async () => {
    await handle?.close();
  });

  /**
   * Build the signed GET request headers the ai-sdr worker would send.
   * @param {string} path  Full pathname+search, e.g. "/context?productId=..."
   * @param {{ productId: string }} body
   * @returns {Record<string, string>}
   */
  function signContextRequest(path, body) {
    return signClientAssertion({ path, body, method: "GET", secret: SDR_SECRET });
  }

  /**
   * @param {string} productId
   * @returns {{ url: URL, path: string }}
   */
  function contextUrl(productId) {
    assert.ok(handle, "handle not set");
    const url = new URL(handle.url);
    url.searchParams.set("productId", productId);
    return { url, path: `${url.pathname}${url.search}` };
  }

  test("url includes localhost and a non-zero port", () => {
    assert.ok(handle, "handle not set");
    assert.match(handle.url, /^http:\/\/localhost:\d+\/context$/);
    assert.ok(handle.port > 0, "port should be > 0");
  });

  test("correctly-signed GET returns 200 with the configured ProductContext", async () => {
    const { url, path } = contextUrl(SDR_PRODUCT_ID);
    const headers = signContextRequest(path, { productId: SDR_PRODUCT_ID });

    const res = await fetch(url.toString(), { method: "GET", headers });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const json = /** @type {Record<string, unknown>} */ (await res.json());
    assert.equal(json.productId, SDR_PRODUCT_ID);
    assert.equal(json.name, "Lextract");
    assert.ok(Array.isArray(json.sources), "sources should be an array");
  });

  test("correctly-signed GET has a valid response signature over the product body", async () => {
    const { url, path } = contextUrl(SDR_PRODUCT_ID);
    const reqHeaders = signContextRequest(path, { productId: SDR_PRODUCT_ID });

    const res = await fetch(url.toString(), { method: "GET", headers: reqHeaders });
    assert.equal(res.status, 200);

    const responseTimestamp = res.headers.get("X-Ventora-Timestamp");
    const responseNonce = res.headers.get("X-Ventora-Nonce");
    const responseSignature = res.headers.get("X-Ventora-Signature");
    assert.ok(responseTimestamp, "X-Ventora-Timestamp header missing");
    assert.ok(responseNonce, "X-Ventora-Nonce header missing");
    assert.ok(responseSignature, "X-Ventora-Signature header missing");

    const product = /** @type {unknown} */ (await res.json());

    // Replicate the worker's response-verification logic (fetchSignedProductContext):
    //   buildHmacPayload({ timestamp, nonce, method: "GET", path, body: product })
    const payload = buildHmacPayload({
      timestamp: responseTimestamp,
      nonce: responseNonce,
      method: "GET",
      path,
      body: product,
    });
    const expected = signHmacPayload(payload, SDR_SECRET);
    assert.equal(
      responseSignature,
      expected,
      "response signature does not match worker's expected verification payload",
    );
  });

  test("wrongly-signed GET (tampered signature) returns 401", async () => {
    const { url, path } = contextUrl(SDR_PRODUCT_ID);
    const headers = signContextRequest(path, { productId: SDR_PRODUCT_ID });

    const sig = headers["X-Ventora-Signature"];
    const last = sig.slice(-1);
    headers["X-Ventora-Signature"] = sig.slice(0, -1) + (last === "0" ? "1" : "0");

    const res = await fetch(url.toString(), { method: "GET", headers });
    assert.equal(res.status, 401, "expected 401 for tampered signature");
  });

  test("missing signature headers returns 401", async () => {
    const { url } = contextUrl(SDR_PRODUCT_ID);
    const res = await fetch(url.toString(), { method: "GET" });
    assert.equal(res.status, 401, "expected 401 for missing signature headers");
  });

  test("records requests with verified flag and productId", async () => {
    assert.ok(handle, "handle not set");
    const initialLength = handle.requests.length;

    const { url, path } = contextUrl(SDR_PRODUCT_ID);
    const headers = signContextRequest(path, { productId: SDR_PRODUCT_ID });
    await fetch(url.toString(), { method: "GET", headers });

    assert.equal(
      handle.requests.length,
      initialLength + 1,
      "should have recorded one more request",
    );
    const last = handle.requests[handle.requests.length - 1];
    assert.equal(last.verified, true, "verified flag should be true for valid request");
    assert.equal(last.searchParams.get("productId"), SDR_PRODUCT_ID);
  });
});

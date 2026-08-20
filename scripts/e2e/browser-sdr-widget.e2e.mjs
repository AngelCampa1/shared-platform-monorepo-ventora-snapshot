#!/usr/bin/env node
/**
 * Browser-layer E2E for the hosted AI-SDR widget (X7.2(b) sibling of
 * browser-widget.e2e.mjs).
 *
 * Drives the REAL worker-hosted ai-sdr IIFE (`window.AiSdr.init`) in a real
 * Chromium browser through a same-origin signing BFF, against the locally-booted
 * ai-sdr-worker + deterministic mocks. This is the in-depth (non-smoke) browser
 * verification the goal mandates for the shared AI-SDR runtime — it proves the
 * hosted client actually mounts, signs (via the BFF), streams, renders, and
 * adapts to each product's branding, end to end:
 *
 *   Chromium page (loads worker IIFE cross-origin)
 *     -> window.AiSdr.init({ baseUrl: "/api/ai-sdr", session:{productId}, autoOpen })
 *     -> user types + clicks [data-ai-sdr-send]
 *          -> POST /api/ai-sdr/v1/sessions  (BFF signs)         -> worker
 *          -> POST /api/ai-sdr/v1/chat      (BFF signs, SSE)    -> worker
 *               -> worker signed product-context round-trip     -> mock-product-context
 *               -> worker OpenRouter call                       -> mock-openrouter
 *               -> SSE source + message.delta/done streamed back through the BFF
 *     -> widget renders the assistant bubble with the canned content
 *
 * Per-brand theming is asserted with the browser's real getComputedStyle: the
 * widget root's `--ai-sdr-accent` must equal the product's brand preset accent,
 * and two products must resolve to distinct accents.
 *
 * The mocks are reachable only because the worker's SSRF guard allows
 * `http://localhost:*` when ENVIRONMENT is non-prod (founder-approved dev-mode
 * allowance); the boot harness sets ENVIRONMENT:development + E2E secrets via
 * `--var` only. In production the guards stay https/openrouter.ai-locked.
 *
 * Run:  pnpm run test:e2e:browser:sdr
 *       E2E_NO_BUILD=1 pnpm run test:e2e:browser:sdr   (skip the dep build)
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { startSdrBrowserBff } from "./browser-sdr-bff.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";
import { startMockProductContext } from "./mock-product-context.mjs";

/** productId used for the chat round-trip; matches the mock product context. */
const PRODUCT_ID = "lextract";
/** Shared secret for the signed product-context round-trip (AI_SDR_CONTEXT_SECRET). */
const CONTEXT_SECRET = "e2e-harness-sdr-context-secret";
/** Test-only OpenRouter bearer key (the mock ignores it; the worker requires it set). */
const OPENROUTER_KEY = "e2e-openrouter-key";
/** Canned assistant content the mock OpenRouter returns; asserted in the rendered bubble. */
const MOCK_CONTENT = "Hello from the mock SDR assistant via the browser E2E.";

/** Signed product context the mock returns for the chat round-trip. */
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
 * Expected brand-preset accent colors (from the ai-sdr-worker hosted-client brand
 * table). Per-brand theming must resolve each product to exactly these, and the two
 * must differ — proving the widget adapts to each app's branding.
 */
const EXPECTED_ACCENTS = {
  camaudit: "#1f5a52",
  capveri: "#4f46e5",
  grantpipe: "#15803d",
  lextract: "#b45309",
};

/** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
let harness;
/** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
let openRouter;
/** @type {Awaited<ReturnType<typeof startMockProductContext>> | undefined} */
let context;
/** @type {Awaited<ReturnType<typeof startSdrBrowserBff>> | undefined} */
let bff;
/** @type {import("playwright").Browser | undefined} */
let browser;

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
  bff = await startSdrBrowserBff({ aiSdrBaseUrl: harness.workers.aiSdr.baseUrl });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await bff?.close();
  harness?.stop();
  await openRouter?.close();
  await context?.close();
});

/**
 * Open a fresh page with the widget mounted for the given product and wait until it
 * is interactable.
 * @param {string} productId
 * @returns {Promise<import("playwright").Page>}
 */
async function openWidget(productId) {
  assert.ok(bff, "bff not booted");
  assert.ok(browser, "browser not launched");
  const page = await browser.newPage();
  await page.goto(`${bff.url}/?product=${encodeURIComponent(productId)}`);
  await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
    timeout: 15_000,
  });
  const error = await page.evaluate(() => window.__WIDGET_ERROR__);
  assert.equal(error, undefined, `widget init error: ${String(error)}`);
  await page.waitForSelector("[data-ai-sdr-widget]", { timeout: 15_000 });
  return page;
}

describe("ai-sdr hosted widget — real browser, signing BFF, booted worker", () => {
  test("session -> chat(SSE) -> renders assistant bubble", async () => {
    const page = await openWidget(PRODUCT_ID);

    // autoOpen revealed the panel; the composer textarea should be present.
    await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });

    const beforeOpenRouter = openRouter?.requests.length ?? 0;
    const beforeContext = context?.requests.length ?? 0;

    await page.fill("[data-ai-sdr-input]", "What does this product do for my team?");
    await page.click("[data-ai-sdr-send]");

    // The assistant bubble must render the canned mock content (full SSE round-trip).
    await page.waitForFunction(
      (expected) => {
        const bubbles = document.querySelectorAll(
          '[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]',
        );
        return Array.from(bubbles).some((b) => (b.textContent ?? "").includes(expected));
      },
      MOCK_CONTENT,
      { timeout: 15_000 },
    );

    // The worker actually called the mock OpenRouter and the signed context endpoint.
    assert.equal(openRouter?.requests.length, beforeOpenRouter + 1);
    assert.ok(
      (context?.requests.length ?? 0) > beforeContext,
      "signed product-context endpoint should have been called",
    );
    assert.ok(
      context?.requests.every((r) => r.verified),
      "every context request must pass HMAC verification",
    );

    await page.close();
  });

  test("streaming-end lifecycle: stop button hides and composer is interactive after the answer settles", async () => {
    // Guards the AI-SDR analog of the AI-CS stuck-streaming defect: after a full
    // answer arrives, the "Stop generating" control must retract (lose its
    // data-visible flag, regain aria-hidden + inert) and the composer must be
    // usable again. The hosted client drives this off the `sending` flag, which is
    // reset in the chat finally{} block; this proves it in a real browser, where
    // jsdom-blind state bugs surface.
    const page = await openWidget(PRODUCT_ID);
    await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });

    await page.fill("[data-ai-sdr-input]", "Tell me what this does, then stop cleanly.");
    await page.click("[data-ai-sdr-send]");

    // Wait for the answer to fully render.
    await page.waitForFunction(
      (expected) =>
        Array.from(
          document.querySelectorAll('[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]'),
        ).some((b) => (b.textContent ?? "").includes(expected)),
      MOCK_CONTENT,
      { timeout: 15_000 },
    );

    // After settle the stop control must be fully retracted: no data-visible, not
    // clickable (computed pointer-events none), aria-hidden true, inert present.
    await page.waitForFunction(
      () => {
        const stop = document.querySelector("[data-ai-sdr-stop-generating]");
        if (stop === null) return true; // not rendered at all is acceptable
        const hasVisible = stop.hasAttribute("data-visible");
        const pe = getComputedStyle(stop).pointerEvents;
        const ariaHidden = stop.getAttribute("aria-hidden");
        const inert = stop.hasAttribute("inert");
        return !hasVisible && pe === "none" && ariaHidden === "true" && inert;
      },
      undefined,
      { timeout: 10_000 },
    );

    // The composer must be interactive again: a fresh message can be typed and the
    // send button re-enables (proving `sending` was cleared).
    await page.fill("[data-ai-sdr-input]", "A second question after the first settled.");
    await page.waitForFunction(
      () => {
        const send = document.querySelector("[data-ai-sdr-send]");
        return send !== null && !send.disabled;
      },
      undefined,
      { timeout: 10_000 },
    );

    await page.close();
  });

  test("returning visitor with an evicted session id recovers transparently and heals storage", async () => {
    // Reproduces the prod "they don't even work" defect end-to-end in a real browser:
    // a returning visitor carries a localStorage session id the worker no longer has,
    // so the first /v1/chat 404s. The hosted client must clear the stale id, mint a
    // fresh session, retry the send once, and render the reply — no dead widget.
    const storageKey = `ventora:ai-sdr:session:${PRODUCT_ID}:anonymous`;

    // First visit: a real session is created and persisted by sending one message.
    const page = await openWidget(PRODUCT_ID);
    await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
    await page.fill("[data-ai-sdr-input]", "First question to establish a session.");
    await page.click("[data-ai-sdr-send]");
    await page.waitForFunction(
      (expected) =>
        Array.from(
          document.querySelectorAll('[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]'),
        ).some((b) => (b.textContent ?? "").includes(expected)),
      MOCK_CONTENT,
      { timeout: 15_000 },
    );
    const realSessionId = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      storageKey,
    );
    assert.ok(
      typeof realSessionId === "string" && realSessionId.length > 0,
      "a real session id should be persisted after the first send",
    );

    // Plant a bogus session id the worker has never issued, then reload so the widget
    // boots and adopts the stale stored id into memory (the returning-visitor path).
    const bogusSessionId = "deadbeef-evicted-session-id";
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [storageKey, bogusSessionId],
    );
    await page.reload();
    await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
      timeout: 15_000,
    });
    await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
    const adopted = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
    assert.equal(adopted, bogusSessionId, "widget should boot carrying the stale stored id");

    const beforeOpenRouter = openRouter?.requests.length ?? 0;

    // Send with the stale id in memory: worker 404s -> client recovers and retries once.
    await page.fill("[data-ai-sdr-input]", "Second question after the session was evicted.");
    await page.click("[data-ai-sdr-send]");
    await page.waitForFunction(
      (expected) =>
        Array.from(
          document.querySelectorAll('[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]'),
        ).some((b) => (b.textContent ?? "").includes(expected)),
      MOCK_CONTENT,
      { timeout: 15_000 },
    );

    // Recovery must have re-minted a fresh session: storage is healed to a new, real id
    // (not the bogus one), and the assistant actually answered (OpenRouter was called).
    const healed = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
    assert.ok(
      typeof healed === "string" && healed.length > 0 && healed !== bogusSessionId,
      `storage should be healed to a fresh session id, got ${String(healed)}`,
    );
    assert.equal(
      openRouter?.requests.length,
      beforeOpenRouter + 1,
      "the recovered send must reach the assistant exactly once",
    );

    await page.close();
  });

  test("offline send is short-circuited (banner, no chat request) and recovers when back online", async () => {
    // Verifies the cycle-1 offline guard in a REAL browser: sendMessageText must
    // gate on navigator.onLine, not just disable the button — so Enter / a
    // programmatic submit while offline shows the banner and fires NO /v1/chat,
    // and a real reply flows once connectivity returns.
    const page = await openWidget(PRODUCT_ID);
    await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });

    const beforeOpenRouter = openRouter?.requests.length ?? 0;

    // Go offline (Playwright sets navigator.onLine=false and fires the offline event).
    await page.context().setOffline(true);
    await page.fill("[data-ai-sdr-input]", "Message typed while the network is down.");
    // Press Enter rather than click: offline disables the send button, but the
    // Enter handler calls sendCurrentMessage() directly — exactly the bypass the
    // cycle-1 offline guard in sendMessageText must still short-circuit.
    await page.press("[data-ai-sdr-input]", "Enter");

    // The offline banner must appear and the send must never reach the worker.
    await page.waitForSelector("[data-ai-sdr-offline-banner]", { timeout: 5_000 });
    assert.equal(
      openRouter?.requests.length,
      beforeOpenRouter,
      "no chat request may be sent while offline",
    );

    // Back online: the banner clears and the same message now sends successfully.
    await page.context().setOffline(false);
    await page.waitForFunction(
      () => document.querySelector("[data-ai-sdr-offline-banner]") === null,
      undefined,
      { timeout: 5_000 },
    );
    // The composer still holds the un-sent text (the offline guard returns before
    // clearing it). Re-fire the input event so updateSendState re-enables the
    // button now that we are online, then submit via Enter — robust to any lag in
    // the button's disabled state settling after the online event.
    await page.fill("[data-ai-sdr-input]", "Message typed while the network is down.");
    await page.press("[data-ai-sdr-input]", "Enter");
    await page.waitForFunction(
      (expected) =>
        Array.from(
          document.querySelectorAll('[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]'),
        ).some((b) => (b.textContent ?? "").includes(expected)),
      MOCK_CONTENT,
      { timeout: 15_000 },
    );
    assert.equal(
      openRouter?.requests.length,
      beforeOpenRouter + 1,
      "exactly one chat request should reach the worker after coming back online",
    );

    await page.close();
  });

  test("per-brand theming: each product resolves its preset accent via getComputedStyle", async () => {
    /** @type {Record<string, string>} */
    const accents = {};
    for (const productId of Object.keys(EXPECTED_ACCENTS)) {
      const page = await openWidget(productId);
      const accent = await page.evaluate(() => {
        const root = document.querySelector("[data-ai-sdr-widget]");
        if (root === null) return "";
        return getComputedStyle(root).getPropertyValue("--ai-sdr-accent").trim().toLowerCase();
      });
      assert.match(accent, /^#[0-9a-f]{6}$/, `${productId} accent should be a 6-digit hex`);
      assert.equal(
        accent,
        EXPECTED_ACCENTS[productId],
        `${productId} accent should match its brand preset`,
      );
      accents[productId] = accent;
      await page.close();
    }

    // Every shipped product must resolve to a distinct accent — no product may
    // silently clone another's palette (the camaudit/grantpipe collision that
    // shipped in the importable widget table).
    const resolved = Object.values(accents);
    const unique = new Set(resolved);
    assert.equal(
      unique.size,
      resolved.length,
      `distinct products must resolve to distinct accents, got ${JSON.stringify(accents)}`,
    );
  });
});

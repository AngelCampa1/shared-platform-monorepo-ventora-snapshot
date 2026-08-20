#!/usr/bin/env node
/**
 * AI-CS browser-layer E2E (X7.2(b) Playwright slice — the final cross-repo slice).
 *
 * Drives the REAL `@ventora/ai-cs/react` widget inside a REAL Chromium browser,
 * through a same-origin signing BFF proxy, against the locally-booted ai-cs-worker
 * plus deterministic mock OpenRouter and signed mock context:
 *
 *   chromium (real DOM, real fetch, real SSE reader)
 *     -> page http://127.0.0.1:<ephemeral>  (BFF: HTML + esbuild-bundled widget)
 *     -> widget POST /api/ai-cs/v1/sessions  -> BFF signs -> ai-cs-worker (201)
 *     -> widget POST /api/ai-cs/v1/chat       -> BFF signs -> ai-cs-worker
 *           -> fetchSignedAppContext -> mock-context (signed round-trip)
 *           -> callOpenRouter        -> mock-openrouter (canned completion)
 *           -> SSE streamed back through the BFF to the browser
 *     -> assistant bubble renders the canned content in the live DOM
 *
 * Unlike the jsdom theming slice, this asserts per-brand theming via REAL
 * `getComputedStyle` on the mounted `[data-aics-root]`, and verifies the full
 * session -> chat(SSE) -> render round-trip end to end in a browser engine.
 *
 * This is the in-browser, non-smoke verification the goal mandates for the shared
 * AI-CS runtime, including that the widget "adapts to the branding of each app".
 *
 * Run:  pnpm run test:e2e:browser
 *       E2E_NO_BUILD=1 pnpm run test:e2e:browser   (skip the worker dep build)
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { startBrowserBff } from "./browser-bff.mjs";
import { startMockContext } from "./mock-context.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";

/** appId for the chat round-trip; the mock context echoes any appId it is asked for. */
const APP_ID = "lextract";
const APP_NAME = "Lextract";
const CONTEXT_SECRET = "e2e-harness-context-secret";
const OPENROUTER_KEY = "e2e-openrouter-key";
const MOCK_CONTENT = "Hello from the mock assistant via the browser E2E.";
const NAV = [{ label: "Open billing", path: "/billing", description: "Manage your subscription" }];

/** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
let harness;
/** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
let openRouter;
/** @type {Awaited<ReturnType<typeof startMockContext>> | undefined} */
let context;
/** @type {Awaited<ReturnType<typeof startBrowserBff>> | undefined} */
let bff;
/** @type {import("playwright").Browser | undefined} */
let browser;

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
  bff = await startBrowserBff({ aiCsBaseUrl: harness.workers.aiCs.baseUrl });
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
 * Open a fresh page at the given brand and wait for the widget to mount.
 * @param {string} brandId
 * @returns {Promise<import("playwright").Page>}
 */
async function openWidget(brandId) {
  assert.ok(browser && bff, "browser/bff not booted");
  const page = await browser.newPage();
  await page.goto(`${bff.url}/?brand=${encodeURIComponent(brandId)}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__WIDGET_READY__ === true);
  await page.waitForSelector("[data-aics-root]");
  return page;
}

describe("ai-cs widget in a real browser (signing BFF + booted worker)", () => {
  test("session -> chat(SSE) -> render: assistant bubble shows the canned completion", async () => {
    const page = await openWidget(APP_ID);
    try {
      const beforeUpstream = openRouter?.requests.length ?? 0;

      await page.waitForSelector("[data-aics-composer] textarea");
      await page.fill("[data-aics-composer] textarea", "How do I manage my billing subscription?");
      await page.click("[data-aics-send]");

      // Wait until the assistant bubble in the live DOM carries the streamed content.
      await page.waitForFunction(
        (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return bubble?.textContent?.includes(expected) ?? false;
        },
        MOCK_CONTENT,
        { timeout: 15_000 },
      );

      const bubbleText = await page.textContent('[data-aics-bubble][data-aics-role="assistant"]');
      assert.ok(
        bubbleText?.includes(MOCK_CONTENT),
        `assistant bubble should render the canned content, got: ${bubbleText}`,
      );

      // The browser round-trip actually reached the upstream LLM through the worker.
      assert.equal(openRouter?.requests.length, beforeUpstream + 1);

      // The signed app-context round-trip happened and verified for this appId.
      assert.ok((context?.requests.length ?? 0) >= 1, "context endpoint should have been called");
      assert.ok(
        context?.requests.every((r) => r.verified),
        "every context request must pass HMAC verification",
      );
      assert.equal(context?.requests.at(-1)?.searchParams.get("appId"), APP_ID);
    } finally {
      await page.close();
    }
  });

  test("upstream 502 shows friendly copy (never a raw error code) and Retry recovers", async () => {
    // Verifies the cycle-2 ai-cs error-classification in a REAL browser: when the
    // worker returns 502 app_context_unavailable, the widget must show the mapped
    // friendly banner (errorUnavailable) — never the raw "app_context_unavailable"
    // / backend code / status number — and the in-banner Retry must recover once
    // the upstream is healthy again.
    const page = await openWidget(APP_ID);
    try {
      await page.waitForSelector("[data-aics-composer] textarea");
      const beforeUpstream = openRouter?.requests.length ?? 0;

      // Force exactly one signed-context fetch to fail -> worker returns 502.
      assert.ok(context, "context mock not booted");
      context.control.failNext = 1;

      await page.fill("[data-aics-composer] textarea", "How do I export my data?");
      await page.click("[data-aics-send]");

      // The error banner must appear with the mapped friendly copy.
      const banner = await page.waitForSelector('[data-aics-banner][data-aics-status="error"]', {
        timeout: 10_000,
      });
      const bannerText = (await banner.textContent()) ?? "";
      assert.ok(
        bannerText.includes("Chat is unavailable right now"),
        `banner should show the friendly errorUnavailable copy, got: ${bannerText}`,
      );
      // Crucially, no raw protocol/backend detail may leak to the user.
      for (const leak of ["app_context_unavailable", "context_backend_down", "502", "Error:"]) {
        assert.ok(
          !bannerText.includes(leak),
          `banner must not leak raw detail "${leak}", got: ${bannerText}`,
        );
      }
      // No upstream LLM call happened on the failed turn (it died at context fetch).
      assert.equal(openRouter?.requests.length, beforeUpstream);

      // Retry resends the same message; context is healthy now.
      await page.click(
        "[data-aics-retry-inline], [data-aics-banner-action], [data-aics-retry-btn]",
      );
      await page.waitForFunction(
        (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return bubble?.textContent?.includes(expected) ?? false;
        },
        MOCK_CONTENT,
        { timeout: 15_000 },
      );
      assert.equal(
        openRouter?.requests.length,
        beforeUpstream + 1,
        "exactly one upstream call should land after a successful retry",
      );
    } finally {
      await page.close();
    }
  });

  test("per-brand theming: real getComputedStyle accent matches the resolved palette and differs across brands", async () => {
    /** @type {Record<string, string>} */
    const accents = {};
    for (const brandId of [
      "lextract",
      "camaudit",
      "capveri",
      "grantpipe",
      "lextract",
      "grantpipe",
      "camaudit",
    ]) {
      const page = await openWidget(brandId);
      try {
        const { computed, resolved } = await page.evaluate(() => {
          const root = document.querySelector("[data-aics-root]");
          const computedAccent = root
            ? getComputedStyle(root).getPropertyValue("--aics-accent").trim()
            : "";
          return {
            computed: computedAccent,
            resolved: window.__RESOLVED_BRAND__?.accentColor ?? "",
          };
        });

        assert.match(computed, /^#[0-9a-fA-F]{6}$/, `${brandId} accent should be a 6-digit hex`);
        assert.equal(
          computed.toLowerCase(),
          resolved.toLowerCase(),
          `${brandId} computed accent must equal the package-resolved palette`,
        );
        accents[brandId] = computed.toLowerCase();
      } finally {
        await page.close();
      }
    }

    // Every shipped brand must yield a distinct computed accent — real per-brand
    // theming, no brand silently sharing another's palette.
    const computedAccents = Object.values(accents);
    const uniqueAccents = new Set(computedAccents);
    assert.equal(
      uniqueAccents.size,
      computedAccents.length,
      `distinct brands must yield distinct computed accents, got ${JSON.stringify(accents)}`,
    );
  });
});

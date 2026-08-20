#!/usr/bin/env node
/**
 * Settled screenshot capture — re-captures the "answered" state for AI-CS and
 * AI-SDR (lextract, desktop 1440x900) after the stream fully settles.
 *
 * For AI-CS: waits for [data-aics-stop] to detach AND [data-aics-composer] to
 *   be visible, then pauses 400 ms before screenshotting.
 * For AI-SDR: waits for [data-ai-sdr-stop-generating] to lose [data-visible]
 *   (stream done, stop button hidden), then pauses 400 ms.
 *
 * Also runs a DOM-evaluation pass after the settled AI-SDR screenshot to
 * diagnose any dark-red/maroon bar sitting between the sources list and the
 * composer.
 *
 * Run:
 *   node scripts/e2e/settled-screenshots.mjs
 *   E2E_NO_BUILD=1 node scripts/e2e/settled-screenshots.mjs
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { startBrowserBff } from "./browser-bff.mjs";
import { startSdrBrowserBff } from "./browser-sdr-bff.mjs";
import { startMockContext } from "./mock-context.mjs";
import { startMockOpenRouter } from "./mock-openrouter.mjs";
import { startMockProductContext } from "./mock-product-context.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = resolve(__dirname, "..", "..");
const OUT_DIR = resolve(WORKTREE_ROOT, "output", "shots");

const CS_CONTEXT_SECRET = "e2e-harness-context-secret";
const SDR_CONTEXT_SECRET = "e2e-harness-sdr-context-secret";
const OPENROUTER_KEY = "e2e-openrouter-key";

const CS_MOCK_CONTENT =
  "To add a new board member, open Settings, then choose Members. Click 'Invite member', type their email, pick a role, and send. They'll get an email to join.";

const SDR_MOCK_CONTENT =
  "Lextract helps your team pull facts from files. Upload a document. Check the key fields. Send clean data to your app. It cuts manual review and helps catch missing details.";

const DESKTOP = { label: "desktop", width: 1440, height: 900 };

/** @type {string[]} */
const written = [];

async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

/**
 * @param {import("playwright").Page} page
 * @param {string} name
 */
async function shot(page, name) {
  const filePath = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  written.push(filePath);
  console.info(`  saved: ${filePath}`);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-CS settled screenshot
// ─────────────────────────────────────────────────────────────────────────────

async function captureAiCsSettled() {
  /** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
  let openRouter;
  /** @type {Awaited<ReturnType<typeof startMockContext>> | undefined} */
  let ctxMock;
  /** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
  let harness;
  /** @type {Awaited<ReturnType<typeof startBrowserBff>> | undefined} */
  let bff;
  /** @type {import("playwright").Browser | undefined} */
  let browser;

  try {
    openRouter = await startMockOpenRouter({ content: CS_MOCK_CONTENT });
    ctxMock = await startMockContext({
      secret: CS_CONTEXT_SECRET,
      appId: "lextract",
      appName: "Lextract",
      navigation: [
        { label: "Open billing", path: "/billing", description: "Manage your subscription" },
      ],
    });
    harness = await startE2eWorkers({
      build: process.env.E2E_NO_BUILD !== "1",
      extraVars: {
        aiCs: [
          `OPENROUTER_ENDPOINT:${openRouter.url}`,
          `OPENROUTER_API_KEY:${OPENROUTER_KEY}`,
          `AI_CS_CONTEXT_ENDPOINT:${ctxMock.url}`,
          `AI_CS_CONTEXT_SECRET:${CS_CONTEXT_SECRET}`,
        ],
      },
    });
    bff = await startBrowserBff({ aiCsBaseUrl: harness.workers.aiCs.baseUrl });
    browser = await chromium.launch({ headless: true });

    const ctx = await browser.newContext({
      viewport: { width: DESKTOP.width, height: DESKTOP.height },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${bff.url}/?brand=lextract`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
        timeout: 20_000,
      });
      await page.waitForSelector("[data-aics-root]", { timeout: 10_000 });

      // Open panel if not already open
      const alreadyOpen = await page.evaluate(() => {
        const launcher = document.querySelector("[data-aics-launcher]");
        if (launcher?.getAttribute("aria-expanded") === "true") return true;
        return document.querySelector("[data-aics-panel]") !== null;
      });
      if (!alreadyOpen) {
        const hasLauncher = (await page.$("[data-aics-launcher]")) !== null;
        if (hasLauncher) await page.click("[data-aics-launcher]");
      }
      await page.waitForSelector("[data-aics-composer] textarea", { timeout: 10_000 });

      // Type and send question
      await page.fill("[data-aics-composer] textarea", "How do I add a new board member?");
      await page.click("[data-aics-send]");

      // Wait for full answer text to appear
      await page.waitForFunction(
        /** @param {string} expected */ (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return (bubble?.textContent ?? "").includes(expected);
        },
        CS_MOCK_CONTENT,
        { timeout: 20_000 },
      );

      // Wait for stop button to detach (stream fully done)
      await page
        .waitForSelector("[data-aics-stop]", { state: "detached", timeout: 10_000 })
        .catch(() => {
          // stop button may never have been attached in some builds — that is fine
        });

      // Wait for composer to be visible and interactive
      await page.waitForSelector("[data-aics-composer]", { state: "visible", timeout: 10_000 });

      // 400 ms settle pause
      await page.waitForTimeout(400);

      await shot(page, "ai-cs-lextract-d-settled-desktop");
    } finally {
      await page.close();
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await bff?.close();
    harness?.stop();
    await openRouter?.close();
    await ctxMock?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-SDR settled screenshot + red-bar diagnosis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   tagName: string,
 *   dataAttrs: Record<string, string>,
 *   className: string,
 *   outerHTML: string,
 *   computedBg: string,
 *   computedHeight: string,
 * }} RedBarInfo
 */

async function captureAiSdrSettled() {
  /** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
  let openRouter;
  /** @type {Awaited<ReturnType<typeof startMockProductContext>> | undefined} */
  let ctxMock;
  /** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
  let harness;
  /** @type {Awaited<ReturnType<typeof startSdrBrowserBff>> | undefined} */
  let bff;
  /** @type {import("playwright").Browser | undefined} */
  let browser;

  const product = {
    productId: "lextract",
    name: "Lextract",
    sources: [
      {
        title: "Lextract overview",
        excerpt: "Pull facts from files",
        url: "https://example.com/lextract",
      },
    ],
  };

  try {
    openRouter = await startMockOpenRouter({ content: SDR_MOCK_CONTENT });
    ctxMock = await startMockProductContext({ secret: SDR_CONTEXT_SECRET, product });
    harness = await startE2eWorkers({
      build: process.env.E2E_NO_BUILD !== "1",
      extraVars: {
        aiSdr: [
          `OPENROUTER_ENDPOINT:${openRouter.url}`,
          `OPENROUTER_API_KEY:${OPENROUTER_KEY}`,
          `AI_SDR_CONTEXT_ENDPOINT:${ctxMock.url}`,
          `AI_SDR_CONTEXT_SECRET:${SDR_CONTEXT_SECRET}`,
        ],
      },
    });
    bff = await startSdrBrowserBff({ aiSdrBaseUrl: harness.workers.aiSdr.baseUrl });
    browser = await chromium.launch({ headless: true });

    const ctx = await browser.newContext({
      viewport: { width: DESKTOP.width, height: DESKTOP.height },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${bff.url}/?product=lextract`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
        timeout: 20_000,
      });
      const initErr = await page.evaluate(() => window.__WIDGET_ERROR__);
      if (initErr) throw new Error(`AI-SDR widget init error for lextract: ${String(initErr)}`);
      await page.waitForSelector("[data-ai-sdr-widget]", { timeout: 15_000 });
      await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });

      // Type and send
      await page.fill("[data-ai-sdr-input]", "What does this product do for my team?");
      await page.click("[data-ai-sdr-send]");

      // Wait for full answer text
      await page.waitForFunction(
        /** @param {string} expected */ (expected) => {
          const bubbles = document.querySelectorAll(
            '[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]',
          );
          return Array.from(bubbles).some((b) => (b.textContent ?? "").includes(expected));
        },
        SDR_MOCK_CONTENT,
        { timeout: 20_000 },
      );

      // Wait for the stop-generating button to lose data-visible (stream done)
      await page.waitForFunction(
        () => {
          const stop = document.querySelector("[data-ai-sdr-stop-generating]");
          if (stop === null) return true;
          return !("visible" in stop.dataset);
        },
        undefined,
        { timeout: 15_000 },
      );

      // 400 ms settle pause
      await page.waitForTimeout(400);

      await shot(page, "ai-sdr-lextract-c-settled-desktop");

      // ── Red-bar diagnosis ────────────────────────────────────────────────────
      console.info("\n=== Red-bar diagnosis ===");

      /** @type {RedBarInfo | null} */
      const diagnosis = await page.evaluate(() => {
        const panel = document.querySelector("[data-ai-sdr-panel]");
        if (panel === null) return null;

        /** @param {string} color */
        function isReddish(color) {
          // Match rgb(r,g,b) where r is significantly higher than g and b, and r > 80
          const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color.trim());
          if (m === null) return false;
          const r = Number(m[1]);
          const g = Number(m[2]);
          const b = Number(m[3]);
          return r > 80 && r > g * 1.8 && r > b * 1.8;
        }

        // Walk every element inside the panel and look for one with a reddish
        // computed background-color AND non-trivial height (> 2 px).
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT);
        /** @type {Element | null} */
        let node = walker.nextNode();
        while (node !== null) {
          if (!(node instanceof HTMLElement)) {
            node = walker.nextNode();
            continue;
          }
          const cs = getComputedStyle(node);
          const bg = cs.backgroundColor;
          const height = node.getBoundingClientRect().height;
          if (isReddish(bg) && height > 2) {
            /** @type {Record<string, string>} */
            const dataAttrs = {};
            for (const attr of Array.from(node.attributes)) {
              if (attr.name.startsWith("data-")) dataAttrs[attr.name] = attr.value;
            }
            return {
              tagName: node.tagName.toLowerCase(),
              dataAttrs,
              className: node.className,
              outerHTML: node.outerHTML.slice(0, 300),
              computedBg: bg,
              computedHeight: `${height}px`,
            };
          }
          node = walker.nextNode();
        }
        return null;
      });

      if (diagnosis === null) {
        console.info("  No reddish element found in the panel at settled state.");
      } else {
        console.info("  tagName:", diagnosis.tagName);
        console.info("  data-* attrs:", JSON.stringify(diagnosis.dataAttrs, null, 2));
        console.info("  className:", diagnosis.className || "(none)");
        console.info("  outerHTML (truncated):", diagnosis.outerHTML);
        console.info("  computed background-color:", diagnosis.computedBg);
        console.info("  computed height:", diagnosis.computedHeight);
      }
    } finally {
      await page.close();
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await bff?.close();
    harness?.stop();
    await openRouter?.close();
    await ctxMock?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await ensureOutDir();

  console.info("=== AI-CS settled screenshot ===");
  await captureAiCsSettled();

  console.info("\n=== AI-SDR settled screenshot ===");
  await captureAiSdrSettled();

  console.info("\n=== Written PNGs ===");
  for (const p of written) {
    console.info(p);
  }
}

main().catch((err) => {
  console.error("settled-screenshots.mjs failed:", err);
  process.exit(1);
});

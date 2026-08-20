#!/usr/bin/env node
/**
 * Visual screenshot capture for the two shared chat widgets (AI-CS + AI-SDR).
 *
 * Boots the E2E harness with mocks, drives a real Chromium browser through each
 * key UI state, and saves viewport PNGs for desktop (1440x900) and mobile (390x844).
 *
 * Run:  node scripts/e2e/screenshots.mjs
 *       E2E_NO_BUILD=1 node scripts/e2e/screenshots.mjs   (skip dep build)
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

// ── secrets (same as the E2E test harnesses) ─────────────────────────────────
const CS_CONTEXT_SECRET = "e2e-harness-context-secret";
const SDR_CONTEXT_SECRET = "e2e-harness-sdr-context-secret";
const OPENROUTER_KEY = "e2e-openrouter-key";

// ── mock content ─────────────────────────────────────────────────────────────
const CS_MOCK_CONTENT =
  "To add a new board member, open Settings, then choose Members. Click 'Invite member', type their email, pick a role, and send. They'll get an email to join.";

const SDR_MOCK_CONTENT =
  "Lextract helps your team pull facts from files. Upload a document. Check the key fields. Send clean data to your app. It cuts manual review and helps catch missing details.";

// ── viewport sizes ────────────────────────────────────────────────────────────
/** @type {Array<{ label: string, width: number, height: number }>} */
const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
];

/** @type {string[]} */
const written = [];

/**
 * Ensure the output directory exists.
 * @returns {Promise<void>}
 */
async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

/**
 * Save a screenshot and record the path.
 * @param {import("playwright").Page} page
 * @param {string} name  filename without extension, relative to OUT_DIR
 * @returns {Promise<string>}
 */
async function shot(page, name) {
  const filePath = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  written.push(filePath);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-CS screenshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture AI-CS states for a given brand + viewport.
 *
 * States captured:
 *   (a) initial mounted state (closed launcher)
 *   (b) panel opened / empty
 *   (c) question typed in composer (before send)
 *   (d) assistant answer fully rendered
 *
 * For brands other than lextract only state (d) is captured (themed answer).
 *
 * @param {import("playwright").Browser} browser
 * @param {string} bffUrl
 * @param {string} brand
 * @param {{ label: string, width: number, height: number }} viewport
 * @param {boolean} fullFlow  whether to capture all four states
 */
async function captureAiCs(browser, bffUrl, brand, viewport, fullFlow) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${bffUrl}/?brand=${encodeURIComponent(brand)}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
      timeout: 20_000,
    });
    await page.waitForSelector("[data-aics-root]", { timeout: 10_000 });

    /**
     * Returns true if the panel is already open (launcher aria-expanded=true or
     * the panel element is already in the DOM).
     */
    const isPanelOpen = async () => {
      return page.evaluate(() => {
        const launcher = document.querySelector("[data-aics-launcher]");
        if (launcher && launcher.getAttribute("aria-expanded") === "true") return true;
        return document.querySelector("[data-aics-panel]") !== null;
      });
    };

    /**
     * Open the panel if not already open, then wait for the composer textarea.
     */
    const ensurePanelOpen = async () => {
      const alreadyOpen = await isPanelOpen();
      if (!alreadyOpen) {
        const launcherSel = "[data-aics-launcher]";
        const hasLauncher = (await page.$(launcherSel)) !== null;
        if (hasLauncher) await page.click(launcherSel);
      }
      await page.waitForSelector("[data-aics-composer] textarea", { timeout: 10_000 });
    };

    if (fullFlow) {
      // (a) initial: launcher visible; panel may already be open in some builds
      await shot(page, `ai-cs-${brand}-a-initial-${viewport.label}`);

      // (b) ensure panel open, screenshot empty composer
      await ensurePanelOpen();
      await shot(page, `ai-cs-${brand}-b-panel-open-${viewport.label}`);

      // (c) type a question
      await page.fill("[data-aics-composer] textarea", "How do I add a new board member?");
      await shot(page, `ai-cs-${brand}-c-typed-${viewport.label}`);

      // (d) send and wait for assistant bubble
      await page.click("[data-aics-send]");
      await page.waitForFunction(
        /** @param {string} expected */ (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return (bubble?.textContent ?? "").includes(expected);
        },
        CS_MOCK_CONTENT,
        { timeout: 20_000 },
      );
      await shot(page, `ai-cs-${brand}-d-answered-${viewport.label}`);
    } else {
      // For theming-only brands: open panel and get to answered state directly
      await ensurePanelOpen();
      await page.fill("[data-aics-composer] textarea", "How do I get started?");
      await page.click("[data-aics-send]");
      await page.waitForFunction(
        /** @param {string} expected */ (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return (bubble?.textContent ?? "").includes(expected);
        },
        CS_MOCK_CONTENT,
        { timeout: 20_000 },
      );
      await shot(page, `ai-cs-${brand}-d-answered-${viewport.label}`);
    }
  } finally {
    await page.close();
    await ctx.close();
  }
}

/**
 * Run all AI-CS captures.
 * @returns {Promise<void>}
 */
async function runAiCsCaptures() {
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

    // lextract: full four-state flow for both viewports
    for (const vp of VIEWPORTS) {
      await captureAiCs(browser, bff.url, "lextract", vp, true);
    }

    // lextract + camaudit: answered state only (theming check), desktop + mobile
    for (const brand of ["lextract", "camaudit"]) {
      for (const vp of VIEWPORTS) {
        await captureAiCs(browser, bff.url, brand, vp, false);
      }
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
// AI-SDR screenshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture AI-SDR states for a given brand + viewport.
 *
 * The SDR widget uses autoOpen so the panel is already visible on load.
 *
 * States captured (fullFlow):
 *   (a) initial: panel open, composer empty (autoOpen)
 *   (b) question typed (before send)
 *   (c) assistant answer fully rendered
 *
 * For brands other than lextract only state (c) is captured.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} bffUrl
 * @param {string} product
 * @param {{ label: string, width: number, height: number }} viewport
 * @param {boolean} fullFlow
 */
async function captureAiSdr(browser, bffUrl, product, viewport, fullFlow) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${bffUrl}/?product=${encodeURIComponent(product)}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
      timeout: 20_000,
    });
    const initErr = await page.evaluate(() => window.__WIDGET_ERROR__);
    if (initErr) throw new Error(`AI-SDR widget init error for ${product}: ${String(initErr)}`);
    await page.waitForSelector("[data-ai-sdr-widget]", { timeout: 15_000 });

    if (fullFlow) {
      // (a) panel open, empty (autoOpen means panel already visible)
      await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
      await shot(page, `ai-sdr-${product}-a-initial-${viewport.label}`);

      // (b) type a question
      await page.fill("[data-ai-sdr-input]", "What does this product do for my team?");
      await shot(page, `ai-sdr-${product}-b-typed-${viewport.label}`);

      // (c) send and wait for assistant bubble
      await page.click("[data-ai-sdr-send]");
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
      await shot(page, `ai-sdr-${product}-c-answered-${viewport.label}`);
    } else {
      await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
      await page.fill("[data-ai-sdr-input]", "Tell me about this product.");
      await page.click("[data-ai-sdr-send]");
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
      await shot(page, `ai-sdr-${product}-c-answered-${viewport.label}`);
    }
  } finally {
    await page.close();
    await ctx.close();
  }
}

/**
 * Boot an AI-SDR harness for a single product, capture screenshots, then tear down.
 *
 * @param {import("playwright").Browser} browser
 * @param {{ productId: string, name: string, fullFlow: boolean }} opts
 */
async function runAiSdrForProduct(browser, { productId, name, fullFlow }) {
  /** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
  let openRouter;
  /** @type {Awaited<ReturnType<typeof startMockProductContext>> | undefined} */
  let ctxMock;
  /** @type {import("./boot-e2e-workers.mjs").E2eWorkers | undefined} */
  let harness;
  /** @type {Awaited<ReturnType<typeof startSdrBrowserBff>> | undefined} */
  let bff;

  const product = {
    productId,
    name,
    sources: [
      {
        title: `${name} overview`,
        excerpt: `${name} workspace for teams`,
        url: `https://example.com/${productId}`,
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

    for (const vp of VIEWPORTS) {
      await captureAiSdr(browser, bff.url, productId, vp, fullFlow);
    }
  } finally {
    await bff?.close();
    harness?.stop();
    await openRouter?.close();
    await ctxMock?.close();
  }
}

/**
 * Run all AI-SDR captures.
 * @returns {Promise<void>}
 */
async function runAiSdrCaptures() {
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    // lextract: full three-state flow
    await runAiSdrForProduct(browser, {
      productId: "lextract",
      name: "Lextract",
      fullFlow: true,
    });
    // lextract: answered state only (theming check)
    await runAiSdrForProduct(browser, { productId: "lextract", name: "Lextract", fullFlow: false });
  } finally {
    await browser?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dark-brand screenshot captures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture the AI-CS dark-brand answered state at desktop viewport.
 * Navigates with `?brand=lextract&dark=1` so the widget entry applies the
 * dark palette overrides, then drives to the answered state.
 * @returns {Promise<void>}
 */
async function runAiCsDarkBrandCapture() {
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

    const vp = { label: "desktop", width: 1440, height: 900 };
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${bff.url}/?brand=lextract&dark=1`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
        timeout: 20_000,
      });
      await page.waitForSelector("[data-aics-root]", { timeout: 10_000 });

      const isPanelOpen = async () =>
        page.evaluate(() => {
          const launcher = document.querySelector("[data-aics-launcher]");
          if (launcher && launcher.getAttribute("aria-expanded") === "true") return true;
          return document.querySelector("[data-aics-panel]") !== null;
        });

      const alreadyOpen = await isPanelOpen();
      if (!alreadyOpen) {
        const launcherSel = "[data-aics-launcher]";
        const hasLauncher = (await page.$(launcherSel)) !== null;
        if (hasLauncher) await page.click(launcherSel);
      }
      await page.waitForSelector("[data-aics-composer] textarea", { timeout: 10_000 });
      await page.fill("[data-aics-composer] textarea", "How do I get started?");
      await page.click("[data-aics-send]");
      await page.waitForFunction(
        /** @param {string} expected */ (expected) => {
          const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
          return (bubble?.textContent ?? "").includes(expected);
        },
        CS_MOCK_CONTENT,
        { timeout: 20_000 },
      );
      await shot(page, `ai-cs-darkbrand-d-answered-${vp.label}`);
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

/**
 * Capture the AI-SDR dark-brand answered state at desktop viewport.
 * Appends `?product=lextract&dark=1` so the HTML shell applies the dark palette.
 * @returns {Promise<void>}
 */
async function runAiSdrDarkBrandCapture() {
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

    const vp = { label: "desktop", width: 1440, height: 900 };
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${bff.url}/?product=lextract&dark=1`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
        timeout: 20_000,
      });
      const initErr = await page.evaluate(() => window.__WIDGET_ERROR__);
      if (initErr) throw new Error(`AI-SDR dark-brand widget init error: ${String(initErr)}`);
      await page.waitForSelector("[data-ai-sdr-widget]", { timeout: 15_000 });
      await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
      await page.fill("[data-ai-sdr-input]", "Tell me about this product.");
      await page.click("[data-ai-sdr-send]");
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
      await shot(page, `ai-sdr-darkbrand-d-answered-${vp.label}`);
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

  console.info("=== AI-CS captures ===");
  await runAiCsCaptures();

  console.info("=== AI-SDR captures ===");
  await runAiSdrCaptures();

  console.info("=== AI-CS dark-brand capture ===");
  await runAiCsDarkBrandCapture();

  console.info("=== AI-SDR dark-brand capture ===");
  await runAiSdrDarkBrandCapture();

  console.info("\n=== Written PNGs ===");
  for (const p of written) {
    console.info(p);
  }
}

main().catch((err) => {
  console.error("screenshots.mjs failed:", err);
  process.exit(1);
});

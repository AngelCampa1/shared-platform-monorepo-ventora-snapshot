#!/usr/bin/env node
/**
 * Publication-quality widget screenshot capture for repo documentation.
 *
 * Unlike `scripts/e2e/screenshots.mjs` (full 1440x900 viewport, captured
 * mid-animation), this script:
 *   1. Renders at `deviceScaleFactor: 2` (retina) for every capture.
 *   2. Crops to the widget element plus ~24px of breathing room instead of
 *      shooting the full viewport, so the PNG has no dead space.
 *   3. Waits for the widget to fully settle (see `settleCs`/`settleSdr`
 *      below, ported from `scripts/e2e/settled-screenshots.mjs`) and
 *      disables CSS animations/transitions immediately before the shot, so
 *      text never appears half-faded.
 *   4. Paints a neutral background behind the widget instead of leaving the
 *      page pure white, so the PNG doesn't look like a floating fragment.
 *
 * It reuses the same E2E harness modules as `scripts/e2e/screenshots.mjs`
 * (boot-e2e-workers, browser-bff, browser-sdr-bff, mock-openrouter,
 * mock-context, mock-product-context) rather than reimplementing any of
 * that plumbing. Everything runs fully mocked against localhost — no real
 * OpenRouter key, no network beyond 127.0.0.1.
 *
 * Run:
 *   node scripts/docs/capture-docs-shots.mjs
 *   E2E_NO_BUILD=1 node scripts/docs/capture-docs-shots.mjs   (skip dep build)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startE2eWorkers } from "../e2e/boot-e2e-workers.mjs";
import { startBrowserBff } from "../e2e/browser-bff.mjs";
import { startSdrBrowserBff } from "../e2e/browser-sdr-bff.mjs";
import { startMockContext } from "../e2e/mock-context.mjs";
import { startMockOpenRouter } from "../e2e/mock-openrouter.mjs";
import { startMockProductContext } from "../e2e/mock-product-context.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = resolve(__dirname, "..", "..");
const OUT_DIR = resolve(WORKTREE_ROOT, "portfolio", "screenshots");

// ── secrets (same dummy values the E2E harness uses everywhere else) ────────
const CS_CONTEXT_SECRET = "e2e-harness-context-secret";
const SDR_CONTEXT_SECRET = "e2e-harness-sdr-context-secret";
const OPENROUTER_KEY = "e2e-openrouter-key";

// ── capture constants ────────────────────────────────────────────────────
const DEVICE_SCALE_FACTOR = 2;
const PADDING_PX = 24;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const LIGHT_BG = "#f1f5f9";
const DARK_BG = "#0b1220";

// The 4-up matrix composition renders at a lower device-scale-factor and a
// narrower grid than the individual widget captures above (which stay at
// full retina quality). This is a deliberate size/quality tradeoff to keep
// `widget-matrix.png` under the repo's asset size budget without adding an
// image-optimizer dependency: fewer total pixels compress the same PNG
// content into a much smaller file while the 4 brand panels and their
// captions stay clearly legible.
const MATRIX_DEVICE_SCALE_FACTOR = 1.5;
const MATRIX_GRID_WIDTH_PX = 820;
const MATRIX_GAP_PX = 20;

const CS_QUESTION = "How do I get started?";
const SDR_QUESTION = "What does this product do for my team?";

/**
 * AI-CS support answers, one per brand. Short, plain, and limited to
 * generic "upload / review / export" product help so nothing here invents a
 * statistic, price, guarantee, or capability that can't be verified. These
 * replace the old `CS_MOCK_CONTENT` ("add a board member via Settings"),
 * which was leftover copy from a product that no longer exists in this
 * portfolio and reads as a mismatch under any other brand's theme.
 * @type {Record<"camaudit" | "capveri" | "grantpipe" | "lextract", string>}
 */
const CS_BRAND_CONTENT = {
  lextract:
    "Upload a file to start. We pull out the key facts for you to check. When it looks right, export the data to your app.",
  camaudit:
    "Upload your lease and the CAM invoice you want to check. We compare the charges to your lease terms and flag anything that looks off. Review each flag, then export your report.",
  capveri:
    "Upload the document you want checked. We compare it to your rules and flag anything that needs a second look. Review each flag, then mark it done.",
  grantpipe:
    "Add a grant and set its due date. We track the date and status so nothing slips by. Check your dashboard to see what needs your attention.",
};

/** Display label for each brand, used as the caption under each matrix panel. */
const CS_BRAND_LABELS = {
  camaudit: "CAMAudit",
  capveri: "CapVeri",
  grantpipe: "GrantPipe",
  lextract: "Lextract",
};

/** Brand loop order for the matrix, matching the spec table. */
const CS_BRANDS = ["camaudit", "capveri", "grantpipe", "lextract"];

/**
 * AI-SDR sales answer for the one product these docs shots use (lextract).
 * Short and plain, no invented numbers/prices/guarantees.
 */
const SDR_CONTENT =
  "Lextract pulls key facts out of your files. Upload a document, check the fields it finds, then send clean data to your app. It cuts down on manual review.";

const SDR_PRODUCT = {
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

/** @type {string[]} */
const written = [];

/**
 * Write a PNG buffer to `portfolio/screenshots/<filename>` and record the path.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function saveBuffer(buffer, filename) {
  const filePath = resolve(OUT_DIR, filename);
  await writeFile(filePath, buffer);
  written.push(filePath);
  console.info(`  wrote: ${filePath}`);
  return filePath;
}

/**
 * Inject the final pre-shot stylesheet: a neutral page background (so the
 * widget doesn't look like it's floating on pure white) and a hard kill of
 * every CSS animation/transition (so nothing is mid-fade in the frame).
 *
 * Applied AFTER the settle wait, immediately before the screenshot — not at
 * page load — because both widgets rely on real `transitionend` events for
 * their own open/close lifecycle (see ai-sdr-worker's `closePanel`, which
 * listens for `transitionend` on the panel). Disabling transitions before
 * that lifecycle runs would strand those listeners; disabling them only for
 * the final frame is safe because by settle time the open/send animations
 * have already completed on their own.
 * @param {import("playwright").Page} page
 * @param {string} background
 * @returns {Promise<void>}
 */
async function applyPreCaptureStyles(page, background) {
  await page.addStyleTag({
    content: `html,body{background:${background} !important;margin:0;}
*,*::before,*::after{animation:none !important;transition:none !important;}`,
  });
}

/**
 * Screenshot the first selector (in priority order) that resolves to a
 * visible element, cropped to its bounding box expanded by `padding` on
 * every side and clamped to the viewport.
 *
 * Design note (padding strategy): the spec allows either injecting CSS
 * padding/box-shadow room around the widget root, or clipping a screenshot
 * to an expanded bounding box. This uses the clip approach: both widgets'
 * root elements are `position:fixed` with children that establish their own
 * independent fixed-position boxes (the AI-CS/AI-SDR panels are NOT laid
 * out inside their root's box model — verified empirically, see below), so
 * adding CSS padding to the root would not reliably wrap the visible panel.
 * Computing the clip from the real rendered bounding box is invariant to
 * that layout quirk and never mutates the widget's own DOM/CSS.
 * @param {import("playwright").Page} page
 * @param {string[]} selectors  tried in order; first visible match wins
 * @param {{ padding?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
async function captureElement(page, selectors, { padding = PADDING_PX } = {}) {
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let box = null;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const candidate = await locator.boundingBox();
    if (candidate !== null && candidate.width > 0 && candidate.height > 0) {
      box = candidate;
      break;
    }
  }
  if (box === null) {
    throw new Error(`captureElement: no visible element for selectors [${selectors.join(", ")}]`);
  }
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error("captureElement: page has no viewport size");
  }
  const x0 = Math.max(0, box.x - padding);
  const y0 = Math.max(0, box.y - padding);
  const x1 = Math.min(viewport.width, box.x + box.width + padding);
  const y1 = Math.min(viewport.height, box.y + box.height + padding);
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return page.screenshot({ clip });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-CS helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The AI-CS root selector per the spec is `[data-aics-root]`, preferring
 * `[data-aics-panel]` when it exists (open panel state) since the panel
 * carries the actual visible content (transcript/composer/escalate button);
 * the bare root only wraps the launcher once the panel is closed/removed.
 */
const CS_SELECTORS = ["[data-aics-panel]", "[data-aics-root]"];

/**
 * Wait for the AI-CS widget to finish mounting.
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
async function waitForCsReady(page) {
  await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
    timeout: 20_000,
  });
  const initErr = await page.evaluate(() => window.__WIDGET_ERROR__);
  if (initErr) throw new Error(`AI-CS widget init error: ${String(initErr)}`);
  // "attached", not the default "visible": the root's own box collapses to
  // zero once the panel is open, because the launcher (its only in-flow
  // child) is `hidden` and the panel is independently `position:fixed` (see
  // the `CS_SELECTORS`/`SDR_SELECTORS` doc comments below) — so the root
  // itself can be legitimately invisible-but-present.
  await page.waitForSelector("[data-aics-root]", { state: "attached", timeout: 10_000 });
}

/**
 * Fill the composer, send, and wait for the AI-CS widget to fully settle:
 * full answer text rendered, the streaming stop control detached, and the
 * composer visible again, then a 400ms pause. Ported from
 * `scripts/e2e/settled-screenshots.mjs` (`captureAiCsSettled`).
 * @param {import("playwright").Page} page
 * @param {string} question
 * @param {string} expectedContent
 * @returns {Promise<void>}
 */
async function sendCsMessageAndSettle(page, question, expectedContent) {
  await page.waitForSelector("[data-aics-composer] textarea", { timeout: 10_000 });
  await page.fill("[data-aics-composer] textarea", question);
  await page.click("[data-aics-send]");
  await page.waitForFunction(
    /** @param {string} expected */ (expected) => {
      const bubble = document.querySelector('[data-aics-bubble][data-aics-role="assistant"]');
      return (bubble?.textContent ?? "").includes(expected);
    },
    expectedContent,
    { timeout: 20_000 },
  );
  await page
    .waitForSelector("[data-aics-stop]", { state: "detached", timeout: 10_000 })
    .catch(() => {
      // stop control may never have attached in some builds — that's fine
    });
  await page.waitForSelector("[data-aics-composer]", { state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400);
}

/**
 * Capture a single AI-CS "answered" panel for the given brand/appId pair and
 * viewport, returning the PNG buffer (not written to disk by this helper).
 *
 * `brand` drives only the client-side visual theme (`AiCs.init({ brand })`);
 * the backend `appId` used for session/context/chat is always forced to
 * "lextract" via the `app=` query param the BFF's HTML shell reads
 * independently of `brand`. This is required, not cosmetic: the harness's
 * signing BFF (`scripts/e2e/browser-bff.mjs`) hardcodes the chat/escalation
 * request body's `appId` to `"lextract"` regardless of the page's brand, so
 * the session must also be created with `appId=lextract` or the worker's
 * `requestMatchesSessionOwner` check rejects the chat call with 401 (client
 * sees a 502). Decoupling brand (theme) from appId (backend identity) sidesteps
 * that mismatch while still exercising every brand's real color palette.
 * @param {import("playwright").Browser} browser
 * @param {string} bffUrl
 * @param {string} brand
 * @param {{ width: number, height: number }} viewport
 * @param {string} content
 * @returns {Promise<Buffer>}
 */
async function captureCsAnsweredPanel(browser, bffUrl, brand, viewport, content) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${bffUrl}/?brand=${encodeURIComponent(brand)}&app=lextract`, {
      waitUntil: "load",
    });
    await waitForCsReady(page);
    await sendCsMessageAndSettle(page, CS_QUESTION, content);
    await applyPreCaptureStyles(page, LIGHT_BG);
    return await captureElement(page, CS_SELECTORS, { padding: PADDING_PX });
  } finally {
    await page.close();
    await ctx.close();
  }
}

/**
 * Capture the AI-CS closed-launcher state: navigate, let the widget open
 * automatically (the BFF's shell calls `widget.open()`), then close it via
 * the widget's own public API so the panel unmounts and only the launcher
 * button remains — the "closed" state a fresh page never actually starts in
 * on this harness.
 * @param {import("playwright").Browser} browser
 * @param {string} bffUrl
 * @param {string} brand
 * @returns {Promise<void>}
 */
async function captureCsLauncher(browser, bffUrl, brand) {
  const ctx = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${bffUrl}/?brand=${encodeURIComponent(brand)}&app=lextract`, {
      waitUntil: "load",
    });
    await waitForCsReady(page);
    await page.waitForSelector("[data-aics-panel]", { timeout: 10_000 });
    await page.evaluate(() => {
      window.__AI_CS_WIDGET__.close();
    });
    await page.waitForSelector("[data-aics-panel]", { state: "detached", timeout: 10_000 });
    await page.waitForSelector("[data-aics-launcher]", { state: "visible", timeout: 10_000 });
    await applyPreCaptureStyles(page, LIGHT_BG);
    const buffer = await captureElement(page, CS_SELECTORS, { padding: PADDING_PX });
    await saveBuffer(buffer, "widget-cs-launcher-desktop.png");
  } finally {
    await page.close();
    await ctx.close();
  }
}

/**
 * Capture the AI-CS empty state: the panel right after it opens, before any
 * message is sent (`[data-aics-empty]`, "How can we help?").
 *
 * This replaces an earlier escalation-affordance shot that turned out to be
 * a byte-identical duplicate of the answered-desktop panel — the escalate
 * pill (`[data-aics-escalate]`) is always part of the normal panel chrome,
 * not a distinct visual state, so a dedicated screenshot of it added nothing
 * beyond what `widget-cs-answered-desktop.png` already shows. The empty
 * state is a genuinely different, useful state to document.
 * @param {import("playwright").Browser} browser
 * @param {string} bffUrl
 * @param {string} brand
 * @returns {Promise<void>}
 */
async function captureCsEmpty(browser, bffUrl, brand) {
  const ctx = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${bffUrl}/?brand=${encodeURIComponent(brand)}&app=lextract`, {
      waitUntil: "load",
    });
    await waitForCsReady(page);
    await page.waitForSelector("[data-aics-empty]", { state: "visible", timeout: 10_000 });
    await applyPreCaptureStyles(page, LIGHT_BG);
    const buffer = await captureElement(page, CS_SELECTORS, { padding: PADDING_PX });
    await saveBuffer(buffer, "widget-cs-empty-desktop.png");
  } finally {
    await page.close();
    await ctx.close();
  }
}

/**
 * Run one AI-CS harness boot for a single brand's mock answer content and
 * capture whatever states are requested for it.
 *
 * For "lextract" this also captures the launcher, empty, and mobile-answered
 * states (the non-matrix required outputs); every brand contributes its
 * desktop-answered panel as a matrix source buffer.
 * @param {import("playwright").Browser} browser
 * @param {string} brand
 * @returns {Promise<{ brand: string, label: string, buffer: Buffer }>}
 */
async function runCsBrand(browser, brand) {
  const content = CS_BRAND_CONTENT[brand];
  console.info(`--- AI-CS boot: brand=${brand} ---`);

  /** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
  let openRouter;
  /** @type {Awaited<ReturnType<typeof startMockContext>> | undefined} */
  let ctxMock;
  /** @type {import("../e2e/boot-e2e-workers.mjs").E2eWorkers | undefined} */
  let harness;
  /** @type {Awaited<ReturnType<typeof startBrowserBff>> | undefined} */
  let bff;

  try {
    openRouter = await startMockOpenRouter({ content });
    ctxMock = await startMockContext({
      secret: CS_CONTEXT_SECRET,
      appId: "lextract",
      appName: "Lextract",
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

    const desktopBuffer = await captureCsAnsweredPanel(browser, bff.url, brand, DESKTOP, content);

    if (brand === "lextract") {
      await saveBuffer(desktopBuffer, "widget-cs-answered-desktop.png");
      const mobileBuffer = await captureCsAnsweredPanel(browser, bff.url, brand, MOBILE, content);
      await saveBuffer(mobileBuffer, "widget-cs-answered-mobile.png");
      await captureCsLauncher(browser, bff.url, brand);
      await captureCsEmpty(browser, bff.url, brand);
    }

    return { brand, label: CS_BRAND_LABELS[brand], buffer: desktopBuffer };
  } finally {
    await bff?.close();
    await harness?.stop();
    await openRouter?.close();
    await ctxMock?.close();
  }
}

/**
 * Capture every AI-CS output: the 4 non-matrix states (lextract only) plus
 * one answered panel per brand for the matrix.
 * @param {import("playwright").Browser} browser
 * @returns {Promise<Array<{ brand: string, label: string, buffer: Buffer }>>}
 */
async function captureCsShots(browser) {
  /** @type {Array<{ brand: string, label: string, buffer: Buffer }>} */
  const matrixPanels = [];
  for (const brand of CS_BRANDS) {
    matrixPanels.push(await runCsBrand(browser, brand));
  }
  return matrixPanels;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-SDR helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-SDR's root selector per the spec is `[data-ai-sdr-widget]`. In practice
 * that root is `position:fixed` with no explicit size, and its panel child
 * (`[data-ai-sdr-panel]`) is ALSO independently `position:fixed` — verified
 * empirically via `getBoundingClientRect()` — so the panel does not
 * contribute to the root's own layout box. When the panel is open, the
 * root's bounding box collapses to just the (hidden) launcher button and
 * excludes the visible panel entirely. To honor the actual acceptance
 * criterion ("every image is cropped to the widget, not a mostly-empty
 * viewport"), this prefers `[data-ai-sdr-panel]` when present and falls back
 * to `[data-ai-sdr-widget]` only when no panel is mounted, mirroring the
 * same panel-first pattern the spec already specifies for AI-CS.
 */
const SDR_SELECTORS = ["[data-ai-sdr-panel]", "[data-ai-sdr-widget]"];

/**
 * Wait for the AI-SDR widget to finish mounting (autoOpen already opens the
 * panel by the time this resolves).
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
async function waitForSdrReady(page) {
  await page.waitForFunction(() => window.__WIDGET_READY__ === true, undefined, {
    timeout: 20_000,
  });
  const initErr = await page.evaluate(() => window.__WIDGET_ERROR__);
  if (initErr) throw new Error(`AI-SDR widget init error: ${String(initErr)}`);
  // "attached", not the default "visible" — same reasoning as waitForCsReady
  // above: the root's launcher child is `hidden` once the panel auto-opens,
  // so the root itself can have a legitimately empty box.
  await page.waitForSelector("[data-ai-sdr-widget]", { state: "attached", timeout: 15_000 });
  await page.waitForSelector("[data-ai-sdr-panel]", { timeout: 15_000 });
}

/**
 * Send a message and wait for the AI-SDR widget to fully settle: full answer
 * text rendered, the stop-generating control loses its `data-visible`
 * attribute (stream done), then a 400ms pause. Ported from
 * `scripts/e2e/settled-screenshots.mjs` (`captureAiSdrSettled`).
 * @param {import("playwright").Page} page
 * @param {string} expectedContent
 * @returns {Promise<void>}
 */
async function waitSdrSettled(page, expectedContent) {
  await page.waitForFunction(
    /** @param {string} expected */ (expected) => {
      const bubbles = document.querySelectorAll(
        '[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]',
      );
      return Array.from(bubbles).some((b) => (b.textContent ?? "").includes(expected));
    },
    expectedContent,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => {
      const stop = document.querySelector("[data-ai-sdr-stop-generating]");
      if (stop === null) return true;
      return !("visible" in stop.dataset);
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(400);
}

/**
 * Capture every AI-SDR output in one harness boot: typed (pre-send),
 * answered desktop, answered mobile, and dark-mode desktop.
 * @param {import("playwright").Browser} browser
 * @returns {Promise<void>}
 */
async function captureSdrShots(browser) {
  /** @type {Awaited<ReturnType<typeof startMockOpenRouter>> | undefined} */
  let openRouter;
  /** @type {Awaited<ReturnType<typeof startMockProductContext>> | undefined} */
  let ctxMock;
  /** @type {import("../e2e/boot-e2e-workers.mjs").E2eWorkers | undefined} */
  let harness;
  /** @type {Awaited<ReturnType<typeof startSdrBrowserBff>> | undefined} */
  let bff;

  console.info("--- AI-SDR boot: product=lextract ---");

  try {
    openRouter = await startMockOpenRouter({ content: SDR_CONTENT });
    ctxMock = await startMockProductContext({ secret: SDR_CONTEXT_SECRET, product: SDR_PRODUCT });
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

    // Desktop: typed (pre-send) then answered, same session.
    {
      const ctx = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${bff.url}/?product=lextract`, { waitUntil: "load" });
        await waitForSdrReady(page);
        await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
        await page.fill("[data-ai-sdr-input]", SDR_QUESTION);
        await applyPreCaptureStyles(page, LIGHT_BG);
        const typedBuffer = await captureElement(page, SDR_SELECTORS, { padding: PADDING_PX });
        await saveBuffer(typedBuffer, "widget-sdr-typed-desktop.png");

        await page.click("[data-ai-sdr-send]");
        await waitSdrSettled(page, SDR_CONTENT);
        await applyPreCaptureStyles(page, LIGHT_BG);
        const answeredBuffer = await captureElement(page, SDR_SELECTORS, { padding: PADDING_PX });
        await saveBuffer(answeredBuffer, "widget-sdr-answered-desktop.png");
      } finally {
        await page.close();
        await ctx.close();
      }
    }

    // Mobile: answered.
    {
      const ctx = await browser.newContext({
        viewport: MOBILE,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${bff.url}/?product=lextract`, { waitUntil: "load" });
        await waitForSdrReady(page);
        await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
        await page.fill("[data-ai-sdr-input]", SDR_QUESTION);
        await page.click("[data-ai-sdr-send]");
        await waitSdrSettled(page, SDR_CONTENT);
        await applyPreCaptureStyles(page, LIGHT_BG);
        const buffer = await captureElement(page, SDR_SELECTORS, { padding: PADDING_PX });
        await saveBuffer(buffer, "widget-sdr-answered-mobile.png");
      } finally {
        await page.close();
        await ctx.close();
      }
    }

    // Desktop dark mode: answered.
    {
      const ctx = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${bff.url}/?product=lextract&dark=1`, { waitUntil: "load" });
        await waitForSdrReady(page);
        await page.waitForSelector("[data-ai-sdr-input]", { timeout: 15_000 });
        await page.fill("[data-ai-sdr-input]", SDR_QUESTION);
        await page.click("[data-ai-sdr-send]");
        await waitSdrSettled(page, SDR_CONTENT);
        await applyPreCaptureStyles(page, DARK_BG);
        const buffer = await captureElement(page, SDR_SELECTORS, { padding: PADDING_PX });
        await saveBuffer(buffer, "widget-dark-sdr-desktop.png");
      } finally {
        await page.close();
        await ctx.close();
      }
    }
  } finally {
    await bff?.close();
    await harness?.stop();
    await openRouter?.close();
    await ctxMock?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix composition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the 4 per-brand AI-CS panel buffers into a single labeled 2x2
 * grid PNG.
 *
 * No image library is added: this builds a small local HTML page that
 * embeds each PNG as a `data:` URI inside a CSS grid with a caption per
 * cell, loads it via `page.setContent()`, waits for every `<img>` to finish
 * decoding, then screenshots the grid container element directly (a normal
 * in-flow block layout, so unlike the widget captures above, a plain
 * element screenshot already has correct bounds with no fixed-position
 * quirk to work around).
 * @param {import("playwright").Browser} browser
 * @param {Array<{ brand: string, label: string, buffer: Buffer }>} panels
 * @returns {Promise<void>}
 */
async function composeMatrix(browser, panels) {
  const cells = panels
    .map((panel) => {
      const dataUri = `data:image/png;base64,${panel.buffer.toString("base64")}`;
      return `<figure><img src="${dataUri}" alt="${panel.label} AI-CS answered panel"><figcaption>${panel.label}</figcaption></figure>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body{margin:0;background:${LIGHT_BG};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
  #matrix{display:grid;grid-template-columns:repeat(2,1fr);gap:${MATRIX_GAP_PX}px;padding:${MATRIX_GAP_PX}px;width:${MATRIX_GRID_WIDTH_PX}px;box-sizing:border-box;}
  figure{margin:0;background:#ffffff;border-radius:14px;padding:14px;box-shadow:0 1px 3px rgba(15,23,42,.12);display:flex;flex-direction:column;align-items:center;gap:8px;}
  figure img{width:100%;height:auto;border-radius:10px;display:block;}
  figcaption{font-size:13px;font-weight:600;color:#0f172a;}
</style>
</head>
<body>
<div id="matrix">
${cells}
</div>
</body>
</html>`;

  const ctx = await browser.newContext({
    viewport: { width: MATRIX_GRID_WIDTH_PX + 80, height: 1100 },
    deviceScaleFactor: MATRIX_DEVICE_SCALE_FACTOR,
  });
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() =>
      Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
    );
    const buffer = await page.locator("#matrix").screenshot();
    await saveBuffer(buffer, "widget-matrix.png");
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional scope for re-capturing a subset of outputs without churning the
 * rest: `CAPTURE_ONLY=sdr` runs only the 3 AI-SDR files, `CAPTURE_ONLY=cs`
 * runs only the 4 AI-CS files plus the matrix (which embeds AI-CS panels).
 * Unset (default) captures everything, same as always.
 * @type {"sdr" | "cs" | undefined}
 */
const CAPTURE_ONLY =
  process.env.CAPTURE_ONLY === "sdr" || process.env.CAPTURE_ONLY === "cs"
    ? process.env.CAPTURE_ONLY
    : undefined;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    if (CAPTURE_ONLY !== "cs") {
      console.info("=== AI-SDR captures ===");
      await captureSdrShots(browser);
    }

    if (CAPTURE_ONLY !== "sdr") {
      console.info("=== AI-CS captures ===");
      const matrixPanels = await captureCsShots(browser);

      console.info("=== Matrix composition ===");
      await composeMatrix(browser, matrixPanels);
    }
  } finally {
    await browser?.close();
  }

  console.info(`\n=== Wrote ${written.length} files ===`);
  for (const filePath of written) {
    console.info(filePath);
  }
}

main().catch((err) => {
  console.error("capture-docs-shots.mjs failed:", err);
  process.exit(1);
});

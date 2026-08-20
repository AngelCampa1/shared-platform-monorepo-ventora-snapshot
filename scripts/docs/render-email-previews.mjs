#!/usr/bin/env node
/**
 * Renders the @ventora/email-templates library to documentation images.
 *
 * Imports the BUILT package output (no Cloudflare Worker, no network, no
 * secrets) and renders every template's HTML into an isolated iframe inside
 * a Playwright page, then screenshots:
 *
 *   1. portfolio/screenshots/email-templates-sheet.png  — 5x2 contact-sheet
 *      thumbnail grid of all 10 templates, captioned.
 *   2. portfolio/screenshots/email-payment-receipt.png  — full
 *      "payment-receipt" render at 600px content width.
 *   3. portfolio/screenshots/email-trial-ending.png     — full "trial-ending"
 *      render at 600px content width.
 *
 * Run:  node scripts/docs/render-email-previews.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const EMAIL_TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "email-templates");
const EMAIL_TEMPLATES_DIST_ENTRY = resolve(EMAIL_TEMPLATES_DIR, "dist", "index.js");
const OUT_DIR = resolve(REPO_ROOT, "portfolio", "screenshots");

const DEVICE_SCALE_FACTOR = 2;
const BACKGROUND = "#f1f5f9";
/** Bound on how long a mounted email iframe may take to fire `onload`. */
const MOUNT_TIMEOUT_MS = 15_000;

/** @typedef {import("../../packages/email-templates/src/types.js").TemplateName} TemplateName */
/** @typedef {import("../../packages/email-templates/src/types.js").TemplateVars} TemplateVars */

/**
 * Realistic-but-fictional variables for every template, ordered to match the
 * `TEMPLATES` map in `packages/email-templates/src/render.ts`. Every value
 * satisfies the `REQUIRED_VARS` type declared there (strings vs numbers).
 * @type {Array<{ name: TemplateName, vars: TemplateVars }>}
 */
const TEMPLATE_FIXTURES = [
  {
    name: "welcome",
    vars: {
      productName: "Lextract",
      firstName: "Sam Rivera",
      loginUrl: "https://example.com/login",
      trialDays: 14,
    },
  },
  {
    name: "password-reset",
    vars: {
      resetUrl: "https://example.com/reset-password/abc123",
      firstName: "Sam Rivera",
      expiresIn: "1 hour",
    },
  },
  {
    name: "email-verification",
    vars: {
      verifyUrl: "https://example.com/verify-email/abc123",
      firstName: "Sam Rivera",
    },
  },
  {
    name: "trial-ending",
    vars: {
      daysLeft: 3,
      upgradeUrl: "https://example.com/upgrade",
      firstName: "Sam Rivera",
      productName: "Lextract",
    },
  },
  {
    name: "trial-expired",
    vars: {
      upgradeUrl: "https://example.com/upgrade",
      firstName: "Sam Rivera",
      productName: "Lextract",
    },
  },
  {
    name: "payment-receipt",
    vars: {
      amount: "49.00",
      currency: "USD",
      planName: "Lextract Team",
      date: "August 1, 2026",
      invoiceUrl: "https://example.com/invoices/1001",
    },
  },
  {
    name: "payment-failed",
    vars: {
      updatePaymentUrl: "https://example.com/billing/update",
      amount: "49.00",
      firstName: "Sam Rivera",
    },
  },
  {
    name: "lead-magnet-delivery",
    vars: {
      downloadUrl: "https://example.com/downloads/document-checklist.pdf",
      resourceTitle: "Document Review Checklist",
      firstName: "Sam Rivera",
      productName: "Lextract",
    },
  },
  {
    name: "nurture-step",
    vars: {
      subject: "Get more out of Lextract",
      body: "Upload a document and Lextract pulls out the key fields for you. Try it on your next file.",
      ctaUrl: "https://example.com/app",
      ctaText: "Open Lextract",
      productName: "Lextract",
    },
  },
  {
    name: "internal-error-fallback",
    vars: {
      trackingId: "trk_8f2c19",
      supportEmail: "support@example.com",
    },
  },
];

/** @type {string[]} */
const written = [];

/**
 * Ensure the built package exists, building it if missing.
 * @returns {Promise<void>}
 */
async function ensureEmailTemplatesBuilt() {
  if (existsSync(EMAIL_TEMPLATES_DIST_ENTRY)) return;
  console.info("=== Building @ventora/email-templates (dist missing) ===");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["--filter", "@ventora/email-templates", "build"], {
      cwd: REPO_ROOT,
      shell: true,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to spawn pnpm build: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(undefined);
      } else {
        reject(new Error(`@ventora/email-templates build failed with exit code ${code ?? "null"}`));
      }
    });
  });
}

/**
 * Renders every fixture through the built package.
 * @returns {Promise<Array<{ name: TemplateName, html: string }>>}
 */
async function renderAllTemplates() {
  /** @type {{ render: (name: TemplateName, vars: TemplateVars) => Promise<{ html: string, text: string }> }} */
  const emailTemplates = await import(pathToFileURL(EMAIL_TEMPLATES_DIST_ENTRY).href);
  const results = [];
  for (const fixture of TEMPLATE_FIXTURES) {
    const { html } = await emailTemplates.render(fixture.name, fixture.vars);
    results.push({ name: fixture.name, html });
  }
  return results;
}

/**
 * Injects an email's rendered HTML into an iframe appended to `selector`,
 * waits for it to finish loading, sizes the iframe to its content height,
 * and returns that content height in pixels.
 *
 * Rejects if the iframe fires `onerror` instead of `onload`, or if neither
 * fires within `MOUNT_TIMEOUT_MS` — otherwise a template that never settles
 * would hang this script forever with no indication of which template it was.
 *
 * @param {import("playwright").Page} page
 * @param {string} selector
 * @param {string} html
 * @param {string} templateName name of the template, used only in the timeout/error message
 * @param {{ width: number }} [size]
 * @returns {Promise<number>}
 */
async function mountEmailIframe(page, selector, html, templateName, size = { width: 600 }) {
  return page.evaluate(
    /**
     * @param {{ selector: string, html: string, width: number, templateName: string, timeoutMs: number }} args
     * @returns {Promise<number>}
     */
    ({ selector, html, width, templateName, timeoutMs }) => {
      return new Promise((resolvePromise, rejectPromise) => {
        const container = document.querySelector(selector);
        if (!container) throw new Error(`mountEmailIframe: container not found: ${selector}`);
        const iframe = document.createElement("iframe");
        iframe.style.border = "0";
        iframe.style.display = "block";
        iframe.style.width = `${width}px`;

        const timer = window.setTimeout(() => {
          rejectPromise(
            new Error(
              `mountEmailIframe: template "${templateName}" did not fire onload within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);

        iframe.onload = () => {
          window.clearTimeout(timer);
          const doc = iframe.contentDocument;
          const height = doc
            ? Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight)
            : 0;
          iframe.style.height = `${height}px`;
          resolvePromise(height);
        };
        iframe.onerror = () => {
          window.clearTimeout(timer);
          rejectPromise(new Error(`mountEmailIframe: template "${templateName}" failed to load`));
        };
        iframe.srcdoc = html;
        container.appendChild(iframe);
      });
    },
    { selector, html, width: size.width, templateName, timeoutMs: MOUNT_TIMEOUT_MS },
  );
}

/**
 * Renders a single template full-width (600px content) inside a card on a
 * neutral background, then screenshots the card.
 * @param {import("playwright").Browser} browser
 * @param {string} name
 * @param {string} html
 * @param {string} outPath
 * @returns {Promise<void>}
 */
async function captureFullTemplate(browser, name, html, outPath) {
  const page = await browser.newPage({ deviceScaleFactor: DEVICE_SCALE_FACTOR });
  try {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(`<!doctype html>
<html>
<head><meta charset="utf-8" /><style>
  html, body { margin: 0; padding: 0; background: ${BACKGROUND}; }
  #card-frame { padding: 40px; display: inline-block; background: ${BACKGROUND}; }
  #card {
    width: 600px;
    background: #ffffff;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
  }
</style></head>
<body>
  <div id="card-frame"><div id="card"></div></div>
</body>
</html>`);
    const height = await mountEmailIframe(page, "#card", html, name, { width: 600 });
    await page.setViewportSize({ width: 720, height: height + 80 });
    const card = page.locator("#card");
    await card.screenshot({ path: outPath });
    written.push(outPath);
  } finally {
    await page.close();
  }
}

/**
 * Builds the 5x2 contact-sheet grid of all rendered templates and
 * screenshots it.
 * @param {import("playwright").Browser} browser
 * @param {Array<{ name: TemplateName, html: string }>} renders
 * @param {string} outPath
 * @returns {Promise<void>}
 */
async function captureContactSheet(browser, renders, outPath) {
  const page = await browser.newPage({ deviceScaleFactor: DEVICE_SCALE_FACTOR });
  try {
    const columns = 5;
    const rows = 2;
    const cellWidth = 240;
    const cellHeight = 320;
    const iframeWidth = 600;
    const iframeHeight = 800;
    const scale = cellWidth / iframeWidth;
    const gap = 24;
    const padding = 32;
    const sheetWidth = columns * cellWidth + (columns - 1) * gap + padding * 2;
    const sheetHeight = rows * (cellHeight + 28) + (rows - 1) * gap + padding * 2;

    await page.setViewportSize({ width: sheetWidth, height: sheetHeight });
    await page.setContent(`<!doctype html>
<html>
<head><meta charset="utf-8" /><style>
  html, body { margin: 0; padding: 0; background: ${BACKGROUND}; font-family: sans-serif; }
  #sheet {
    display: grid;
    grid-template-columns: repeat(${columns}, ${cellWidth}px);
    grid-auto-rows: auto;
    gap: ${gap}px;
    padding: ${padding}px;
    background: ${BACKGROUND};
    width: fit-content;
  }
  .cell { display: flex; flex-direction: column; align-items: center; }
  .caption {
    font-size: 13px;
    font-weight: 600;
    color: #0f172a;
    margin-bottom: 8px;
    text-align: center;
  }
  .thumb-wrap {
    width: ${cellWidth}px;
    height: ${cellHeight}px;
    overflow: hidden;
    position: relative;
    border-radius: 6px;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
  }
  .thumb-wrap iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: ${iframeWidth}px;
    height: ${iframeHeight}px;
    border: 0;
    transform-origin: top left;
    transform: scale(${scale});
    pointer-events: none;
  }
</style></head>
<body>
  <div id="sheet"></div>
</body>
</html>`);

    for (const item of renders) {
      await page.evaluate(
        /**
         * @param {{ name: string }} args
         */
        ({ name }) => {
          const sheet = document.querySelector("#sheet");
          if (!sheet) throw new Error("captureContactSheet: #sheet not found");
          const cell = document.createElement("div");
          cell.className = "cell";
          const caption = document.createElement("div");
          caption.className = "caption";
          caption.textContent = name;
          const thumbWrap = document.createElement("div");
          thumbWrap.className = "thumb-wrap";
          thumbWrap.id = `thumb-${name}`;
          cell.appendChild(caption);
          cell.appendChild(thumbWrap);
          sheet.appendChild(cell);
        },
        { name: item.name },
      );
      await mountEmailIframe(page, `#thumb-${item.name}`, item.html, item.name, {
        width: iframeWidth,
      });
    }

    const sheet = page.locator("#sheet");
    await sheet.screenshot({ path: outPath });
    written.push(outPath);
  } finally {
    await page.close();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await ensureEmailTemplatesBuilt();

  console.info("=== Rendering all templates via @ventora/email-templates ===");
  const renders = await renderAllTemplates();
  console.info(
    `Rendered ${renders.length}/${TEMPLATE_FIXTURES.length} templates without throwing.`,
  );

  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    console.info("=== Contact sheet ===");
    await captureContactSheet(browser, renders, resolve(OUT_DIR, "email-templates-sheet.png"));

    console.info("=== payment-receipt (full, 600px) ===");
    const paymentReceipt = renders.find((r) => r.name === "payment-receipt");
    if (!paymentReceipt) throw new Error("payment-receipt render missing");
    await captureFullTemplate(
      browser,
      paymentReceipt.name,
      paymentReceipt.html,
      resolve(OUT_DIR, "email-payment-receipt.png"),
    );

    console.info("=== trial-ending (full, 600px) ===");
    const trialEnding = renders.find((r) => r.name === "trial-ending");
    if (!trialEnding) throw new Error("trial-ending render missing");
    await captureFullTemplate(
      browser,
      trialEnding.name,
      trialEnding.html,
      resolve(OUT_DIR, "email-trial-ending.png"),
    );
  } finally {
    await browser?.close();
  }

  console.info("\n=== Written PNGs ===");
  for (const p of written) {
    console.info(p);
  }
  console.info(`\nTotal: ${written.length} file(s)`);
}

main().catch((err) => {
  console.error("render-email-previews.mjs failed:", err);
  process.exit(1);
});

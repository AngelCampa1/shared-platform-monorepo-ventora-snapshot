import { AiCsWidget, resolveAiCsBrand } from "@ventora/ai-cs/react";
/**
 * Browser entry bundled by esbuild for the AI-CS browser-layer E2E
 * (X7.2(b) Playwright slice).
 *
 * Mounts the REAL `@ventora/ai-cs/react` widget into `#root` with a RELATIVE
 * api.baseUrl (`/api/ai-cs`). That relative URL resolves against the page origin
 * (http://localhost:5173), where the same-origin signing BFF proxy mints the HMAC
 * client-assertion server-side — the browser never holds the secret. This mirrors
 * the production floriva/camaudit pattern exactly.
 *
 * The brand is selected from the `?brand=<id>` query param so the test can navigate
 * per-brand and assert real `getComputedStyle` theming. `window.__RESOLVED_BRAND__`
 * exposes the widget's own resolved palette so the assertion compares against the
 * package's source of truth (not a hard-coded copy). `window.__WIDGET_READY__`
 * signals mount completion to Playwright.
 *
 * Authored with React.createElement (no JSX) so esbuild needs no JSX loader for a
 * plain `.js` entry.
 */
import React from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(window.location.search);
const brandId = params.get("brand") || "lextract";
const appId = params.get("app") || brandId;
const darkMode = params.get("dark") === "1";

// Expose the package's own resolved palette as the assertion source of truth.
window.__RESOLVED_BRAND__ = resolveAiCsBrand({ id: brandId });

/** @type {{ id: string, accentColor?: string, surfaceColor?: string, textColor?: string }} */
const brandProp = darkMode
  ? { id: brandId, accentColor: "#6ea8ff", surfaceColor: "#0f1420", textColor: "#e6edf6" }
  : { id: brandId };

const element = React.createElement(AiCsWidget, {
  api: { baseUrl: "/api/ai-cs" },
  session: { appId, userId: "e2e-browser-user" },
  brand: brandProp,
  defaultOpen: true,
});

const container = document.getElementById("root");
const root = createRoot(container);
root.render(element);

// Mount is synchronous enough that a microtask flush guarantees the root element
// (with its inline brand CSS vars) is in the DOM before the flag is read.
queueMicrotask(() => {
  window.__WIDGET_READY__ = true;
});

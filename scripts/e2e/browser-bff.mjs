/**
 * Same-origin signing BFF for the AI-CS browser-layer E2E (X7.2(b) Playwright slice).
 *
 * A real browser cannot hold the HMAC client-assertion secret, so the production
 * pattern is a same-origin backend-for-frontend that signs each `/v1/*` request
 * server-side. This BFF reproduces that pattern while loading the worker-hosted
 * immutable AI-CS client from `/client/v0.3.1/ai-cs.global.js`.
 *
 *   GET  /                     -> HTML shell that loads the worker-hosted IIFE
 *   POST /api/ai-cs/assertion  -> HMAC-sign a widget request body server-side
 *   POST /api/ai-cs/v1/*       -> strip prefix, HMAC-sign the /v1/* path over the
 *                                 parsed body, forward with Origin: localhost:5173,
 *                                 and STREAM the SSE response straight through.
 *
 * The signature is computed from the parsed JSON body (stableJson), byte-identical
 * to how the worker recomputes it.
 */
import { createServer } from "node:http";
import { E2E_ALLOWED_ORIGIN, signClientAssertion } from "./client-assertion.mjs";

const API_PREFIX = "/api/ai-cs";
const E2E_APP_ID = "lextract";
const E2E_USER_ID = "e2e-browser-user";
export const AI_CS_CLIENT_BUNDLE_PATH = "/client/v0.3.1/ai-cs.global.js";

const PRODUCT_BRANDS = {
  camaudit: { accentColor: "#1f5a52" },
  capveri: { accentColor: "#4f46e5" },
  grantpipe: { accentColor: "#15803d" },
  lextract: { accentColor: "#b45309" },
};

/**
 * @param {string} aiCsBaseUrl
 * @returns {string}
 */
function htmlShell(aiCsBaseUrl) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ai-cs browser e2e</title></head>
<body>
<script src="${aiCsBaseUrl}${AI_CS_CLIENT_BUNDLE_PATH}"></script>
<script>
  (function () {
    var brands = ${JSON.stringify(PRODUCT_BRANDS)};
    var params = new URLSearchParams(window.location.search);
    var brandId = params.get("brand") || "lextract";
    var appId = params.get("app") || brandId;
    var darkMode = params.get("dark") === "1";
    window.__RESOLVED_BRAND__ = brands[brandId] || { accentColor: "#0f172a" };
    var brand = darkMode
      ? { id: brandId, accentColor: "#6ea8ff", surfaceColor: "#0f1420", textColor: "#e6edf6" }
      : { id: brandId };
    var sessionBody = {
      appId: appId,
      userId: "e2e-browser-user",
      currentPath: window.location.pathname
    };
    var widget = window.AiCs.init({
      baseUrl: "${API_PREFIX}",
      clientAssertion: { body: sessionBody },
      signRequest: async function (input) {
        var response = await fetch("${API_PREFIX}/assertion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        if (!response.ok) throw new Error("AI-CS assertion signing failed");
        return await response.json();
      },
      brand: brand
    });
    window.__AI_CS_CLIENT_BUNDLE_PATH__ = "${AI_CS_CLIENT_BUNDLE_PATH}";
    window.__AI_CS_WIDGET__ = widget;
    widget.open()
      .then(function () { window.__WIDGET_READY__ = true; })
      .catch(function (err) {
        window.__WIDGET_ERROR__ = String(err && err.message ? err.message : err);
      });
  })();
</script>
</body>
</html>
`;
}

/**
 * Read the full request body as a Buffer.
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Start the signing BFF.
 * @param {{ aiCsBaseUrl: string, port?: number }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startBrowserBff({ aiCsBaseUrl, port = 0 }) {
  const HTML = htmlShell(aiCsBaseUrl);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`bff error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function handle(req, res) {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && (url === "/" || url.startsWith("/?"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (method === "POST" && url === `${API_PREFIX}/assertion`) {
      const raw = await readBody(req);
      const input = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
      const path = typeof input.path === "string" ? input.path : "";
      const body = input.body ?? {};
      const signed = signClientAssertion({ path, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ body, headers: signed }));
      return;
    }

    if (method === "POST" && url.startsWith(`${API_PREFIX}/`)) {
      const path = url.slice(API_PREFIX.length); // "/v1/sessions" etc.
      const raw = await readBody(req);
      const body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
      const forwardBody =
        path === "/v1/chat" || path === "/v1/escalations"
          ? { ...body, appId: E2E_APP_ID, userId: E2E_USER_ID }
          : body;
      const signed = signClientAssertion({ path, body: forwardBody });

      const upstream = await fetch(`${aiCsBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signed,
        },
        body: JSON.stringify(forwardBody),
      });

      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-cache",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }

  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((err) => (err ? rejectClose(err) : resolveClose(undefined))),
      ),
  };
}

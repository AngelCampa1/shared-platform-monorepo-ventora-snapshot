/**
 * Same-origin signing BFF for the AI-SDR browser-layer E2E (X7.2(b) sibling slice).
 *
 * The ai-sdr counterpart of browser-bff.mjs. Unlike ai-cs (a React package the BFF
 * must esbuild-bundle), the ai-sdr widget is a hosted IIFE the ai-sdr-worker serves
 * itself at `/client/v0.3.7/ai-sdr.global.js`. So this BFF does NOT bundle anything —
 * the HTML shell loads that bundle straight from the worker (a classic cross-origin
 * <script>, no CORS needed) and calls `window.AiSdr.init({ baseUrl: "/api/ai-sdr" })`.
 *
 * The browser cannot hold the HMAC client-assertion secret, so — exactly as in the
 * ai-cs BFF and the production floriva/camaudit pattern — every `/v1/*` request is
 * signed server-side here:
 *
 *   GET  /                     -> HTML shell: load worker IIFE + AiSdr.init(autoOpen)
 *   POST /api/ai-sdr/v1/*       -> strip prefix, HMAC-sign the /v1/* path over the
 *                                  parsed body, forward with Origin: localhost:5173,
 *                                  and STREAM the SSE response straight through.
 *
 * The signature is computed from the parsed JSON body (stableJson) — byte-identical
 * to how the worker recomputes it — while the original request bytes are forwarded
 * verbatim, so SSE/JSON framing never drifts.
 */
import { createServer } from "node:http";
import { E2E_ALLOWED_ORIGIN, signClientAssertion } from "./client-assertion.mjs";

const API_PREFIX = "/api/ai-sdr";
/** The worker-hosted IIFE the page loads; registers window.AiSdr.init. */
const CLIENT_BUNDLE_PATH = "/client/v0.3.7/ai-sdr.global.js";

/**
 * The HTML shell. Loads the worker-hosted widget IIFE cross-origin, then inits it
 * against the same-origin `/api/ai-sdr` BFF. `autoOpen` opens the panel immediately
 * so the composer is interactable without a launcher click. `__WIDGET_READY__` flips
 * true only after init resolves so the test can wait deterministically.
 * @param {string} aiSdrBaseUrl
 * @returns {string}
 */
function htmlShell(aiSdrBaseUrl) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ai-sdr browser e2e</title></head>
<body>
<script src="${aiSdrBaseUrl}${CLIENT_BUNDLE_PATH}"></script>
<script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    var productId = params.get("product") || "lextract";
    var darkMode = params.get("dark") === "1";
    window.__SDR_PRODUCT__ = productId;
    try {
      var initOpts = {
        baseUrl: "${API_PREFIX}",
        session: { productId: productId },
        autoOpen: true,
      };
      if (darkMode) {
        initOpts.brand = { accentColor: "#6ea8ff", surfaceColor: "#0f1420", textColor: "#e6edf6" };
      }
      window.__SDR_WIDGET__ = window.AiSdr.init(initOpts);
      window.__WIDGET_READY__ = true;
    } catch (err) {
      window.__WIDGET_ERROR__ = String(err && err.message ? err.message : err);
    }
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
 * @param {{ aiSdrBaseUrl: string, port?: number }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startSdrBrowserBff({ aiSdrBaseUrl, port = 0 }) {
  const HTML = htmlShell(aiSdrBaseUrl);

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

    if (method === "POST" && url.startsWith(`${API_PREFIX}/`)) {
      const path = url.slice(API_PREFIX.length); // "/v1/sessions" etc.
      const raw = await readBody(req);
      const body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
      const signed = signClientAssertion({ path, body });

      const upstream = await fetch(`${aiSdrBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signed,
        },
        body: raw,
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

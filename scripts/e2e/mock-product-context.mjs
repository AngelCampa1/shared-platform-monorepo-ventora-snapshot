#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/**
 * Minimal mock HTTP server that stands in for the product-side signed-context
 * endpoint consumed by the ai-sdr-worker.
 *
 * This is the ai-sdr sibling of mock-context.mjs (which serves the ai-cs
 * AiCsAppContext contract). The two contracts differ, so they are kept as
 * separate focused mocks:
 *
 *   - ai-cs signs the request body as { appId, userId } and returns an
 *     AiCsAppContext { assistantId: "ai-cs", appId, appName, authenticatedOnly }.
 *   - ai-sdr signs the request body as { productId } and returns a
 *     ProductContext { productId, name, ... } (isProductContext only requires
 *     productId + name to be strings).
 *
 * CONTRACT (from packages/ai-sdr-worker/src/index.ts, fetchSignedProductContext):
 *
 * Incoming request from worker:
 *   GET /context?productId=<x>
 *   X-Ventora-Timestamp: <iso>
 *   X-Ventora-Nonce:     <uuid>
 *   X-Ventora-Signature: HMAC-SHA256(secret, buildHmacPayload({
 *     timestamp, nonce, method: "GET",
 *     path: "/context?productId=...",   // full pathname+search
 *     body: { productId },              // stableJson-sorted
 *   }))
 *
 * Response required by worker:
 *   200 application/json
 *   X-Ventora-Timestamp / X-Ventora-Nonce / X-Ventora-Signature: HMAC over
 *     buildHmacPayload({ timestamp, nonce, method: "GET", path: <same path>,
 *                        body: <parsed product context object> })
 *   body: ProductContext { productId, name, ... }  (productId must equal the
 *         query productId or the worker rejects it with reason "invalid_context")
 *
 * If request HMAC verification fails: respond 401.
 *
 * Usage:
 *   const { url, port, close, requests } = await startMockProductContext({
 *     secret: "my-context-secret",
 *     product: { productId: "lextract", name: "Lextract", sources: [...] },
 *   });
 *   // url => "http://localhost:<port>/context"
 *   await close();
 */
import { createServer } from "node:http";
import { buildHmacPayload, signHmacPayload } from "./client-assertion.mjs";

/**
 * @typedef {object} MockProductContextHandle
 * @property {string}   url      - Full URL to pass as AI_SDR_CONTEXT_ENDPOINT.
 * @property {number}   port     - Actual bound port.
 * @property {() => Promise<void>} close - Gracefully shuts the server down.
 * @property {Array<{ searchParams: URLSearchParams, verified: boolean }>} requests
 *   - Recorded incoming request metadata.
 */

/**
 * Verify the HMAC on an incoming GET request.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} path     Full request pathname+search (e.g. "/context?productId=...").
 * @param {{ productId: string }} requestBody  The canonical body object the worker signs.
 * @param {string} secret
 * @returns {boolean}
 */
function verifyIncomingHmac(req, path, requestBody, secret) {
  const timestamp = req.headers["x-ventora-timestamp"];
  const nonce = req.headers["x-ventora-nonce"];
  const signature = req.headers["x-ventora-signature"];
  if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
    return false;
  }
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: "GET",
    path,
    body: requestBody,
  });
  const expected = signHmacPayload(payload, secret);
  // Constant-time comparison to match the worker's verifyHmacSignature behaviour.
  if (expected.length !== signature.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build the three signed response headers the worker requires.
 *
 * @param {string} path     Same path string used to verify the request.
 * @param {unknown} product The response body object (before JSON.stringify).
 * @param {string} secret
 * @returns {{ "X-Ventora-Timestamp": string, "X-Ventora-Nonce": string, "X-Ventora-Signature": string }}
 */
function buildResponseSignatureHeaders(path, product, secret) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: "GET",
    path,
    body: product,
  });
  return {
    "X-Ventora-Timestamp": timestamp,
    "X-Ventora-Nonce": nonce,
    "X-Ventora-Signature": signHmacPayload(payload, secret),
  };
}

/**
 * Start a mock product-context server for the ai-sdr-worker.
 *
 * @param {object}  opts
 * @param {string}  opts.secret   HMAC secret shared with the worker (AI_SDR_CONTEXT_SECRET).
 * @param {{ productId: string, name: string } & Record<string, unknown>} opts.product
 *   The ProductContext object returned (and signed) for every verified request.
 *   Its productId must equal the productId the worker requests, or the worker
 *   rejects the response with reason "invalid_context".
 * @param {number}  [opts.port=0]  TCP port. 0 = auto-assign.
 * @returns {Promise<MockProductContextHandle>}
 */
export async function startMockProductContext({ secret, product, port: requestedPort = 0 }) {
  /** @type {Array<{ searchParams: URLSearchParams, verified: boolean }>} */
  const requests = [];

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Reconstruct the path (pathname+search) the worker uses for HMAC computation.
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;

    const reqProductId = parsedUrl.searchParams.get("productId") ?? "";
    // The canonical body the worker signs (index.ts fetchSignedProductContext).
    const requestBody = { productId: reqProductId };

    const verified = verifyIncomingHmac(req, path, requestBody, secret);
    requests.push({ searchParams: parsedUrl.searchParams, verified });

    if (!verified) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid HMAC signature" }));
      return;
    }

    // Sign the response over the EXACT product object the worker will parse.
    const sigHeaders = buildResponseSignatureHeaders(path, product, secret);
    const body = JSON.stringify(product);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...sigHeaders,
    });
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const port = addr.port;
  const url = `http://localhost:${port}/context`;

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });

  return { url, port, close, requests };
}

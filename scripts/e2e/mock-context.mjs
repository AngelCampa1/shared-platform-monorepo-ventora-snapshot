#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/**
 * Minimal mock HTTP server that stands in for the product-side app-context
 * endpoint consumed by the ai-cs-worker.
 *
 * CONTRACT (from packages/ai-cs-worker/src/index.ts, fetchSignedAppContext):
 *
 * Incoming request from worker:
 *   GET /context?appId=<x>&userId=<y>[&currentPath=<p>]
 *   X-Ventora-Timestamp: <iso>
 *   X-Ventora-Nonce:     <uuid>
 *   X-Ventora-Signature: HMAC-SHA256(secret, buildHmacPayload({
 *     timestamp, nonce, method: "GET",
 *     path: "/context?appId=...&userId=...",   // full pathname+search
 *     body: { appId, userId },                 // stableJson-sorted
 *   }))
 *
 * Response required by worker:
 *   200 application/json
 *   X-Ventora-Timestamp: <new-iso>
 *   X-Ventora-Nonce:     <new-uuid>
 *   X-Ventora-Signature: HMAC-SHA256(secret, buildHmacPayload({
 *     timestamp: <new-iso>,
 *     nonce:     <new-uuid>,
 *     method:    "GET",         // same method — matches worker verification
 *     path:      <same path as the request>,  // worker passes the original path
 *     body:      <parsed app context object>, // the actual JSON body returned
 *   }))
 *   body: AiCsAppContext { assistantId: "ai-cs", appId, appName, authenticatedOnly: true }
 *
 * If request HMAC verification fails: respond 401.
 *
 * Usage:
 *   const { url, port, close, requests } = await startMockContext({
 *     secret: "my-context-secret",
 *     appId: "lextract",
 *     appName: "Lextract",
 *   });
 *   // url => "http://localhost:<port>/context"
 *   // pass url as AI_CS_CONTEXT_ENDPOINT (the worker requires https: in production -
 *   //   for local E2E you must inject the endpoint a different way or use a tunnel)
 *   await close();
 */
import { createServer } from "node:http";
import { buildHmacPayload, signHmacPayload } from "./client-assertion.mjs";

/**
 * @typedef {object} MockContextHandle
 * @property {string}   url      - Full URL to pass as AI_CS_CONTEXT_ENDPOINT.
 * @property {number}   port     - Actual bound port.
 * @property {() => Promise<void>} close - Gracefully shuts the server down.
 * @property {Array<{ searchParams: URLSearchParams, verified: boolean }>} requests
 *   - Recorded incoming request metadata.
 * @property {{ failNext: number }} control
 *   - Mutable failure control; set `control.failNext` to make that many of the
 *     next requests return an unsigned 500 (worker surfaces it as 502).
 */

/**
 * Verify the HMAC on an incoming GET request.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} path     Full request pathname+search (e.g. "/context?appId=...").
 * @param {{ appId: string, userId: string, currentPath?: string }} requestBody
 *   The canonical body object.
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
 * The worker verifies (index.ts L375-390):
 *   buildHmacPayload({
 *     timestamp: responseTimestamp,
 *     nonce:     responseNonce,
 *     method:    "GET",
 *     path:      <original request path>,
 *     body:      <parsed app context>,
 *   })
 *
 * @param {string} path     Same path string used to verify the request.
 * @param {unknown} appContext  The response body object (before JSON.stringify).
 * @param {string} secret
 * @returns {{ "X-Ventora-Timestamp": string, "X-Ventora-Nonce": string, "X-Ventora-Signature": string }}
 */
function buildResponseSignatureHeaders(path, appContext, secret) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: "GET",
    path,
    body: appContext,
  });
  return {
    "X-Ventora-Timestamp": timestamp,
    "X-Ventora-Nonce": nonce,
    "X-Ventora-Signature": signHmacPayload(payload, secret),
  };
}

/**
 * Start a mock app-context server.
 *
 * @param {object}  opts
 * @param {string}  opts.secret         HMAC secret shared with the worker (AI_CS_CONTEXT_SECRET).
 * @param {string}  opts.appId          The appId this context server answers for.
 * @param {string}  [opts.appName]      Human-readable app name (default: opts.appId).
 * @param {Array<{ label: string, path?: string, description?: string }>} [opts.navigation]
 *   Optional navigation targets included in the AiCsAppContext so the worker
 *   emits a `navigation.suggestion` prelude event. Omitted from the body when
 *   not provided (preserves the minimal-context contract).
 * @param {number}  [opts.port=0]       TCP port. 0 = auto-assign.
 * @returns {Promise<MockContextHandle>}
 */
export async function startMockContext({
  secret,
  appId,
  appName,
  navigation,
  port: requestedPort = 0,
}) {
  const resolvedAppName = appName ?? appId;

  /** @type {Array<{ searchParams: URLSearchParams, verified: boolean }>} */
  const requests = [];

  // Mutable one-shot failure control: when `failNext > 0` the next request(s)
  // return an unsigned 500 (decrementing the counter), which the worker surfaces
  // to the client as a 502 `app_context_unavailable`. Lets a test force exactly
  // one upstream failure to verify the client's error-classification + recovery.
  const control = { failNext: 0 };

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (control.failNext > 0) {
      control.failNext -= 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "context_backend_down" }));
      return;
    }

    // Reconstruct the path (pathname+search) the worker uses for HMAC computation.
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;

    const reqAppId = parsedUrl.searchParams.get("appId") ?? "";
    const reqUserId = parsedUrl.searchParams.get("userId") ?? "";
    // The canonical body the worker signs for context fetches is ALWAYS
    // { appId, userId } — see fetchSignedAppContext in
    // packages/ai-cs-worker/src/index.ts and the locked-in regression test
    // "signs context request body as {appId,userId} only even when currentPath
    // is present" in packages/ai-cs-worker/src/__tests__/index.test.ts.
    // currentPath (when present) rides along in the URL query string only —
    // it is deliberately excluded from the signed body so upstream product
    // verifiers don't need to track every query param the worker might add.
    // Do NOT fold currentPath back into requestBody here; doing so produces a
    // body-hash (and therefore a full signature) the worker never sent, and
    // every request fails verification with a 401 (surfaced to the widget as
    // a 502 app_context_unavailable).
    const requestBody = { appId: reqAppId, userId: reqUserId };

    const verified = verifyIncomingHmac(req, path, requestBody, secret);
    requests.push({ searchParams: parsedUrl.searchParams, verified });

    if (!verified) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid HMAC signature" }));
      return;
    }

    // Build a valid AiCsAppContext.
    // The worker's isAiCsAppContext check (index.ts L925-933) requires:
    //   assistantId === "ai-cs", authenticatedOnly === true,
    //   appId === session.appId, typeof appName === "string"
    const appContext = {
      assistantId: "ai-cs",
      appId: reqAppId || appId,
      appName: resolvedAppName,
      authenticatedOnly: true,
      ...(navigation !== undefined ? { navigation } : {}),
    };

    // Sign the response. The worker uses buildHmacPayload with:
    //   method: "GET", path: <same path>, body: <parsed app context>
    // (index.ts L375-390)
    const sigHeaders = buildResponseSignatureHeaders(path, appContext, secret);
    const body = JSON.stringify(appContext);

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

  return { url, port, close, requests, control };
}

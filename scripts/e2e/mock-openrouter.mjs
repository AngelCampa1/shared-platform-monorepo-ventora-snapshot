#!/usr/bin/env node
/**
 * Minimal mock HTTP server that stands in for the OpenRouter chat completions
 * API during local E2E tests.
 *
 * The worker calls:
 *   POST <OPENROUTER_ENDPOINT>
 *   Authorization: Bearer <key>
 *   Content-Type: application/json
 *   body: { model, provider: { order: [...] }, messages: [...] }
 *
 * This mock accepts a POST to ANY path, records every parsed request body in
 * `requests`, and responds with a canned OpenRouter-shaped payload.
 *
 * Usage:
 *   const { url, port, close, requests } = await startMockOpenRouter({ port: 0 });
 *   // url  => "http://localhost:<assigned-port>/openrouter"
 *   // pass url as OPENROUTER_ENDPOINT when booting the worker
 *   await close();
 */
import { createServer } from "node:http";

/**
 * @typedef {object} MockOpenRouterHandle
 * @property {string}   url      - Full URL to pass as OPENROUTER_ENDPOINT (includes path).
 * @property {number}   port     - Actual bound port (useful when port 0 was requested).
 * @property {() => Promise<void>} close - Gracefully shuts the server down.
 * @property {unknown[]} requests - Array of parsed request bodies recorded in order.
 */

/**
 * Start a mock OpenRouter server.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port=0]    TCP port to listen on. 0 = auto-assign.
 * @param {string}  [opts.content]   Canned assistant content to return.
 * @returns {Promise<MockOpenRouterHandle>}
 */
export async function startMockOpenRouter({
  port: requestedPort = 0,
  content = "Hello from the mock assistant.",
} = {}) {
  /** @type {unknown[]} */
  const requests = [];

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // record null for unparseable bodies
      }
      requests.push(parsed);

      const body = JSON.stringify({
        choices: [{ message: { content } }],
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });
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
  const url = `http://localhost:${port}/openrouter`;

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });

  return { url, port, close, requests };
}

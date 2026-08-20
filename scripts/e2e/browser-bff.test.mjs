import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { AI_CS_CLIENT_BUNDLE_PATH, startBrowserBff } from "./browser-bff.mjs";

test("AI-CS browser BFF pins the hosted immutable client route", () => {
  assert.equal(AI_CS_CLIENT_BUNDLE_PATH, "/client/v0.3.1/ai-cs.global.js");
});

test("AI-CS browser BFF serves HTML that loads the hosted worker client", async () => {
  const upstream = await startUpstream();
  const bff = await startBrowserBff({ aiCsBaseUrl: upstream.url });
  try {
    const res = await fetch(`${bff.url}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(
      html,
      new RegExp(
        `${upstream.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${AI_CS_CLIENT_BUNDLE_PATH}`,
      ),
    );
    assert.match(html, /window\.AiCs\.init/);
    assert.match(html, /\/api\/ai-cs\/assertion/);
  } finally {
    await bff.close();
    await upstream.close();
  }
});

test("AI-CS browser BFF signs hosted widget assertion requests", async () => {
  const upstream = await startUpstream();
  const bff = await startBrowserBff({ aiCsBaseUrl: upstream.url });
  try {
    const body = { appId: "lextract", userId: "e2e-browser-user" };
    const res = await fetch(`${bff.url}/api/ai-cs/assertion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/v1/sessions", body }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.body, body);
    assert.equal(typeof json.headers["X-Ventora-Timestamp"], "string");
    assert.equal(typeof json.headers["X-Ventora-Nonce"], "string");
    assert.match(json.headers["X-Ventora-Signature"], /^[a-f0-9]{64}$/);
  } finally {
    await bff.close();
    await upstream.close();
  }
});

/**
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
function startUpstream() {
  const server = createServer((_, res) => {
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("upstream did not bind to a TCP port");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) =>
            server.close((err) => (err ? rejectClose(err) : resolveClose(undefined))),
          ),
      });
    });
  });
}

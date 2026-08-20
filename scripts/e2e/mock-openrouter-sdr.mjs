#!/usr/bin/env node
/**
 * Smart OpenRouter mock for the SDR → CRM pipeline E2E harness.
 *
 * Unlike the simple mock-openrouter.mjs (which returns one canned response for
 * every POST), this mock branches on the incoming system-message content:
 *
 *   - EXTRACTION call: system message contains "qualification data extractor"
 *     → returns a fully-populated LeadProfile JSON string sufficient to score
 *       "qualified" (fitScore >= 0.5, intentScore >= 0.4, contact.email set).
 *
 *   - CHAT call (all other POSTs)
 *     → returns a canned, friendly assistant sentence.
 *
 * Recorded requests are available on the `requests` array for call-count
 * assertions. The existing mock-openrouter.mjs is intentionally left untouched;
 * this module is a focused sibling for the CRM pipeline test only.
 *
 * Usage:
 *   const mock = await startMockSdrOpenRouter();
 *   // pass mock.url as OPENROUTER_ENDPOINT when booting ai-sdr-worker
 *   const chatCalls      = mock.chatRequests.length;
 *   const extractCalls   = mock.extractRequests.length;
 *   await mock.close();
 */
import { createServer } from "node:http";

/** Canned chat reply the widget renders in the assistant bubble. */
export const CHAT_REPLY =
  "Thanks for reaching out! GrantPipe helps nonprofits stay compliant and organized across all their grants.";

/**
 * Fully-populated extraction JSON that scores "qualified":
 *   fitScore = 0.75 (>= 0.5)  intentScore = 0.80 (>= 0.4)
 * contact.email is required by the CRM body validator (else 400).
 */
const EXTRACTION_JSON = JSON.stringify({
  contact: {
    name: "Dana Rivera",
    email: "dana@example.org",
    company: "Riverside Foundation",
    role: "Development Director",
    phone: null,
  },
  qualification: {
    needPain: "Struggling to track restricted funds and stay compliant across multiple grants",
    useCase: "Grant compliance tracking and donor management in one system",
    timeline: "Evaluating this quarter, budget already approved",
    budgetSignal: "Budget approved, looking for a solution under $10K/year",
    authority: "Development Director with budget sign-off",
    productInterest: "GrantPipe compliance + donor modules",
  },
  derived: {},
});

/**
 * @typedef {object} MockSdrOpenRouterHandle
 * @property {string}    url              - URL to pass as OPENROUTER_ENDPOINT.
 * @property {number}    port             - Actual bound port.
 * @property {() => Promise<void>} close  - Gracefully shuts the server down.
 * @property {unknown[]} requests         - All parsed request bodies (chat + extract).
 * @property {unknown[]} chatRequests     - Only the chat-path request bodies.
 * @property {unknown[]} extractRequests  - Only the extraction-path request bodies.
 */

/**
 * Detect whether this OpenRouter request is the extraction call.
 *
 * The extraction system prompt begins exactly:
 *   "You are a qualification data extractor for an AI sales assistant."
 * (from lead-profile.ts buildSystemPrompt)
 *
 * @param {unknown} body
 * @returns {boolean}
 */
function isExtractionRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const messages = /** @type {Record<string,unknown>} */ (body).messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
      const role = /** @type {Record<string,unknown>} */ (msg).role;
      const content = /** @type {Record<string,unknown>} */ (msg).content;
      if (role === "system" && typeof content === "string") {
        return content.includes("qualification data extractor");
      }
    }
  }
  return false;
}

/**
 * Start the smart SDR-specific mock OpenRouter server.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port=0]  TCP port. 0 = auto-assign.
 * @returns {Promise<MockSdrOpenRouterHandle>}
 */
export async function startMockSdrOpenRouter({ port: requestedPort = 0 } = {}) {
  /** @type {unknown[]} */
  const requests = [];
  /** @type {unknown[]} */
  const chatRequests = [];
  /** @type {unknown[]} */
  const extractRequests = [];

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
      /** @type {unknown} */
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // record null for unparseable bodies
      }
      requests.push(parsed);

      const extract = isExtractionRequest(parsed);
      const content = extract ? EXTRACTION_JSON : CHAT_REPLY;

      if (extract) {
        extractRequests.push(parsed);
      } else {
        chatRequests.push(parsed);
      }

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

  return { url, port, close, requests, chatRequests, extractRequests };
}

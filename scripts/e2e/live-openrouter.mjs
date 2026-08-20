#!/usr/bin/env node
/**
 * LIVE OpenRouter check (manual; makes REAL, billable minimax/minimax-m3 calls).
 *
 * NOT part of `pnpm verify` / the default test suite. Run explicitly:
 *
 *   node scripts/e2e/live-openrouter.mjs
 *
 * Reads OPENROUTER_API_KEY from the repo-root `.env.local` (gitignored) or the
 * environment. It:
 *   1. Sanity-calls OpenRouter directly for `minimax/minimax-m3` and confirms
 *      the response model echoes minimax.
 *   2. Boots the real ai-cs + ai-sdr workers locally (real key, NO endpoint
 *      override -> hits openrouter.ai) with mock signed-context endpoints, then
 *      drives a real authenticated chat through each worker's full pipeline and
 *      prints the actual assistant text so persona quality can be judged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startE2eWorkers } from "./boot-e2e-workers.mjs";
import { E2E_ALLOWED_ORIGIN, signClientAssertion } from "./client-assertion.mjs";
import { startMockContext } from "./mock-context.mjs";
import { startMockProductContext } from "./mock-product-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** @returns {string} */
function loadKey() {
  if (typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  try {
    const text = readFileSync(resolve(ROOT, ".env.local"), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith("OPENROUTER_API_KEY="));
    if (line) {
      return line
        .slice("OPENROUTER_API_KEY=".length)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall through */
  }
  throw new Error("OPENROUTER_API_KEY not found in env or .env.local");
}

const MODEL = "minimax/minimax-m3";
const CONTEXT_SECRET = "e2e-harness-context-secret";
const SDR_CONTEXT_SECRET = "e2e-harness-sdr-context-secret";

/** @param {string} text */
function parseSse(text) {
  return text
    .trim()
    .split(/(?:\r\n|\r|\n){2}/)
    .filter((b) => b.trim().length > 0)
    .map((b) => {
      const lines = b.split(/\r\n|\r|\n/);
      const event = (lines.find((l) => l.startsWith("event: ")) ?? "event: ").slice(7);
      const dataLine = lines.find((l) => l.startsWith("data: ")) ?? "data: null";
      let data = null;
      try {
        data = JSON.parse(dataLine.slice(6));
      } catch {
        /* keep null */
      }
      return { event, data };
    });
}

/** @param {Array<{event:string,data:unknown}>} events */
function joinDeltas(events) {
  return events
    .filter((e) => e.event === "message.delta")
    .map((e) => /** @type {{delta?: unknown}} */ (e.data).delta)
    .filter((d) => typeof d === "string")
    .join("");
}

async function directSanity(key) {
  console.info(`\n=== 1. Direct OpenRouter sanity call (${MODEL}) ===`);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly: minimax online" }],
    }),
  });
  console.info("HTTP", res.status);
  const json = /** @type {{model?: string, choices?: Array<{message?: {content?: string}}>}} */ (
    await res.json()
  );
  assert.equal(res.ok, true, `OpenRouter returned ${res.status}: ${JSON.stringify(json)}`);
  console.info("response model:", json.model);
  console.info("content:", json.choices?.[0]?.message?.content);
  assert.ok(
    typeof json.model === "string" && json.model.includes("minimax"),
    `expected a minimax model, got ${json.model}`,
  );
  console.info("PASS: key valid, minimax/minimax-m3 reachable.");
}

async function main() {
  const key = loadKey();
  await directSanity(key);

  console.info("\n=== Booting real ai-cs + ai-sdr workers (real OpenRouter, mock context) ===");
  const csCtx = await startMockContext({
    secret: CONTEXT_SECRET,
    appId: "lextract",
    appName: "Lextract",
    navigation: [
      {
        label: "Members",
        path: "/settings/members",
        description: "Invite and manage board members",
      },
      {
        label: "Billing",
        path: "/settings/billing",
        description: "Manage your subscription and plan",
      },
      { label: "Boards", path: "/boards", description: "Create and open boards" },
    ],
  });
  const sdrCtx = await startMockProductContext({
    secret: SDR_CONTEXT_SECRET,
    product: {
      productId: "lextract",
      name: "Lextract",
      description:
        "Lextract helps teams pull facts from documents. Upload a file, check the fields, and send clean data to the tools your team uses.",
      plans: [
        {
          id: "pro",
          name: "Pro",
          annualPrice: "$240/yr",
          monthlyPrice: "$25/mo",
          defaultCadence: "year",
          discount: "50% off annual",
          trialDays: 14,
          features: [
            "Unlimited boards",
            "Secure document vault",
            "Meeting minutes",
            "Action tracking",
          ],
        },
      ],
      sources: [
        {
          title: "Lextract overview",
          excerpt: "Run board meetings, share documents securely, track decisions.",
          url: "https://lextract.app",
        },
      ],
    },
  });

  const harness = await startE2eWorkers({
    build: process.env.E2E_NO_BUILD !== "1",
    extraVars: {
      aiCs: [
        `OPENROUTER_API_KEY:${key}`,
        `AI_CS_CONTEXT_ENDPOINT:${csCtx.url}`,
        `AI_CS_CONTEXT_SECRET:${CONTEXT_SECRET}`,
      ],
      aiSdr: [
        `OPENROUTER_API_KEY:${key}`,
        `AI_SDR_CONTEXT_ENDPOINT:${sdrCtx.url}`,
        `AI_SDR_CONTEXT_SECRET:${SDR_CONTEXT_SECRET}`,
      ],
    },
  });

  try {
    // ---- AI-CS: how-to-use expert ----
    console.info("\n=== 2. AI-CS live chat (how-to-use expert) ===");
    {
      const base = harness.workers.aiCs.baseUrl;
      const sBody = { appId: "lextract", userId: "live-user" };
      const sRes = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signClientAssertion({ path: "/v1/sessions", body: sBody }),
        },
        body: JSON.stringify(sBody),
      });
      assert.equal(sRes.status, 201);
      const sessionId = /** @type {{sessionId: string}} */ (await sRes.json()).sessionId;
      const cBody = {
        appId: sBody.appId,
        userId: sBody.userId,
        sessionId,
        message: "How do I add a new board member?",
      };
      const cRes = await fetch(`${base}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signClientAssertion({ path: "/v1/chat", body: cBody }),
        },
        body: JSON.stringify(cBody),
      });
      console.info("chat HTTP", cRes.status);
      const events = parseSse(await cRes.text());
      console.info("events:", events.map((e) => e.event).join(", "));
      console.info(`ASSISTANT (AI-CS):\n${joinDeltas(events)}`);
    }

    // ---- AI-SDR: what-it-does / what-it-solves expert ----
    console.info("\n=== 3. AI-SDR live chat (what-it-does / solves expert) ===");
    {
      const base = harness.workers.aiSdr.baseUrl;
      const sBody = { productId: "lextract" };
      const sRes = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signClientAssertion({ path: "/v1/sessions", body: sBody }),
        },
        body: JSON.stringify(sBody),
      });
      assert.equal(sRes.status, 201);
      const sessionId = /** @type {{sessionId: string}} */ (await sRes.json()).sessionId;
      const cBody = {
        sessionId,
        message: "What does Lextract do and what problem does it solve?",
      };
      const cRes = await fetch(`${base}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: E2E_ALLOWED_ORIGIN,
          ...signClientAssertion({ path: "/v1/chat", body: cBody }),
        },
        body: JSON.stringify(cBody),
      });
      console.info("chat HTTP", cRes.status);
      const events = parseSse(await cRes.text());
      console.info("events:", events.map((e) => e.event).join(", "));
      console.info(`ASSISTANT (AI-SDR):\n${joinDeltas(events)}`);
    }

    console.info("\nLIVE CHECK COMPLETE.");
  } finally {
    harness.stop();
    await csCtx.close();
    await sdrCtx.close();
  }
}

main().catch((err) => {
  console.error("LIVE CHECK FAILED:", err);
  process.exitCode = 1;
});

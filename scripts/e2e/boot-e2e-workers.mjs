#!/usr/bin/env node
/**
 * Boots the ai-cs-worker and ai-sdr-worker locally for E2E testing with the
 * founder-approved `--var` override mechanism:
 *
 *   - ENVIRONMENT:development           (matches the approved E2E boot mode)
 *   - AI_*_CLIENT_ASSERTION_SECRET:...  (forces the REAL HMAC signing path —
 *                                        with the secret set, the worker requires
 *                                        a valid signature regardless of mode)
 *   - AI_*_ALLOWED_ORIGINS:localhost    (allowlists exactly the E2E origin)
 *
 * NOTHING is committed: these overrides exist only in the spawned `wrangler dev`
 * processes. The production `wrangler.toml` (ENVIRONMENT=production, prod origins,
 * secret via `wrangler secret put`) is untouched.
 */
import {
  WORKERS,
  bootWorker,
  buildDeps,
  snapshotDescendants,
  teardown,
  waitForHealthy,
} from "../dev-workers.mjs";
import { E2E_ALLOWED_ORIGIN, E2E_CLIENT_ASSERTION_SECRET } from "./client-assertion.mjs";

/**
 * Per-worker `--var` overrides for E2E mode.
 *
 * `endpointsVar` is cleared to empty so a developer-local `.dev.vars` (auto-loaded
 * by `wrangler dev` from the worker package dir) cannot leak an
 * `AI_*_CONTEXT_ENDPOINTS` appId->endpoint map into the harness. The worker checks
 * that plural map FIRST; if the test appId is absent it resolves the context
 * endpoint to null and `/v1/chat` 502s before ever reading the singular
 * `AI_*_CONTEXT_ENDPOINT` the harness injects. Clearing it here keeps every harness
 * consumer (browser, screenshots, live-openrouter, core E2E) immune.
 * @param {string} secretVar  env var name for the client-assertion secret
 * @param {string} originsVar env var name for the allowed-origins CSV
 * @param {string} endpointsVar env var name for the plural context-endpoints map
 * @returns {string[]}
 */
function e2eVars(secretVar, originsVar, endpointsVar) {
  return [
    "ENVIRONMENT:development",
    `${secretVar}:${E2E_CLIENT_ASSERTION_SECRET}`,
    `${originsVar}:${E2E_ALLOWED_ORIGIN}`,
    `${endpointsVar}:`,
  ];
}

/** @type {{ key: "aiCs" | "aiSdr", workerName: string, secretVar: string, originsVar: string, endpointsVar: string }[]} */
const E2E_TARGETS = [
  {
    key: "aiCs",
    workerName: "ai-cs-worker",
    secretVar: "AI_CS_CLIENT_ASSERTION_SECRET",
    originsVar: "AI_CS_ALLOWED_ORIGINS",
    endpointsVar: "AI_CS_CONTEXT_ENDPOINTS",
  },
  {
    key: "aiSdr",
    workerName: "ai-sdr-worker",
    secretVar: "AI_SDR_CLIENT_ASSERTION_SECRET",
    originsVar: "AI_SDR_ALLOWED_ORIGINS",
    endpointsVar: "AI_SDR_CONTEXT_ENDPOINTS",
  },
];

/**
 * @typedef {{ baseUrl: string, port: number }} BootedWorker
 * @typedef {{ workers: Record<"aiCs" | "aiSdr", BootedWorker>, stop: () => void }} E2eWorkers
 */

/**
 * Builds worker deps (unless skipped), boots ai-cs + ai-sdr with E2E `--var`
 * overrides, and waits for both to become healthy.
 *
 * `extraVars` injects additional per-worker `wrangler dev --var KEY:VALUE`
 * overrides (e.g. mock OpenRouter + signed-context endpoints for the chat-SSE
 * E2E). Like the baseline E2E vars, these exist only in the spawned dev
 * processes — nothing is written to any committed `wrangler.toml`.
 *
 * @param {{ build?: boolean, timeoutMs?: number, extraVars?: Partial<Record<"aiCs" | "aiSdr", string[]>> }} [opts]
 * @returns {Promise<E2eWorkers>}
 */
export async function startE2eWorkers({ build = true, timeoutMs = 120_000, extraVars = {} } = {}) {
  if (build) {
    await buildDeps();
  }

  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  /** @type {Partial<Record<"aiCs" | "aiSdr", BootedWorker>>} */
  const workers = {};
  /** @type {number[]} */
  let descendants = [];

  const stop = () => teardown(children, descendants);

  try {
    for (const target of E2E_TARGETS) {
      const def = WORKERS.find((w) => w.name === target.workerName);
      if (!def) {
        throw new Error(`Unknown worker in harness definition: ${target.workerName}`);
      }
      const vars = [
        ...e2eVars(target.secretVar, target.originsVar, target.endpointsVar),
        ...(extraVars[target.key] ?? []),
      ];
      const child = bootWorker(def, { vars });
      children.push(child);
      workers[target.key] = { baseUrl: `http://127.0.0.1:${def.port}`, port: def.port };
    }

    const health = await Promise.all(
      E2E_TARGETS.map(async (target) => {
        const w = workers[target.key];
        if (!w) {
          return { name: target.workerName, ok: false, error: "not booted" };
        }
        const result = await waitForHealthy(w.port, { timeoutMs });
        return { name: target.workerName, ...result };
      }),
    );

    descendants = snapshotDescendants(children.map((c) => c.pid));

    const failed = health.filter((h) => !h.ok);
    if (failed.length > 0) {
      const detail = failed
        .map((h) => `${h.name}: ${"error" in h ? h.error : "unhealthy"}`)
        .join("; ");
      throw new Error(`E2E workers failed to become healthy: ${detail}`);
    }

    return { workers: /** @type {Record<"aiCs" | "aiSdr", BootedWorker>} */ (workers), stop };
  } catch (err) {
    stop();
    throw err;
  }
}

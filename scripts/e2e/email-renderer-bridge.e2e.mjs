/**
 * Cross-language E2E for the @ventora/email-renderer bridge (X7.2(b) #8).
 *
 * This is the Python<->TS runtime seam called out in CLAUDE.md: `ventora_email`
 * (Python) renders React Email templates by POSTing to the email-renderer
 * Cloudflare Worker over HTTP. Both sides are unit-tested in isolation today —
 * the Python client mocks `httpx`, the worker fakes `render()` — so the actual
 * cross-language contract (HMAC payload byte-equality + a real React Email
 * render round-trip) has never been exercised end-to-end. This closes that gap.
 *
 * The harness:
 *   1. Boots the REAL `ventora-email-renderer` worker via `wrangler dev --local`
 *      with `RENDERER_HMAC_SECRET` injected by `--var` — this forces the worker's
 *      SIGNED path (with a secret configured, every request must carry a valid
 *      HMAC), i.e. the production security boundary, not the dev unsigned bypass.
 *   2. Drives the REAL `ventora_email.TemplateRenderer` Python client (via
 *      `uv run --project py python scripts/e2e/email_bridge_driver.py`) against
 *      the booted worker. The client signs with `hmac`/`hashlib` over
 *      `json.dumps(separators=(",",":"))`; the worker re-derives the payload with
 *      `JSON.stringify`. If those two serializations ever drift, the signature
 *      fails and this test goes red — which is exactly the regression we want.
 *
 * Nothing is committed to any `wrangler.toml`: the secret lives only in the
 * spawned dev process. Not in the `verify` gate (boots a worker + needs uv),
 * consistent with the other `test:e2e*` scripts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKERS,
  bootWorker,
  snapshotDescendants,
  teardown,
  waitForHealthy,
} from "../dev-workers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const PY_DIR = join(REPO_ROOT, "py");
const DRIVER = join(__dirname, "email_bridge_driver.py");

const RENDERER_SECRET = "e2e-email-renderer-hmac-secret";
const BOOT_TIMEOUT_MS = 120_000;

/** Resolve an available `uv` launcher the same way `scripts/run-python-smoke.mjs` does. */
function resolveUv() {
  const candidates = [
    { command: "uv", args: [] },
    { command: "python", args: ["-m", "uv"] },
    { command: "py", args: ["-m", "uv"] },
  ];
  return candidates.find(
    (c) =>
      spawnSync(c.command, [...c.args, "--version"], { stdio: "ignore", shell: true }).status === 0,
  );
}

const uv = resolveUv();

/**
 * Run the Python bridge driver against the booted worker and parse its single
 * JSON stdout line.
 * @param {{ url: string, secret?: string, template: string, vars: Record<string, unknown> }} opts
 * @returns {{ html?: string, text?: string, error?: string, status?: number|null, driverError?: string }}
 */
function runBridge({ url, secret, template, vars }) {
  const env = {
    ...process.env,
    EMAIL_RENDERER_URL: url,
    EMAIL_TEMPLATE: template,
    EMAIL_VARS_JSON: JSON.stringify(vars),
  };
  if (secret !== undefined) env.EMAIL_RENDERER_SECRET = secret;

  const result = spawnSync(uv.command, [...uv.args, "run", "--project", PY_DIR, "python", DRIVER], {
    encoding: "utf8",
    shell: true,
    env,
  });

  if (result.status !== 0) {
    throw new Error(
      `bridge driver exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  assert.ok(line, `bridge driver produced no JSON output\nstderr: ${result.stderr}`);
  return JSON.parse(line);
}

describe("email-renderer Python<->TS bridge E2E", () => {
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  /** @type {number[]} */
  let descendants = [];
  /** @type {string} */
  let baseUrl;

  before(async () => {
    assert.ok(uv, "uv (or `python -m uv`) is required to drive the Python email client");

    const def = WORKERS.find((w) => w.name === "email-renderer");
    assert.ok(def, "email-renderer worker definition not found");
    baseUrl = `http://127.0.0.1:${def.port}`;

    // `dev-workers.buildDeps()` only builds the ai-worker closures. The
    // email-renderer worker dynamically imports `@ventora/email-templates`,
    // whose `exports` map points at `dist/` — so that package (and the renderer
    // closure) must be built first or the worker's import 422s at render time.
    const build = spawnSync("pnpm", ["--filter", "@ventora/email-renderer...", "run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: true,
    });
    assert.equal(build.status, 0, "build of the email-renderer dependency closure failed");

    // Pre-sync the py workspace so the per-test `uv run` calls are fast and
    // deterministic (mirrors scripts/run-python-smoke.mjs).
    const sync = spawnSync(uv.command, [...uv.args, "sync", "--project", PY_DIR], {
      stdio: "inherit",
      shell: true,
    });
    assert.equal(sync.status, 0, "uv sync of the py workspace failed");

    child = bootWorker(def, { vars: [`RENDERER_HMAC_SECRET:${RENDERER_SECRET}`] });
    const health = await waitForHealthy(def.port, { timeoutMs: BOOT_TIMEOUT_MS });
    descendants = snapshotDescendants([child.pid]);
    assert.ok(health.ok, `email-renderer failed to become healthy: ${JSON.stringify(health)}`);
  });

  after(() => {
    teardown(child ? [child] : [], descendants);
  });

  test("renders the welcome template through the real signed client round-trip", () => {
    const vars = {
      productName: "Lextract",
      firstName: "Angel",
      loginUrl: "https://app.lextract.example/login",
      trialDays: 14,
    };
    const out = runBridge({ url: baseUrl, secret: RENDERER_SECRET, template: "welcome", vars });

    assert.equal(out.error, undefined, `unexpected client error: ${JSON.stringify(out)}`);
    assert.equal(out.driverError, undefined, `driver error: ${out.driverError}`);
    assert.match(out.html, /<html/i);
    assert.ok(out.html.includes("Lextract"), "html missing productName");
    assert.ok(out.html.includes("Angel"), "html missing firstName");
    assert.ok(
      out.html.includes("https://app.lextract.example/login"),
      "html missing loginUrl button href",
    );
    assert.ok(out.text.includes("Lextract"), "plain-text variant missing productName");
    assert.ok(out.text.length > 0, "plain-text variant is empty");
  });

  test("renders a second template (payment-receipt) — bridge is not welcome-specific", () => {
    const vars = {
      amount: "$49.00",
      currency: "USD",
      planName: "Pro",
      date: "June 1, 2026",
    };
    const out = runBridge({
      url: baseUrl,
      secret: RENDERER_SECRET,
      template: "payment-receipt",
      vars,
    });

    assert.equal(out.error, undefined, `unexpected client error: ${JSON.stringify(out)}`);
    assert.match(out.html, /<html/i);
    assert.ok(out.html.includes("$49.00"), "html missing amount");
    assert.ok(out.html.includes("Pro"), "html missing planName");
  });

  test("rejects a request signed with the wrong secret (401)", () => {
    const vars = { productName: "Lextract", loginUrl: "https://x.example/login" };
    const out = runBridge({
      url: baseUrl,
      secret: "this-is-not-the-server-secret",
      template: "welcome",
      vars,
    });

    assert.equal(out.html, undefined, "wrong secret should not produce rendered html");
    assert.equal(out.status, 401, `expected 401, got ${JSON.stringify(out)}`);
    assert.equal(out.error, "HTTPStatusError");
  });

  test("rejects an unsigned client against the secret-protected worker (401)", () => {
    const vars = { productName: "Lextract", loginUrl: "https://x.example/login" };
    // secret omitted -> the client sends no timestamp/nonce/hmac; the worker has
    // RENDERER_HMAC_SECRET configured, so the unsigned request is unauthorized.
    const out = runBridge({ url: baseUrl, template: "welcome", vars });

    assert.equal(out.html, undefined, "unsigned request should not produce rendered html");
    assert.equal(out.status, 401, `expected 401, got ${JSON.stringify(out)}`);
    assert.equal(out.error, "HTTPStatusError");
  });
});

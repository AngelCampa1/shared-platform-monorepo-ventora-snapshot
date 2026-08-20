#!/usr/bin/env node
/**
 * Boots all 5 deployable Cloudflare Workers locally via `wrangler dev` (miniflare /
 * local mode — no Cloudflare auth required) and health-checks each one.
 *
 * Usage:
 *   node scripts/dev-workers.mjs                        # build deps + boot + keep running (Ctrl-C to stop)
 *   node scripts/dev-workers.mjs --check                # build deps + boot + verify healthy + exit 0/1
 *   node scripts/dev-workers.mjs --check --timeout 120000
 *   node scripts/dev-workers.mjs --no-build             # skip dep build (use when dist/ already exists)
 *   node scripts/dev-workers.mjs --check --no-build
 */
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(__dir, "..");

/**
 * @typedef {{ name: string, packageDir: string, port: number }} WorkerDef
 */

/** @type {WorkerDef[]} */
export const WORKERS = [
  {
    name: "ai-sdr-worker",
    packageDir: resolve(ROOT, "packages", "ai-sdr-worker"),
    port: 8811,
  },
  {
    name: "ai-cs-worker",
    packageDir: resolve(ROOT, "packages", "ai-cs-worker"),
    port: 8812,
  },
  {
    name: "email-renderer",
    packageDir: resolve(ROOT, "packages", "email-renderer"),
    port: 8813,
  },
  {
    name: "package-registry",
    packageDir: resolve(ROOT, "packages", "package-registry"),
    port: 8814,
  },
  {
    name: "python-registry",
    packageDir: resolve(ROOT, "packages", "python-registry"),
    port: 8815,
  },
];

/**
 * Returns the URL to probe for a given port.
 * @param {number} port
 * @returns {string}
 */
export function healthCheckUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

/**
 * Returns true for any valid HTTP status code (100-599). Any response means the
 * worker booted and is serving — workers return 404/405 on `/` by design.
 * @param {number | null | undefined} statusCode
 * @returns {boolean}
 */
export function isHealthy(statusCode) {
  return typeof statusCode === "number" && statusCode >= 100 && statusCode <= 599;
}

/**
 * Polls `healthCheckUrl(port)` until any HTTP response is received or the timeout
 * elapses. Connection-refused errors are treated as "not up yet".
 * @param {number} port
 * @param {{ timeoutMs?: number, intervalMs?: number }} opts
 * @returns {Promise<{ok: true, status: number} | {ok: false, error: string}>}
 */
export async function waitForHealthy(port, { timeoutMs = 90_000, intervalMs = 500 } = {}) {
  const url = healthCheckUrl(port);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(intervalMs * 2, 5_000)),
      });
      if (isHealthy(res.status)) {
        return { ok: true, status: res.status };
      }
    } catch {
      // connection refused or timeout — keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  return { ok: false, error: `Timed out after ${timeoutMs}ms waiting for port ${port}` };
}

/**
 * Returns the argv array for the pnpm build command that builds the dependency
 * closure of both AI workers (and their internal workspace deps such as the
 * contracts packages). Uses the `pkg...` pnpm filter syntax so new internal
 * deps are automatically included without updating this file.
 * @returns {string[]}
 */
export function buildDepsArgs() {
  return [
    "--filter",
    "@ventora/ai-sdr-worker...",
    "--filter",
    "@ventora/ai-cs-worker...",
    "run",
    "build",
  ];
}

/**
 * Spawns `pnpm <buildDepsArgs()>` from the repo root, streaming output to
 * stdio. Resolves on exit code 0; rejects with a descriptive Error on any
 * non-zero exit code.
 * @returns {Promise<void>}
 */
export function buildDeps() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", buildDepsArgs(), {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn pnpm build: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Worker dependency build failed with exit code ${code ?? "null"}`));
      }
    });
  });
}

/**
 * Spawns `pnpm exec wrangler dev --port <port> --local --ip 127.0.0.1` in the
 * worker's package directory and returns the child process handle.
 *
 * `options.vars` appends one `--var KEY:VALUE` flag per entry AFTER the base
 * args. `wrangler dev --var` overrides `[vars]` for the spawned process only
 * (nothing is written to `wrangler.toml`) and splits each entry on the FIRST
 * colon, so URL values like `http://localhost:5173` survive intact.
 * @param {WorkerDef} def
 * @param {{ vars?: string[] }} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function bootWorker(def, options = {}) {
  const args = [
    "exec",
    "wrangler",
    "dev",
    "--port",
    String(def.port),
    "--local",
    "--ip",
    "127.0.0.1",
  ];

  for (const pair of options.vars ?? []) {
    args.push("--var", pair);
  }

  const child = spawn("pnpm", args, {
    cwd: def.packageDir,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const prefix = `[${def.name}] `;

  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    }
  });

  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) process.stderr.write(`${prefix}${line}\n`);
    }
  });

  child.on("error", (err) => {
    process.stderr.write(`${prefix}spawn error: ${err.message}\n`);
  });

  return child;
}

/**
 * Parses the stdout of a `pid,ppid`-per-line process dump into structured rows.
 * Skips blanks, an optional header row, and any line whose two fields are not
 * both integers.
 * @param {string} text
 * @returns {{ pid: number, ppid: number }[]}
 */
export function parseProcessRows(text) {
  /** @type {{ pid: number, ppid: number }[]} */
  const rows = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length !== 2) continue;
    const pidStr = parts[0].trim();
    const ppidStr = parts[1].trim();
    if (!/^\d+$/.test(pidStr) || !/^\d+$/.test(ppidStr)) continue;
    rows.push({ pid: Number(pidStr), ppid: Number(ppidStr) });
  }
  return rows;
}

/**
 * Builds a parent→children adjacency map from process rows.
 * @param {{ pid: number, ppid: number }[]} rows
 * @returns {Map<number, number[]>}
 */
export function buildChildrenMap(rows) {
  /** @type {Map<number, number[]>} */
  const map = new Map();
  for (const { pid, ppid } of rows) {
    const list = map.get(ppid);
    if (list) list.push(pid);
    else map.set(ppid, [pid]);
  }
  return map;
}

/**
 * Returns every descendant PID of the given root PIDs (excluding the roots
 * themselves), walking the parent→children map breadth-first. Cycle-safe.
 * @param {(number | null | undefined)[]} rootPids
 * @param {Map<number, number[]>} childrenByParent
 * @returns {number[]}
 */
export function collectDescendants(rootPids, childrenByParent) {
  /** @type {Set<number>} seeded with roots so a cycle can never re-emit a root */
  const seen = new Set();
  /** @type {number[]} */
  const queue = [];
  for (const root of rootPids) {
    if (typeof root === "number" && Number.isInteger(root)) {
      queue.push(root);
      seen.add(root);
    }
  }
  /** @type {number[]} */
  const out = [];
  while (queue.length > 0) {
    const current = /** @type {number} */ (queue.shift());
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * On Windows, snapshots the live process table and returns all descendant PIDs
 * of the given root PIDs while the parent→child links are still intact. Call
 * this AFTER workers are healthy so miniflare's `workerd` children exist and
 * are still reachable from our spawned shells — once an intermediate process
 * exits, the orphaned `workerd` PPID link breaks and `taskkill /T` can no
 * longer reach it. Returns [] on non-Windows or on any failure.
 * @param {(number | null | undefined)[]} rootPids
 * @returns {number[]}
 */
export function snapshotDescendants(rootPids) {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return collectDescendants(rootPids, buildChildrenMap(parseProcessRows(out)));
  } catch {
    return [];
  }
}

/**
 * Kills exactly the child processes this script spawned — never by image name.
 * On Windows uses `taskkill /pid <pid> /T /F` to terminate each spawned process
 * tree, then force-kills any pre-snapshotted descendant PIDs (e.g. orphaned
 * miniflare `workerd` children whose PPID link to our tree was severed when an
 * intermediate process exited). Only PIDs positively identified as descendants
 * of our own spawned processes are killed — never by image name.
 * @param {import("node:child_process").ChildProcess[]} children
 * @param {number[]} [extraPids] descendant PIDs captured by snapshotDescendants
 */
export function teardown(children, extraPids = []) {
  for (const child of children) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      if (process.platform === "win32" && child.pid !== undefined) {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // best-effort
    }
  }

  if (process.platform === "win32") {
    const ownPids = new Set(children.map((c) => c.pid));
    for (const pid of extraPids) {
      if (ownPids.has(pid)) continue;
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // already dead or unreachable — best-effort
      }
    }
  }
}

/**
 * Main entry point: boots all workers, waits for each to become healthy, prints
 * a status table, then either exits (--check) or waits for SIGINT/SIGTERM.
 */
async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const noBuild = args.includes("--no-build");
  const timeoutIndex = args.indexOf("--timeout");
  const timeoutMs =
    timeoutIndex !== -1 && args[timeoutIndex + 1] !== undefined
      ? Number(args[timeoutIndex + 1])
      : 90_000;

  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];

  /** @type {number[]} descendant PIDs captured once workers are healthy */
  let ownedDescendants = [];

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nShutting down workers...\n");
    teardown(children, ownedDescendants);
  }

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("exit", () => {
    if (!shuttingDown) teardown(children, ownedDescendants);
  });

  if (!noBuild) {
    process.stdout.write("Building worker dependencies...\n");
    try {
      await buildDeps();
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  process.stdout.write("Booting workers...\n");
  for (const def of WORKERS) {
    const child = bootWorker(def);
    children.push(child);
    process.stdout.write(`  started ${def.name} (pid ${child.pid ?? "?"}) on port ${def.port}\n`);
  }

  process.stdout.write("\nWaiting for workers to become healthy...\n");

  /** @type {Promise<{def: WorkerDef, result: {ok: true, status: number} | {ok: false, error: string}}>[] } */
  const checks = WORKERS.map(async (def) => {
    const result = await waitForHealthy(def.port, { timeoutMs });
    return { def, result };
  });

  const outcomes = await Promise.all(checks);

  // Snapshot descendant PIDs now, while the process tree is intact — miniflare's
  // workerd children are running and still reachable from our spawned shells.
  // Captured here so teardown can reap them even after intermediate processes
  // exit and sever the PPID chain (the orphaned-workerd-on-Windows problem).
  ownedDescendants = snapshotDescendants(children.map((c) => c.pid));

  const colName = 20;
  const colPort = 6;
  const colStatus = 10;
  const colCode = 10;

  const pad = (s, n) => String(s).padEnd(n);
  const hr = "-".repeat(colName + colPort + colStatus + colCode + 3);

  process.stdout.write(`\n${hr}\n`);
  process.stdout.write(
    `${pad("worker", colName)} ${pad("port", colPort)} ${pad("status", colStatus)} ${pad("http", colCode)}\n`,
  );
  process.stdout.write(`${hr}\n`);

  let allHealthy = true;
  for (const { def, result } of outcomes) {
    const statusLabel = result.ok ? "healthy" : "FAILED";
    const codeLabel = result.ok ? String(result.status) : result.error.slice(0, 9);
    process.stdout.write(
      `${pad(def.name, colName)} ${pad(def.port, colPort)} ${pad(statusLabel, colStatus)} ${pad(codeLabel, colCode)}\n`,
    );
    if (!result.ok) allHealthy = false;
  }

  process.stdout.write(`${hr}\n\n`);

  if (checkMode) {
    shutdown();
    process.exit(allHealthy ? 0 : 1);
  } else {
    process.stdout.write("Workers running. Press Ctrl-C to stop.\n");
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

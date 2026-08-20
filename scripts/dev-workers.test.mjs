import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as http from "node:http";
import { test } from "node:test";
import {
  WORKERS,
  buildChildrenMap,
  buildDepsArgs,
  collectDescendants,
  healthCheckUrl,
  isHealthy,
  parseProcessRows,
  waitForHealthy,
} from "./dev-workers.mjs";

// ---------------------------------------------------------------------------
// isHealthy
// ---------------------------------------------------------------------------

test("isHealthy returns true for 200", () => {
  assert.equal(isHealthy(200), true);
});

test("isHealthy returns true for 404", () => {
  assert.equal(isHealthy(404), true);
});

test("isHealthy returns true for 405", () => {
  assert.equal(isHealthy(405), true);
});

test("isHealthy returns true for 500", () => {
  assert.equal(isHealthy(500), true);
});

test("isHealthy returns true for 100 (minimum boundary)", () => {
  assert.equal(isHealthy(100), true);
});

test("isHealthy returns true for 599 (maximum boundary)", () => {
  assert.equal(isHealthy(599), true);
});

test("isHealthy returns false for null", () => {
  assert.equal(isHealthy(null), false);
});

test("isHealthy returns false for undefined", () => {
  assert.equal(isHealthy(undefined), false);
});

test("isHealthy returns false for 0", () => {
  assert.equal(isHealthy(0), false);
});

test("isHealthy returns false for 600", () => {
  assert.equal(isHealthy(600), false);
});

// ---------------------------------------------------------------------------
// healthCheckUrl
// ---------------------------------------------------------------------------

test("healthCheckUrl returns correct URL for port 8811", () => {
  assert.equal(healthCheckUrl(8811), "http://127.0.0.1:8811/");
});

test("healthCheckUrl returns correct URL for port 8815", () => {
  assert.equal(healthCheckUrl(8815), "http://127.0.0.1:8815/");
});

test("healthCheckUrl includes trailing slash", () => {
  const url = healthCheckUrl(3000);
  assert.ok(url.endsWith("/"), `expected trailing slash, got: ${url}`);
});

// ---------------------------------------------------------------------------
// WORKERS definitions
// ---------------------------------------------------------------------------

test("WORKERS contains exactly 5 entries", () => {
  assert.equal(WORKERS.length, 5);
});

test("WORKERS ports are 8811-8815", () => {
  const ports = WORKERS.map((w) => w.port).sort((a, b) => a - b);
  assert.deepEqual(ports, [8811, 8812, 8813, 8814, 8815]);
});

test("WORKERS ports are unique", () => {
  const ports = WORKERS.map((w) => w.port);
  const unique = new Set(ports);
  assert.equal(unique.size, 5);
});

test("WORKERS names match the 5 expected workers", () => {
  const names = WORKERS.map((w) => w.name).sort();
  assert.deepEqual(names, [
    "ai-cs-worker",
    "ai-sdr-worker",
    "email-renderer",
    "package-registry",
    "python-registry",
  ]);
});

test("each worker packageDir exists on disk", () => {
  for (const worker of WORKERS) {
    assert.ok(
      existsSync(worker.packageDir),
      `packageDir does not exist for ${worker.name}: ${worker.packageDir}`,
    );
  }
});

test("ai-sdr-worker is on port 8811", () => {
  const w = WORKERS.find((x) => x.name === "ai-sdr-worker");
  assert.ok(w !== undefined);
  assert.equal(w.port, 8811);
});

test("ai-cs-worker is on port 8812", () => {
  const w = WORKERS.find((x) => x.name === "ai-cs-worker");
  assert.ok(w !== undefined);
  assert.equal(w.port, 8812);
});

test("email-renderer is on port 8813", () => {
  const w = WORKERS.find((x) => x.name === "email-renderer");
  assert.ok(w !== undefined);
  assert.equal(w.port, 8813);
});

test("package-registry is on port 8814", () => {
  const w = WORKERS.find((x) => x.name === "package-registry");
  assert.ok(w !== undefined);
  assert.equal(w.port, 8814);
});

test("python-registry is on port 8815", () => {
  const w = WORKERS.find((x) => x.name === "python-registry");
  assert.ok(w !== undefined);
  assert.equal(w.port, 8815);
});

// ---------------------------------------------------------------------------
// waitForHealthy
// ---------------------------------------------------------------------------

test("waitForHealthy resolves ok:true when server responds 404", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve(undefined)));
  });

  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  try {
    const result = await waitForHealthy(port, { timeoutMs: 5_000, intervalMs: 100 });
    assert.equal(result.ok, true);
    assert.equal(/** @type {{ok: true, status: number}} */ (result).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("waitForHealthy resolves ok:false when nothing is listening and timeout is short", async () => {
  // Port 19999 — almost certainly nothing there; use a short timeout
  const result = await waitForHealthy(19999, { timeoutMs: 300, intervalMs: 50 });
  assert.equal(result.ok, false);
  assert.ok("error" in result, "expected error field in failed result");
});

// ---------------------------------------------------------------------------
// buildDepsArgs
// ---------------------------------------------------------------------------

test("buildDepsArgs is exported and is a function", () => {
  assert.equal(typeof buildDepsArgs, "function");
});

test("buildDepsArgs returns exactly the expected array", () => {
  assert.deepEqual(buildDepsArgs(), [
    "--filter",
    "@ventora/ai-sdr-worker...",
    "--filter",
    "@ventora/ai-cs-worker...",
    "run",
    "build",
  ]);
});

test("buildDepsArgs includes ai-sdr-worker filter with ... suffix", () => {
  const args = buildDepsArgs();
  const filterIndex = args.indexOf("@ventora/ai-sdr-worker...");
  assert.ok(filterIndex !== -1, "expected @ventora/ai-sdr-worker... in args");
  assert.equal(args[filterIndex - 1], "--filter");
});

test("buildDepsArgs includes ai-cs-worker filter with ... suffix", () => {
  const args = buildDepsArgs();
  const filterIndex = args.indexOf("@ventora/ai-cs-worker...");
  assert.ok(filterIndex !== -1, "expected @ventora/ai-cs-worker... in args");
  assert.equal(args[filterIndex - 1], "--filter");
});

test("buildDepsArgs ends with run build", () => {
  const args = buildDepsArgs();
  assert.deepEqual(args.slice(-2), ["run", "build"]);
});

// ---------------------------------------------------------------------------
// parseProcessRows
// ---------------------------------------------------------------------------

test("parseProcessRows parses pid,ppid CSV lines", () => {
  const text = "100,4\r\n200,100\r\n300,200\r\n";
  assert.deepEqual(parseProcessRows(text), [
    { pid: 100, ppid: 4 },
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
  ]);
});

test("parseProcessRows skips blank lines and a header row", () => {
  const text = "ProcessId,ParentProcessId\n100,4\n\n200,100\n";
  assert.deepEqual(parseProcessRows(text), [
    { pid: 100, ppid: 4 },
    { pid: 200, ppid: 100 },
  ]);
});

test("parseProcessRows ignores rows with non-numeric fields", () => {
  const text = "abc,def\n100,4\n200,\n,50\n";
  assert.deepEqual(parseProcessRows(text), [{ pid: 100, ppid: 4 }]);
});

test("parseProcessRows tolerates surrounding whitespace", () => {
  const text = "  100 , 4 \n 200,100 ";
  assert.deepEqual(parseProcessRows(text), [
    { pid: 100, ppid: 4 },
    { pid: 200, ppid: 100 },
  ]);
});

test("parseProcessRows returns empty array for empty input", () => {
  assert.deepEqual(parseProcessRows(""), []);
});

// ---------------------------------------------------------------------------
// buildChildrenMap
// ---------------------------------------------------------------------------

test("buildChildrenMap groups pids by parent", () => {
  const map = buildChildrenMap([
    { pid: 200, ppid: 100 },
    { pid: 201, ppid: 100 },
    { pid: 300, ppid: 200 },
  ]);
  assert.deepEqual(map.get(100), [200, 201]);
  assert.deepEqual(map.get(200), [300]);
  assert.equal(map.get(999), undefined);
});

test("buildChildrenMap returns empty map for no rows", () => {
  assert.equal(buildChildrenMap([]).size, 0);
});

// ---------------------------------------------------------------------------
// collectDescendants
// ---------------------------------------------------------------------------

test("collectDescendants walks the full subtree (shell->pnpm->wrangler->workerd)", () => {
  // 100 = shell, 200 = pnpm, 300 = wrangler(node), 400 = workerd
  const map = buildChildrenMap([
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 400, ppid: 300 },
  ]);
  assert.deepEqual(
    collectDescendants([100], map).sort((a, b) => a - b),
    [200, 300, 400],
  );
});

test("collectDescendants collects descendants of multiple roots without duplicates", () => {
  const map = buildChildrenMap([
    { pid: 2, ppid: 1 },
    { pid: 3, ppid: 1 },
    { pid: 4, ppid: 2 },
    { pid: 20, ppid: 10 },
  ]);
  assert.deepEqual(
    collectDescendants([1, 10], map).sort((a, b) => a - b),
    [2, 3, 4, 20],
  );
});

test("collectDescendants excludes the root pids themselves", () => {
  const map = buildChildrenMap([{ pid: 2, ppid: 1 }]);
  const result = collectDescendants([1], map);
  assert.ok(!result.includes(1));
  assert.deepEqual(result, [2]);
});

test("collectDescendants returns empty array for a leaf root", () => {
  const map = buildChildrenMap([{ pid: 2, ppid: 1 }]);
  assert.deepEqual(collectDescendants([999], map), []);
});

test("collectDescendants does not infinite-loop on a parent/child cycle", () => {
  // pathological: 1->2->1 (shouldn't happen, but must terminate)
  const map = buildChildrenMap([
    { pid: 2, ppid: 1 },
    { pid: 1, ppid: 2 },
  ]);
  const result = collectDescendants([1], map).sort((a, b) => a - b);
  assert.deepEqual(result, [2]);
});

test("collectDescendants ignores undefined/null root pids", () => {
  const map = buildChildrenMap([{ pid: 2, ppid: 1 }]);
  assert.deepEqual(collectDescendants([undefined, 1, null], map), [2]);
});

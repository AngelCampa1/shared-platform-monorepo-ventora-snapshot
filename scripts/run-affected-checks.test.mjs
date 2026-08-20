import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("affected-check package list includes backend workers and registries", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-affected-checks.mjs", "--list-packages", "--json"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);

  assert.deepEqual(
    parsed.tsPackages.filter((pkg) =>
      [
        "ai-cs-worker",
        "ai-sdr-worker",
        "package-registry",
        "python-registry",
        "ai-cs",
        "ai-sdr",
      ].includes(pkg.name),
    ),
    [
      { name: "ai-cs", filter: "@ventora/ai-cs" },
      { name: "ai-cs-worker", filter: "@ventora/ai-cs-worker" },
      { name: "ai-sdr", filter: "@ventora/ai-sdr" },
      { name: "ai-sdr-worker", filter: "@ventora/ai-sdr-worker" },
      { name: "package-registry", filter: "@ventora/package-registry" },
      { name: "python-registry", filter: "@ventora/python-registry" },
    ],
  );
  assert.equal(typeof parsed.pythonRunner.command, "string");
  assert.ok(Array.isArray(parsed.pythonRunner.args));
});

test("affected-check plans script tests when repository scripts change", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-affected-checks.mjs", "--list-checks", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        VENTORA_AFFECTED_FILES: "scripts/run-affected-checks.mjs",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);

  assert.deepEqual(parsed.rootChecks, ["test:scripts"]);
});

test("python release and smoke exercise Python gates and non-editable installs", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(packageJson.scripts["schemas:check"], /check-redaction-rules\.mjs/);
  assert.match(packageJson.scripts["release:python"], /pnpm run check-affected:all/);
  assert.match(packageJson.scripts["release:cloudflare"], /pnpm run build/);

  const smokeScript = readFileSync("scripts/run-python-smoke.mjs", "utf8");
  assert.match(smokeScript, /--no-editable/);
  assert.match(smokeScript, /--reinstall/);
});

test("changed Python package source includes version and release metadata", () => {
  const result = spawnSync("git", ["diff", "--name-only", "--", "py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const changedFiles = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const changedSourcePackages = new Set();
  for (const file of changedFiles) {
    const match = /^py\/([^/]+)\/src\//.exec(file);
    if (match !== null) {
      changedSourcePackages.add(match[1]);
    }
  }

  const missingVersionBumps = [...changedSourcePackages].filter(
    (pkg) => !changedFiles.includes(`py/${pkg}/pyproject.toml`),
  );
  assert.deepEqual(missingVersionBumps, []);
  if (changedSourcePackages.size > 0) {
    assert.ok(changedFiles.includes("py/RELEASE_NOTES.md"));
  }
});

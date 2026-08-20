#!/usr/bin/env node
/**
 * Detects which packages (TS + Python) have staged changes and runs their
 * full quality gates: build, typecheck, test:coverage for TS; ruff, mypy,
 * pytest for Python. Also checks schema drift when schemas/ is touched.
 *
 * Usage:
 *   node scripts/run-affected-checks.mjs          # staged changes (pre-commit)
 *   node scripts/run-affected-checks.mjs --all    # every package
 *   node scripts/run-affected-checks.mjs --head   # HEAD vs origin/master
 *   node scripts/run-affected-checks.mjs --list-packages --json
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const args = process.argv.slice(2);
const ALL = args.includes("--all");
const HEAD = args.includes("--head");
const LIST_PACKAGES = args.includes("--list-packages");
const LIST_CHECKS = args.includes("--list-checks");
const JSON_OUTPUT = args.includes("--json");
const PACKAGE_NAME_PATTERN = /^@ventora\/[a-z0-9-]+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hasScripts(pkgJson, scripts) {
  return scripts.every((script) => typeof pkgJson.scripts?.[script] === "string");
}

function discoverTsPackages() {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageJsonPath = join(packagesDir, entry.name, "package.json");
      if (!existsSync(packageJsonPath)) return null;
      const pkgJson = readJson(packageJsonPath);
      if (typeof pkgJson.name !== "string") return null;
      if (!PACKAGE_NAME_PATTERN.test(pkgJson.name)) {
        throw new Error(`Unsafe package name in ${packageJsonPath}: ${pkgJson.name}`);
      }
      if (!hasScripts(pkgJson, ["build", "typecheck", "test:coverage"])) return null;
      return { name: entry.name, filter: pkgJson.name };
    })
    .filter((pkg) => pkg !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function discoverPyPackages() {
  const pyDir = join(ROOT, "py");
  return readdirSync(pyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(pyDir, entry.name, "pyproject.toml")))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const TS_PACKAGES = discoverTsPackages();
const PY_PACKAGES = discoverPyPackages();
const PYTHON_RUNNER = discoverPythonRunner();

function discoverPythonRunner() {
  const candidates = [
    { command: "uv", args: [] },
    { command: "python", args: ["-m", "uv"] },
    { command: "py", args: ["-m", "uv"] },
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      stdio: "ignore",
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function runnerCommand(runner, args) {
  return [runner.command, ...runner.args, ...args].join(" ");
}

function displayCommand(command, args) {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

if (LIST_PACKAGES) {
  if (JSON_OUTPUT) {
    process.stdout.write(
      `${JSON.stringify({
        tsPackages: TS_PACKAGES,
        pyPackages: PY_PACKAGES,
        pythonRunner: PYTHON_RUNNER,
      })}\n`,
    );
  } else {
    process.stdout.write("TypeScript packages:\n");
    for (const pkg of TS_PACKAGES) process.stdout.write(`- ${pkg.name} (${pkg.filter})\n`);
    process.stdout.write("Python packages:\n");
    for (const pkg of PY_PACKAGES) process.stdout.write(`- ${pkg.name}\n`);
    process.stdout.write(
      `Python runner: ${PYTHON_RUNNER ? runnerCommand(PYTHON_RUNNER, []) : "not found"}\n`,
    );
  }
  process.exit(0);
}

function changedFiles() {
  if (ALL) return null;
  if (process.env.VENTORA_AFFECTED_FILES) {
    return process.env.VENTORA_AFFECTED_FILES.split(/[\r\n,]+/)
      .map((f) => f.trim())
      .filter(Boolean);
  }
  try {
    const ref = HEAD ? "origin/master...HEAD" : "--cached";
    const cmd = HEAD ? `git diff --name-only ${ref}` : "git diff --name-only --cached";
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function isAffected(files, prefix) {
  if (files === null) return true;
  return files.some((f) => f.startsWith(prefix));
}

let failed = false;

function run(label, cmd, cwd, env = {}) {
  process.stdout.write(`\n> ${label}\n  ${cmd}\n`);
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.stderr.write(`x ${label} FAILED (exit ${result.status})\n`);
    failed = true;
  } else {
    process.stdout.write(`ok ${label}\n`);
  }
}

function runCommand(label, command, commandArgs, cwd, env = {}) {
  process.stdout.write(`\n> ${label}\n  ${displayCommand(command, commandArgs)}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    process.stderr.write(`x ${label} FAILED (${result.error.message})\n`);
    failed = true;
  } else if (result.status !== 0) {
    process.stderr.write(`x ${label} FAILED (exit ${result.status})\n`);
    failed = true;
  } else {
    process.stdout.write(`ok ${label}\n`);
  }
}

function runPnpm(label, filter, script) {
  if (!PACKAGE_NAME_PATTERN.test(filter) || !/^[a-z:]+$/.test(script)) {
    throw new Error(`Unsafe pnpm invocation: ${filter} ${script}`);
  }
  run(label, `pnpm --filter ${filter} run ${script}`, ROOT);
}

const files = changedFiles();

if (files !== null && files.length === 0) {
  process.stdout.write("No staged changes - nothing to check.\n");
  process.exit(0);
}

const schemaTouched = isAffected(files, "schemas/");
const rootChecks =
  isAffected(files, "scripts/") || isAffected(files, "package.json") ? ["test:scripts"] : [];

if (LIST_CHECKS) {
  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify({ rootChecks })}\n`);
  } else {
    process.stdout.write("Root checks:\n");
    for (const check of rootChecks) process.stdout.write(`- ${check}\n`);
  }
  process.exit(0);
}

if (schemaTouched) {
  run("schemas:check", "node scripts/codegen-schemas.mjs --check", ROOT);
}

if (rootChecks.includes("test:scripts")) {
  run("test:scripts", "pnpm run test:scripts", ROOT);
}

for (const pkg of TS_PACKAGES) {
  const prefix = `packages/${pkg.name}/`;
  const schemaAffectsAnalytics = schemaTouched && pkg.name === "analytics";
  if (!isAffected(files, prefix) && !schemaAffectsAnalytics) continue;

  const pkgDir = join(ROOT, "packages", pkg.name);
  if (!existsSync(pkgDir)) continue;

  runPnpm(`${pkg.filter} - build`, pkg.filter, "build");
  runPnpm(`${pkg.filter} - typecheck`, pkg.filter, "typecheck");
  runPnpm(`${pkg.filter} - test:coverage`, pkg.filter, "test:coverage");
}

for (const pkg of PY_PACKAGES) {
  const prefix = `py/${pkg.name}/`;
  const schemaAffectsAnalytics = schemaTouched && pkg.name === "ventora_analytics";
  if (!isAffected(files, prefix) && !schemaAffectsAnalytics) continue;

  const pkgDir = join(ROOT, "py", pkg.name);
  if (!existsSync(pkgDir)) continue;
  if (PYTHON_RUNNER === null) {
    process.stderr.write("Could not find uv. Install uv or make `python -m uv` available.\n");
    failed = true;
    continue;
  }

  const pythonEnv = { PYTHONPATH: join(pkgDir, "src") };
  runCommand(
    `${pkg.name} - ruff`,
    PYTHON_RUNNER.command,
    [...PYTHON_RUNNER.args, "run", "ruff", "check", "src/"],
    pkgDir,
    pythonEnv,
  );
  runCommand(
    `${pkg.name} - mypy`,
    PYTHON_RUNNER.command,
    [...PYTHON_RUNNER.args, "run", "mypy", "src/", "--ignore-missing-imports"],
    pkgDir,
    pythonEnv,
  );
  runCommand(
    `${pkg.name} - pytest`,
    PYTHON_RUNNER.command,
    [
      ...PYTHON_RUNNER.args,
      "run",
      "pytest",
      "--cov=src",
      "--cov-report=term-missing",
      "--cov-fail-under=95",
      "-q",
    ],
    pkgDir,
    pythonEnv,
  );
}

if (failed) {
  process.stderr.write("\nx One or more checks failed.\n");
  process.exit(1);
} else {
  process.stdout.write("\nok All affected checks passed.\n");
}

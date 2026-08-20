#!/usr/bin/env node
/**
 * Captures real terminal output from the repository's quality gates and renders
 * it to SVG for the documentation.
 *
 * Two of the five captures deliberately BREAK something first, run the gate,
 * record the failure, and then restore the file. A screenshot of a gate
 * rejecting bad input is worth more than a screenshot of green checkmarks: it
 * shows the gate actually does something. Every mutation is restored from an
 * in-memory copy of the original bytes: normally via a `finally` block, but a
 * `finally` block does not run on SIGINT/SIGTERM, and one of these mutations
 * plants a fake API key in a tracked file while a long `spawnSync` blocks. So
 * every pending mutation is also tracked in a module-level registry, and
 * SIGINT/SIGTERM/uncaughtException handlers flush that registry before the
 * process exits, restoring the original bytes even on an interrupted run.
 *
 *   node scripts/docs/capture-terminal-svgs.mjs            all captures
 *   node scripts/docs/capture-terminal-svgs.mjs drift      one capture by id
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTerminalSvg } from "./term-svg.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..", "..");
const outDir = join(root, "portfolio", "screenshots");

/**
 * Runs a command and returns its combined output. Failures are expected for the
 * deliberate-breakage captures, so a non-zero exit is data, not an error.
 *
 * @param {string} command @param {string[]} args
 * @returns {{output: string, status: number}}
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status ?? 1,
  };
}

/**
 * Keeps only the last `count` non-empty-tail lines. Gate output is long and the
 * verdict lives at the end.
 *
 * @param {string} output @param {number} count @returns {string}
 */
function tail(output, count) {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

/**
 * Registry of files currently mutated by `withMutatedFile`, keyed by absolute
 * path, mapped to their original bytes. Consulted by the fatal-signal
 * handlers below so an interrupted run (Ctrl+C, SIGTERM, or an uncaught
 * exception) still restores every pending mutation — including the planted
 * fake API key in `secretScan()` — before the process exits. A `finally`
 * block alone does not run on SIGINT/SIGTERM, which is what this guards
 * against.
 *
 * @type {Map<string, string>}
 */
const pendingRestores = new Map();

/** Writes back every pending restore, reporting (not throwing on) failures. */
function flushPendingRestores() {
  for (const [absolute, original] of pendingRestores) {
    try {
      writeFileSync(absolute, original);
      process.stderr.write(`restored ${absolute}\n`);
    } catch (err) {
      process.stderr.write(
        `failed to restore ${absolute}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  pendingRestores.clear();
}

/** @param {string} signal */
function handleFatalSignal(signal) {
  process.stderr.write(
    `\n${signal} received; restoring ${pendingRestores.size} mutated file(s) before exiting...\n`,
  );
  flushPendingRestores();
  process.exit(1);
}

process.on("SIGINT", () => handleFatalSignal("SIGINT"));
process.on("SIGTERM", () => handleFatalSignal("SIGTERM"));
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `\nuncaught exception; restoring ${pendingRestores.size} mutated file(s) before exiting...\n`,
  );
  flushPendingRestores();
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

/**
 * Runs `body` with a file temporarily replaced, restoring the original bytes
 * afterwards no matter what happens: normally via the `finally` block below,
 * and also via the fatal-signal handlers above if the process is interrupted
 * mid-`body`. Registers the pending restore before mutating and deregisters
 * it only once the restore write has been attempted, so the registry always
 * reflects reality.
 *
 * @template T
 * @param {string} relativePath @param {(original: string) => string} mutate
 * @param {() => T} body @returns {T}
 */
function withMutatedFile(relativePath, mutate, body) {
  const absolute = join(root, relativePath);
  const original = readFileSync(absolute, "utf8");
  pendingRestores.set(absolute, original);
  try {
    writeFileSync(absolute, mutate(original));
    return body();
  } finally {
    // A failure restoring the file must not mask an exception thrown by
    // `body()` above, which `finally` would otherwise silently replace.
    try {
      writeFileSync(absolute, original);
    } catch (restoreErr) {
      process.stderr.write(
        `failed to restore ${absolute}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
      );
    }
    pendingRestores.delete(absolute);
  }
}

/** @param {string} name @param {string} command @param {string} output */
function write(name, command, output) {
  const file = join(outDir, `${name}.svg`);
  writeFileSync(file, renderTerminalSvg({ command, output }));
  const bytes = readFileSync(file).length;
  process.stdout.write(`  wrote ${name}.svg (${bytes.toLocaleString("en-US")} bytes)\n`);
}

const captures = {
  /** The whole TypeScript suite under the 95%-per-file gate, via Turborepo. */
  coverageAll() {
    const command = "pnpm run test:coverage";
    const { output } = run("pnpm", ["run", "test:coverage"]);
    write("term-coverage-all", command, tail(output, 16));
  },

  /** One package's coverage table. ai-sdr-worker excludes nothing at all. */
  coverageTable() {
    const command = "pnpm --filter @ventora/ai-sdr-worker test:coverage";
    const { output } = run("pnpm", ["--filter", "@ventora/ai-sdr-worker", "test:coverage"]);
    write("term-coverage-table", command, tail(output, 30));
  },

  /** Cross-language drift detection, shown failing on a one-event edit. */
  drift() {
    const command = "node scripts/codegen-schemas.mjs --check";
    const output = withMutatedFile(
      "schemas/analytics-events.json",
      (original) => {
        const schema = JSON.parse(original);
        schema.events.push({
          name: "drift_demo_event",
          category: schema.events[0]?.category ?? "product",
          description: "Deliberate drift introduced to demonstrate the gate.",
        });
        return `${JSON.stringify(schema, null, 2)}\n`;
      },
      () => {
        const result = run("node", ["scripts/codegen-schemas.mjs", "--check"]);
        if (result.status === 0) {
          throw new Error("expected codegen --check to fail on injected drift");
        }
        return result.output;
      },
    );
    write("term-schema-drift", command, tail(output, 20));
  },

  /** The tracked-secret scanner, shown rejecting a planted credential. */
  secretScan() {
    const command = "node scripts/check-tracked-secrets.mjs";
    const planted = "docs/integrations/bff-templates/nextjs-app-router.ts";
    const output = withMutatedFile(
      planted,
      (original) =>
        // Assembled at runtime rather than written as a literal: this file is
        // itself scanned by the gate it is demonstrating, and a real-looking
        // key in source would (correctly) fail `pnpm run secrets:check`.
        `${original}\n// Planted for the documentation capture; removed immediately after.\nconst leaked = "${["sk", "or", "v1"].join("-")}-0123456789abcdef0123456789abcdef0123456789abcdef";\n`,
      () => {
        const result = run("node", ["scripts/check-tracked-secrets.mjs"]);
        if (result.status === 0) {
          throw new Error("expected the secret scanner to reject the planted credential");
        }
        return result.output;
      },
    );
    write("term-secret-scan", command, tail(output, 20));
  },
};

mkdirSync(outDir, { recursive: true });

const captureIds = Object.keys(captures);
const requested = process.argv.slice(2);
const requestedLower = requested.map((id) => id.toLowerCase());

if (requested.length > 0) {
  const unknown = requested.filter(
    (id) => !captureIds.some((key) => key.toLowerCase() === id.toLowerCase()),
  );
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown capture id(s): ${unknown.join(", ")}\nvalid ids: ${captureIds.join(", ")}\n`,
    );
    process.exit(1);
  }
}

const selected =
  requested.length === 0
    ? captureIds
    : captureIds.filter((key) => requestedLower.includes(key.toLowerCase()));

for (const key of selected) {
  process.stdout.write(`--- ${key} ---\n`);
  captures[key]();
}

// The Python gate is captured separately: it needs the Python toolchain, which
// is not part of the Node workspace. See portfolio/ENGINEERING.md.
rmSync(join(outDir, ".tmp"), { recursive: true, force: true });
process.stdout.write(`\nWrote ${selected.length} terminal SVGs to portfolio/screenshots/\n`);

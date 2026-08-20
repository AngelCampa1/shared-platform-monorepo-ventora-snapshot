#!/usr/bin/env node
/**
 * Codegens TS union type and Python Literal from schemas/analytics-events.json.
 * Run: node scripts/codegen-schemas.mjs
 * Check (drift detection): node scripts/codegen-schemas.mjs --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const schemaPath = join(root, "schemas", "analytics-events.json");
const tsOutPath = join(root, "packages", "analytics", "src", "_generated-events.ts");
const pyOutPath = join(
  root,
  "py",
  "ventora_analytics",
  "src",
  "ventora_analytics",
  "_generated_events.py",
);

const isCheck = process.argv.includes("--check");

const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
const events = schema.events ?? [];
const names = events.map((e) => e.name);

const products = ["camaudit", "camaudit-v2", "grantpipe", "lextract", "floriva", "streamvpn"];

function tsObjectKey(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : JSON.stringify(value);
}

// TypeScript output
const tsLines = [
  "// AUTO-GENERATED — do not edit. Run `node scripts/codegen-schemas.mjs` to regenerate.",
  `// Source: schemas/analytics-events.json (${names.length} events)`,
  "",
  "export type ApprovedEvent =",
  ...names.map((n, i) => `  | ${JSON.stringify(n)}${i === names.length - 1 ? ";" : ""}`),
  "",
  "export const APPROVED_EVENTS = {",
  ...names.map((n) => `  ${tsObjectKey(n)}: ${JSON.stringify(n)} as const,`),
  "} satisfies Record<ApprovedEvent, ApprovedEvent>;",
  "",
  "export type VentoraProduct =",
  ...products.map((p, i) => `  | ${JSON.stringify(p)}${i === products.length - 1 ? ";" : ""}`),
  "",
];
const tsContent = tsLines.join("\n");

// Python output
const pyLiteralValues = names.map((n) => `    ${JSON.stringify(n)}`).join(",\n");
const pyLines = [
  "# AUTO-GENERATED — do not edit. Run `node scripts/codegen-schemas.mjs` to regenerate.",
  `# Source: schemas/analytics-events.json (${names.length} events)`,
  "from __future__ import annotations",
  "from typing import Literal",
  "",
  "ApprovedEvent = Literal[",
  `${pyLiteralValues},`,
  "]",
  "",
  "APPROVED_EVENTS: tuple[ApprovedEvent, ...] = (",
  names.map((n) => `    ${JSON.stringify(n)},`).join("\n"),
  ")",
  "",
  `VentoraProduct = Literal[${products.map((p) => JSON.stringify(p)).join(", ")}]`,
  "",
];
const pyContent = pyLines.join("\n");

if (isCheck) {
  let drifted = false;
  if (!existsSync(tsOutPath)) {
    console.error("MISSING: packages/analytics/src/_generated-events.ts does not exist");
    drifted = true;
  }
  if (!existsSync(pyOutPath)) {
    console.error(
      "MISSING: py/ventora_analytics/src/ventora_analytics/_generated_events.py does not exist",
    );
    drifted = true;
  }
  if (existsSync(tsOutPath) && readFileSync(tsOutPath, "utf-8") !== tsContent) {
    console.error("DRIFT: packages/analytics/src/_generated-events.ts is out of date");
    drifted = true;
  }
  if (existsSync(pyOutPath) && readFileSync(pyOutPath, "utf-8") !== pyContent) {
    console.error(
      "DRIFT: py/ventora_analytics/src/ventora_analytics/_generated_events.py is out of date",
    );
    drifted = true;
  }
  if (drifted) {
    console.error("Run `node scripts/codegen-schemas.mjs` to fix.");
    process.exit(1);
  }
} else {
  writeFileSync(tsOutPath, tsContent);
  writeFileSync(pyOutPath, pyContent);
}

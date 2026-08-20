/**
 * Secret-scan guard for the AI-SDR CRM pipeline.
 *
 * Exports:
 *   findSecretsInText(text: string): string[]
 *     Returns an array of human-readable reason strings for every secret
 *     pattern found in `text`. Returns [] when no secrets are detected.
 *
 * CLI (run directly — not on import):
 *   node scripts/check-tracked-secrets.mjs
 *   Scans every file tracked by git, prints "file: <reason>" to stderr for
 *   each hit, and exits non-zero if any hit is found.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Matches the OpenRouter secret-key prefix followed by at least 20 non-space
 * characters (real keys are 64-char hex after the prefix).
 */
const OR_KEY_BARE = /sk-or-v1-[A-Za-z0-9]{20,}/;

/**
 * OPENROUTER_API_KEY= (or OPENROUTER_KEY=) assigned a high-entropy value of
 * 20+ non-space chars that does NOT start with sk-or-v1- and is not a known
 * safe placeholder.  This catches raw keys in non-OpenRouter formats that the
 * bare sk-or-v1- pattern cannot see (e.g. a proxy key, a rotated key in a
 * different format).
 *
 * Capture group 1 is the raw value so we can reject placeholders below.
 */
const OR_KEY_ASSIGNMENT = /(?:OPENROUTER_API_KEY|OPENROUTER_KEY)\s*=\s*"?([A-Za-z0-9\-_.]{20,})"?/;

/**
 * Placeholders that are SAFE for the two context-secret keys.
 * Matches: empty value, "changeme", an angle-bracket template like <...>,
 * or values that themselves look like an env-var name (e.g. from markdown
 * prose like `KEY=`/`OTHER_KEY=`).
 */
const SAFE_SECRET_VALUE = /^(|changeme|<[^>]*>)$/;

/**
 * Values that look like another env-var key reference or markdown punctuation
 * (e.g. `/CRM_INGEST_SECRET=` captured from prose) — safe to skip.
 */
const VALUE_LOOKS_LIKE_KEY_REF = /[A-Z_]{4,}\s*=/;

/**
 * Checks whether a value string for AI_SDR_CONTEXT_SECRET or CRM_INGEST_SECRET
 * looks like a real secret (16+ chars, not a known placeholder).
 */
function isRealSecretValue(rawValue) {
  // Strip surrounding quotes
  const value = rawValue.replace(/^["']|["']$/g, "");
  if (SAFE_SECRET_VALUE.test(value)) {
    return false;
  }
  // Values that contain another KEY= reference are prose/markdown, not secrets
  if (VALUE_LOOKS_LIKE_KEY_REF.test(value)) {
    return false;
  }
  return value.length >= 16;
}

/**
 * Match `KEY=value` or `KEY="value"` for the two context-secret env vars.
 * Capture group 1 is the raw value (possibly quoted).
 */
const CONTEXT_SECRET_RE =
  /(?:AI_SDR_CONTEXT_SECRET|CRM_INGEST_SECRET)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s#]*)/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans `text` for known secret patterns.
 *
 * @param {string} text
 * @returns {string[]} Array of human-readable reason strings; empty means no secrets found.
 */
export function findSecretsInText(text) {
  /** @type {string[]} */
  const hits = [];

  // 1. Bare OpenRouter key (sk-or-v1-...)
  if (OR_KEY_BARE.test(text)) {
    hits.push("OpenRouter API key detected (sk-or-v1- prefix with token)");
  }

  // 2. OPENROUTER_API_KEY / OPENROUTER_KEY assigned a non-openrouter-format
  //    high-entropy value (i.e. NOT sk-or-v1-…).  Values that start with the
  //    sk-or-v1- prefix are already caught by the bare-key check above; we
  //    only add a hit here when the assignment value escapes that pattern.
  const orAssignMatch = OR_KEY_ASSIGNMENT.exec(text);
  if (orAssignMatch) {
    const assignedValue = orAssignMatch[1] ?? "";
    const isSkorV1 = assignedValue.startsWith("sk-or-v1-");
    const isPlaceholder = SAFE_SECRET_VALUE.test(assignedValue);
    if (!isSkorV1 && !isPlaceholder) {
      hits.push(
        "OPENROUTER_API_KEY / OPENROUTER_KEY assignment with non-openrouter-format high-entropy value",
      );
    }
  }

  // 3. AI_SDR_CONTEXT_SECRET= / CRM_INGEST_SECRET= with real 16+ char value
  const contextMatches = [...text.matchAll(CONTEXT_SECRET_RE)];
  for (const contextMatch of contextMatches) {
    const rawValue = contextMatch[1] ?? "";
    if (isRealSecretValue(rawValue)) {
      // Identify which key matched
      const keyName = contextMatch[0].split(/\s*=/)[0].trim();
      hits.push(`${keyName} contains a real-looking secret value (16+ chars)`);
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/**
 * Returns true when this module is being executed directly (not imported).
 */
function isDirectRun() {
  if (process.argv[1] === undefined) return false;
  const runningFile = path.resolve(process.argv[1]);
  const thisFile = fileURLToPath(import.meta.url);
  return runningFile === path.resolve(thisFile);
}

/** Heuristic: skip files that are very likely binary by extension. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".wasm",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".ogg",
  ".dll",
  ".exe",
  ".so",
  ".dylib",
  ".node",
  ".bin",
  ".lock",
]);

export function isBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Skip the test-fixtures directory to avoid the CLI flagging its own fake tokens. */
export function isTestFixturePath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("scripts/__tests__/");
}

if (isDirectRun()) {
  const lsResult = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  if (lsResult.status !== 0) {
    process.stderr.write(`check-tracked-secrets: git ls-files failed:\n${lsResult.stderr}\n`);
    process.exit(1);
  }

  const trackedFiles = lsResult.stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  let anyHit = false;

  for (const filePath of trackedFiles) {
    if (isBinaryPath(filePath) || isTestFixturePath(filePath)) {
      continue;
    }

    let contents;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch {
      // File may not exist locally (deleted but still tracked) or be binary.
      continue;
    }

    const hits = findSecretsInText(contents);
    for (const reason of hits) {
      process.stderr.write(`${filePath}: ${reason}\n`);
      anyHit = true;
    }
  }

  process.exit(anyHit ? 1 : 0);
}

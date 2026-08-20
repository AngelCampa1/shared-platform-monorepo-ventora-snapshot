#!/usr/bin/env node
/**
 * Computes the repository metrics quoted in README.md, portfolio/METRICS.md,
 * portfolio/TESTING.md, and portfolio/ARCHITECTURE-PACKAGES.md, then writes them to
 * docs/metrics.json and injects generated tables into the marker-delimited blocks of those
 * documents.
 *
 * This follows the same contract as scripts/codegen-schemas.mjs: the repository
 * is the source of truth, the documents are generated output, and `--check`
 * fails when the two drift. Numbers in the docs are therefore gated by CI
 * rather than asserted by hand.
 *
 *   node scripts/repo-metrics.mjs            write metrics.json + inject blocks
 *   node scripts/repo-metrics.mjs --check    recompute and fail on drift
 *   node scripts/repo-metrics.mjs --json     print metrics to stdout, write nothing
 *   node scripts/repo-metrics.mjs --charts   additionally emit portfolio/screenshots/chart-*.svg
 *
 * Counting rules are documented in portfolio/TESTING.md and unit-tested in
 * scripts/__tests__/repo-metrics.test.mjs. The file list comes from git, so
 * ignored and untracked-but-ignored paths can never inflate a number.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

const isCheck = process.argv.includes("--check");
const isJson = process.argv.includes("--json");
const wantCharts = process.argv.includes("--charts");

/** Lockfiles are counted, but reported separately and never folded into totals. */
const LOCKFILE_NAMES = new Set(["pnpm-lock.yaml", "uv.lock", "package-lock.json", "yarn.lock"]);

/**
 * Output this script itself produces. Counting them would be self-referential:
 * writing metrics.json changes the line count that produced it, so `--check`
 * could never reach a fixed point.
 */
const GENERATED_PREFIXES = ["docs/metrics.json", "portfolio/screenshots/"];

/** Extension to display language. Anything unlisted is bucketed as "Other". */
const LANGUAGE_BY_EXT = new Map([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".mts", "TypeScript"],
  [".cts", "TypeScript"],
  [".js", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".jsx", "JavaScript"],
  [".py", "Python"],
  [".json", "JSON"],
  [".jsonc", "JSON"],
  [".md", "Markdown"],
  [".toml", "TOML"],
  [".yaml", "YAML"],
  [".yml", "YAML"],
  [".svg", "SVG"],
  [".html", "HTML"],
  [".css", "CSS"],
]);

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx"]);

// ---------------------------------------------------------------------------
// File inventory
// ---------------------------------------------------------------------------

/**
 * Reduces raw `git ls-files` entries to the files that make up the project tree.
 * Kept pure and separate from the git call so the rules are testable directly.
 *
 * Two entries are dropped. Generated output is excluded because it is derived
 * from this very inventory, and counting it would stop `--check` ever reaching a
 * fixed point. Files that no longer exist on disk are excluded because
 * `--cached` still lists a file deleted but not yet staged, which is an ordinary
 * intermediate state; a deleted file is not part of the tree being measured, and
 * counting it would fail the run with an ENOENT out of `countLines`.
 *
 * @param {string[]} entries @param {(file: string) => boolean} exists
 * @returns {string[]} POSIX-style paths relative to the repository root.
 */
export function selectProjectFiles(entries, exists) {
  const seen = new Set(entries.filter((entry) => entry.length > 0));
  return [...seen]
    .filter((file) => !GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => exists(file))
    .sort();
}

/**
 * Lists every file git considers part of the project: tracked files plus
 * untracked files that are not ignored. Using both means the script produces
 * identical numbers before and after the initial commit.
 *
 * @returns {string[]} POSIX-style paths relative to the repository root.
 */
function listProjectFiles() {
  const stdout = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return selectProjectFiles(stdout.split("\0"), (file) => existsSync(join(root, file)));
}

/** @param {string} file @returns {string} lowercase extension including the dot */
function extensionOf(file) {
  const base = posix.basename(file);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** @param {string} file @returns {boolean} */
function isLockfile(file) {
  return LOCKFILE_NAMES.has(posix.basename(file));
}

/**
 * Classifies a file as test code. Documented rules, mirrored by the unit test:
 * anything under a `__tests__/` or `tests/` directory, any `*.test.*`,
 * `*.spec.*` or `*.e2e.*` file, any `test_*.py`, and `conftest.py`.
 *
 * @param {string} file @returns {boolean}
 */
function isTestFile(file) {
  const base = posix.basename(file);
  if (file.includes("/__tests__/") || file.includes("/tests/")) {
    return true;
  }
  if (/\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(base)) {
    return true;
  }
  return base === "conftest.py" || /^test_.*\.py$/.test(base);
}

/** @param {string} file @returns {string} */
function languageOf(file) {
  return LANGUAGE_BY_EXT.get(extensionOf(file)) ?? "Other";
}

/**
 * Counts lines the way `wc -l` does for text files, tolerating a missing
 * trailing newline. Binary files report 0 lines but still count as a file.
 *
 * @param {string} file @returns {number}
 */
function countLines(file) {
  const buffer = readFileSync(join(root, file));
  if (buffer.includes(0)) {
    return 0;
  }
  const text = buffer.toString("utf8");
  if (text.length === 0) {
    return 0;
  }
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

// ---------------------------------------------------------------------------
// Test-case counting
// ---------------------------------------------------------------------------

/**
 * Characters that, when they are the last significant character before a `/`,
 * mean the `/` opens a regular-expression literal rather than a division.
 */
const REGEX_PREFIX_CHARS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);

/** Keywords that may be immediately followed by a regular-expression literal. */
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Finds the index of the `/` that closes a regular-expression literal opened at
 * `start`. Honours backslash escapes and `[...]` character classes, inside
 * which a `/` is an ordinary character. Returns -1 when the literal is not
 * terminated on the same line, which means the `/` was not a regex after all.
 *
 * @param {string} source @param {number} start index of the opening `/`
 * @returns {number} index of the closing `/`, or -1
 */
function findRegexEnd(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      return -1;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Removes block comments, line comments, regular-expression literals, and
 * string/template literal bodies so a test-case matcher cannot be fooled by
 * prose or by fixture data that happens to contain `test(`. Quotes are replaced
 * rather than deleted to keep the surrounding syntax intact.
 *
 * Regex literals must be recognised, not just skipped over: a pattern such as
 * `/^A = "([^"]+)"/m` holds an odd number of quotes, so treating those quotes as
 * string delimiters inverts quote parity for the rest of the file and swallows
 * every later test declaration.
 *
 * @param {string} source @returns {string}
 */
export function stripCommentsAndStrings(source) {
  let out = "";
  let index = 0;
  /** @type {null | "line" | "block" | "'" | "\"" | "`"} */
  let mode = null;
  /** Last significant (non-whitespace) character seen at the top level. */
  let prevChar = "";
  /** Trailing identifier characters, used to spot keywords such as `return`. */
  let prevWord = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === null) {
      if (char === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (char === "/") {
        const startsRegex =
          // `/>` closes a JSX element; test files are frequently .tsx, and a
          // regex whose first character is `>` is not worth the false positive.
          next !== ">" &&
          (prevChar === "" ||
            REGEX_PREFIX_CHARS.has(prevChar) ||
            REGEX_PREFIX_KEYWORDS.has(prevWord));
        const end = startsRegex ? findRegexEnd(source, index) : -1;
        if (end !== -1) {
          // Drop the literal entirely; flags are identifier characters and are
          // consumed with it so they cannot look like a call.
          index = end + 1;
          while (index < source.length && /[a-z]/.test(source[index])) {
            index += 1;
          }
          // A completed regex is a value, so a following `/` is division.
          prevChar = ")";
          prevWord = "";
          continue;
        }
      }
      if (char === "'" || char === '"' || char === "`") {
        mode = char;
        out += char;
        index += 1;
        prevChar = char;
        prevWord = "";
        continue;
      }
      out += char;
      index += 1;
      if (!/\s/.test(char)) {
        prevChar = char;
        prevWord = /[\w$]/.test(char) ? prevWord + char : "";
      } else {
        prevWord = "";
      }
      continue;
    }

    if (mode === "line") {
      if (char === "\n") {
        mode = null;
        out += char;
      }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = null;
        index += 2;
        continue;
      }
      if (char === "\n") {
        out += char;
      }
      index += 1;
      continue;
    }

    // Inside a string or template literal.
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === mode) {
      out += char;
      mode = null;
      index += 1;
      continue;
    }
    if (char === "\n") {
      out += char;
    }
    index += 1;
  }

  return out;
}

/**
 * Counts declared test cases in a JavaScript or TypeScript source file.
 *
 * Matches `it(` and `test(` including modifier chains (`.skip`, `.only`,
 * `.todo`, `.concurrent`, `.sequential`, `.fails`, `.each`, `.for`, `.extend`),
 * and the template form `it.each\`...\``. Deliberately does NOT match
 * `describe(`, property accesses such as `obj.test(`, or occurrences inside
 * comments and string literals.
 *
 * This counts cases DECLARED, which is not the same as cases executed: a
 * parametrized `it.each` block counts once. Documentation must say "declared".
 *
 * @param {string} source @returns {number}
 */
export function countTestCases(source) {
  const cleaned = stripCommentsAndStrings(source);
  const matcher =
    /(?<![\w$.])(?:it|test)(?:\.(?:skip|only|todo|concurrent|sequential|fails|each|for|extend|runIf|skipIf))*\s*[(`]/g;
  const matches = cleaned.match(matcher);
  return matches === null ? 0 : matches.length;
}

/**
 * Counts declared pytest cases: module-level and class-level `def test_*` plus
 * their async variants, ignoring comments.
 *
 * @param {string} source @returns {number}
 */
export function countPytestCases(source) {
  const withoutComments = source
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const matches = withoutComments.match(/^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm);
  return matches === null ? 0 : matches.length;
}

// ---------------------------------------------------------------------------
// Package inventory
// ---------------------------------------------------------------------------

/**
 * Strips the wrappers that carry no value of their own, so `95 as const` and
 * `(95)` read the same as `95`.
 *
 * @param {ts.Node} node @returns {ts.Node}
 */
function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

/**
 * Reads a literal value out of a TypeScript AST node. Mirrors the technique in
 * scripts/check-redaction-rules.mjs so config objects are read structurally
 * rather than by regex.
 *
 * Throws rather than returning a placeholder when a node is not a literal: the
 * values read here are published as facts, and a config this reader cannot
 * model must stop the build instead of quietly printing `null`.
 *
 * @param {ts.Node} input @param {string} fileName @param {string} path
 * @returns {unknown}
 */
function readLiteralNode(input, fileName, path) {
  const node = unwrapExpression(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element, index) =>
      readLiteralNode(element, fileName, `${path}[${index}]`),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    /** @type {Record<string, unknown>} */
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(
          `repo-metrics: ${fileName}: cannot read ${path} — unsupported property \`${property.getText()}\`. Coverage settings must be written as plain literals so the published tables stay factual.`,
        );
      }
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (key === null) {
        throw new Error(
          `repo-metrics: ${fileName}: cannot read ${path} — computed property name \`${property.name.getText()}\`.`,
        );
      }
      value[key] = readLiteralNode(property.initializer, fileName, `${path}.${key}`);
    }
    return value;
  }
  throw new Error(
    `repo-metrics: ${fileName}: cannot read ${path} — \`${node.getText()}\` is not a literal. Coverage settings must be written as plain literals so the published tables stay factual.`,
  );
}

/**
 * Returns the initializer of `name` on an object literal, or null when absent.
 * A spread or shorthand property is a hard error: it could hide the very key
 * being looked for, and a silently missing key becomes a silently wrong table.
 *
 * @param {ts.ObjectLiteralExpression} objectLiteral @param {string} name
 * @param {string} fileName @param {string} path
 * @returns {ts.Node | null}
 */
function propertyInitializer(objectLiteral, name, fileName, path) {
  /** @type {ts.Node | null} */
  let found = null;
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `repo-metrics: ${fileName}: cannot read ${path} — unsupported property \`${property.getText()}\`. Coverage settings must be written as plain literals so the published tables stay factual.`,
      );
    }
    const key =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (key === name) {
      found = unwrapExpression(property.initializer);
    }
  }
  return found;
}

/**
 * Extracts the `test.coverage` object from a vitest config by walking the AST
 * for the object literal passed to `defineConfig`.
 *
 * @param {string} source @param {string} fileName
 * @returns {{thresholds: Record<string, unknown>, exclude: string[]} | null}
 */
export function extractCoverageConfig(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  /** @type {ts.ObjectLiteralExpression | null} */
  let configObject = null;

  const visit = (node) => {
    if (
      configObject === null &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(unwrapExpression(node.arguments[0]))
    ) {
      configObject = unwrapExpression(node.arguments[0]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (configObject === null) {
    throw new Error(
      `repo-metrics: ${fileName}: no \`defineConfig({ ... })\` object literal found. The coverage tables are generated from this file, so it must be readable.`,
    );
  }

  const testNode = propertyInitializer(configObject, "test", fileName, "test");
  if (testNode === null) {
    return null;
  }
  if (!ts.isObjectLiteralExpression(testNode)) {
    throw new Error(
      `repo-metrics: ${fileName}: cannot read test — \`${testNode.getText()}\` is not an object literal.`,
    );
  }
  const coverageNode = propertyInitializer(testNode, "coverage", fileName, "test.coverage");
  if (coverageNode === null) {
    return null;
  }
  if (!ts.isObjectLiteralExpression(coverageNode)) {
    throw new Error(
      `repo-metrics: ${fileName}: cannot read test.coverage — \`${coverageNode.getText()}\` is not an object literal.`,
    );
  }

  const thresholdsNode = propertyInitializer(
    coverageNode,
    "thresholds",
    fileName,
    "test.coverage.thresholds",
  );
  const excludeNode = propertyInitializer(
    coverageNode,
    "exclude",
    fileName,
    "test.coverage.exclude",
  );

  const thresholds =
    thresholdsNode === null
      ? {}
      : readLiteralNode(thresholdsNode, fileName, "test.coverage.thresholds");
  const exclude =
    excludeNode === null ? [] : readLiteralNode(excludeNode, fileName, "test.coverage.exclude");

  if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds)) {
    throw new Error(
      `repo-metrics: ${fileName}: cannot read test.coverage.thresholds — expected an object literal.`,
    );
  }
  if (!Array.isArray(exclude) || exclude.some((pattern) => typeof pattern !== "string")) {
    throw new Error(
      `repo-metrics: ${fileName}: cannot read test.coverage.exclude — expected an array of string literals.`,
    );
  }

  return { thresholds, exclude };
}

/**
 * Reads `fail_under` out of a pyproject's `[tool.coverage.report]` table.
 *
 * @param {string} source @returns {number | null}
 */
function extractFailUnder(source) {
  const match = source.match(/^\s*fail_under\s*=\s*(\d+)\s*$/m);
  return match === null ? null : Number(match[1]);
}

/** @param {string[]} files @returns {{name: string, dir: string}[]} */
function findPackageDirs(files, prefix, manifest) {
  const dirs = new Set();
  for (const file of files) {
    if (!file.startsWith(`${prefix}/`)) {
      continue;
    }
    const parts = file.split("/");
    if (parts.length >= 3 && parts[2] === manifest) {
      dirs.add(`${prefix}/${parts[1]}`);
    }
  }
  return [...dirs].sort().map((dir) => ({ name: dir.split("/")[1], dir }));
}

// ---------------------------------------------------------------------------
// Metric assembly
// ---------------------------------------------------------------------------

function computeMetrics() {
  const files = listProjectFiles();

  /** @type {Map<string, {files: number, lines: number}>} */
  const byLanguage = new Map();
  let sourceFiles = 0;
  let sourceLines = 0;
  let lockfileFiles = 0;
  let lockfileLines = 0;

  /** @type {Record<string, {sourceLines: number, testLines: number, sourceFiles: number, testFiles: number, testCases: number}>} */
  const split = {
    typescript: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 0 },
    javascript: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 0 },
    python: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 0 },
  };

  /** @type {Map<string, {source: number, test: number}>} */
  const perPackage = new Map();

  for (const file of files) {
    const lines = countLines(file);

    if (isLockfile(file)) {
      lockfileFiles += 1;
      lockfileLines += lines;
      continue;
    }

    sourceFiles += 1;
    sourceLines += lines;

    const language = languageOf(file);
    const bucket = byLanguage.get(language) ?? { files: 0, lines: 0 };
    bucket.files += 1;
    bucket.lines += lines;
    byLanguage.set(language, bucket);

    const ext = extensionOf(file);
    const test = isTestFile(file);
    /** @type {keyof typeof split | null} */
    let group = null;
    if (TS_EXTS.has(ext)) {
      group = "typescript";
    } else if (JS_EXTS.has(ext)) {
      group = "javascript";
    } else if (ext === ".py") {
      group = "python";
    }

    if (group !== null) {
      const target = split[group];
      if (test) {
        target.testLines += lines;
        target.testFiles += 1;
      } else {
        target.sourceLines += lines;
        target.sourceFiles += 1;
      }
      if (test) {
        const source = readFileSync(join(root, file), "utf8");
        target.testCases += group === "python" ? countPytestCases(source) : countTestCases(source);
      }
    }

    const packageMatch = file.match(/^(packages|py)\/([^/]+)\//);
    if (packageMatch !== null) {
      const key = `${packageMatch[1]}/${packageMatch[2]}`;
      const entry = perPackage.get(key) ?? { source: 0, test: 0 };
      if (test) {
        entry.test += lines;
      } else {
        entry.source += lines;
      }
      perPackage.set(key, entry);
    }
  }

  // --- packages -----------------------------------------------------------
  const tsPackageDirs = findPackageDirs(files, "packages", "package.json");
  const pyPackageDirs = findPackageDirs(files, "py", "pyproject.toml");

  const tsPackages = tsPackageDirs.map(({ name, dir }) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const runtimeDeps = Object.keys(manifest.dependencies ?? {}).filter(
      (dep) => !dep.startsWith("@ventora/"),
    );
    const internalDeps = Object.keys(manifest.dependencies ?? {})
      .filter((dep) => dep.startsWith("@ventora/"))
      .sort();
    const configPath = join(root, dir, "vitest.config.ts");
    const coverage = existsSync(configPath)
      ? extractCoverageConfig(readFileSync(configPath, "utf8"), `${dir}/vitest.config.ts`)
      : null;
    const lines = perPackage.get(dir) ?? { source: 0, test: 0 };
    return {
      name: manifest.name ?? name,
      dir,
      version: manifest.version ?? null,
      description: manifest.description ?? "",
      private: manifest.private === true,
      deployable: typeof manifest.scripts?.deploy === "string",
      exports: Object.keys(manifest.exports ?? {}).sort(),
      runtimeDependencies: runtimeDeps.sort(),
      internalDependencies: internalDeps,
      sourceLines: lines.source,
      testLines: lines.test,
      coverage,
    };
  });

  const pyPackages = pyPackageDirs.map(({ name, dir }) => {
    const source = readFileSync(join(root, dir, "pyproject.toml"), "utf8");
    const nameMatch = source.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const versionMatch = source.match(/^\s*version\s*=\s*"([^"]+)"/m);
    const descriptionMatch = source.match(/^\s*description\s*=\s*"([^"]+)"/m);
    const lines = perPackage.get(dir) ?? { source: 0, test: 0 };
    return {
      name: nameMatch?.[1] ?? name,
      dir,
      version: versionMatch?.[1] ?? null,
      description: descriptionMatch?.[1] ?? "",
      failUnder: extractFailUnder(source),
      sourceLines: lines.source,
      testLines: lines.test,
    };
  });

  // Each Python package carries its own [tool.coverage.report] fail_under. The
  // aggregate is only meaningful when every package agrees, so report the
  // distinct set rather than a single number that might hide an outlier.
  const pythonFailUnder = [
    ...new Set(pyPackages.map((pkg) => pkg.failUnder).filter((value) => value !== null)),
  ].sort((a, b) => a - b);

  // --- schemas ------------------------------------------------------------
  const analytics = JSON.parse(
    readFileSync(join(root, "schemas", "analytics-events.json"), "utf8"),
  );
  const redaction = JSON.parse(readFileSync(join(root, "schemas", "redaction-rules.json"), "utf8"));

  // --- coverage summary ---------------------------------------------------
  const gated = tsPackages.filter((pkg) => pkg.coverage !== null);
  const thresholdValues = new Set(
    gated.flatMap((pkg) =>
      ["lines", "functions", "branches", "statements"].map(
        (key) => pkg.coverage.thresholds?.[key] ?? null,
      ),
    ),
  );
  const perFileEverywhere = gated.every((pkg) => pkg.coverage.thresholds?.perFile === true);

  /** Excludes that hide real product code, as opposed to build/test scaffolding. */
  const SCAFFOLD_EXCLUDES = new Set([
    "**/node_modules/**",
    "**/.wrangler/**",
    "dist/**",
    "src/__tests__/**",
    "scripts/**",
    "vitest.config.ts",
    "tsup.config.ts",
  ]);
  const sourceExclusions = gated
    .map((pkg) => ({
      name: pkg.name,
      excluded: pkg.coverage.exclude.filter((pattern) => !SCAFFOLD_EXCLUDES.has(pattern)).sort(),
    }))
    .filter((entry) => entry.excluded.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = {
    projectFiles: sourceFiles,
    projectLines: sourceLines,
    lockfileFiles,
    lockfileLines,
  };

  return {
    totals,
    languages: [...byLanguage.entries()]
      .map(([language, value]) => ({ language, ...value }))
      .sort((a, b) => b.lines - a.lines || a.language.localeCompare(b.language)),
    code: {
      typescript: split.typescript,
      javascript: split.javascript,
      python: split.python,
    },
    packages: {
      typescript: tsPackages,
      python: pyPackages,
      counts: {
        typescript: tsPackages.length,
        typescriptPublishable: tsPackages.filter((pkg) => !pkg.private).length,
        typescriptDeployable: tsPackages.filter((pkg) => pkg.deployable).length,
        python: pyPackages.length,
        zeroRuntimeDependency: tsPackages.filter((pkg) => pkg.runtimeDependencies.length === 0)
          .length,
      },
    },
    coverage: {
      typescriptConfigs: gated.length,
      perFileEverywhere,
      thresholds: [...thresholdValues].filter((value) => typeof value === "number").sort(),
      pythonPackages: pyPackages.length,
      pythonFailUnder,
      pythonGatedPackages: pyPackages.filter((pkg) => pkg.failUnder !== null).length,
      sourceExclusions,
      noExclusions: gated
        .filter((pkg) => pkg.coverage.exclude.every((pattern) => SCAFFOLD_EXCLUDES.has(pattern)))
        .map((pkg) => pkg.name)
        .sort(),
    },
    schemas: {
      analyticsEvents: (analytics.events ?? []).length,
      analyticsCategories: [...new Set((analytics.events ?? []).map((e) => e.category))].filter(
        (value) => value !== undefined,
      ).length,
      redactionFieldKeys: (redaction.fieldKeys ?? []).length,
      redactionPatterns: (redaction.patterns ?? []).length,
      redactionHipaa18: (redaction.hipaa18Extensions ?? []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** @param {number} value @returns {string} */
const n = (value) => value.toLocaleString("en-US");

/**
 * Renders a sorted list of percentages as a single value or as a range, so a
 * package that disagrees with the rest can never hide behind an average.
 *
 * @param {number[]} values ascending, already de-duplicated
 * @returns {string | null} null when there is nothing to claim
 */
function formatPercentRange(values) {
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    return `${values[0]}%`;
  }
  return `${values[0]}–${values[values.length - 1]}%`;
}

/**
 * Builds the headline coverage-floor claim strictly from measured values.
 *
 * Every qualifier is earned: "per file" appears only when every vitest config
 * sets `perFile`, the Python floor is stated separately whenever it differs
 * from the TypeScript floor, and a language with no gate is not mentioned at
 * all. The row is the single most quotable sentence in the README, so it must
 * not outrun what the configs actually say.
 *
 * @param {{thresholds: number[], perFileEverywhere: boolean, typescriptConfigs: number,
 *   pythonFailUnder: number[], pythonGatedPackages: number}} coverage
 * @returns {string}
 */
export function formatCoverageFloor(coverage) {
  const tsFloor = formatPercentRange(coverage.thresholds);
  const pyFloor = formatPercentRange(coverage.pythonFailUnder);
  const perFile = coverage.perFileEverywhere ? ", enforced **per file**" : "";
  const tsScope = `${coverage.typescriptConfigs} vitest ${coverage.typescriptConfigs === 1 ? "config" : "configs"}`;
  const pyScope = `${coverage.pythonGatedPackages} Python ${coverage.pythonGatedPackages === 1 ? "package" : "packages"}`;
  const criteria = "lines, branches, functions, statements";

  if (tsFloor === null && pyFloor === null) {
    return "no coverage floor configured";
  }
  if (tsFloor === null) {
    return `${pyFloor} across ${pyScope}`;
  }
  if (pyFloor === null || coverage.pythonGatedPackages === 0) {
    return `${tsFloor} ${criteria}${perFile} across ${tsScope}`;
  }
  if (pyFloor === tsFloor) {
    return `${tsFloor} ${criteria}${perFile} across ${tsScope} and ${pyScope}`;
  }
  return `${tsFloor} ${criteria}${perFile} across ${tsScope} · ${pyFloor} across ${pyScope}`;
}

function renderAtAGlance(m) {
  const ts = m.code.typescript;
  const py = m.code.python;
  const js = m.code.javascript;
  const tsShare = ((ts.testLines / (ts.testLines + ts.sourceLines)) * 100).toFixed(1);
  const pyShare = ((py.testLines / (py.testLines + py.sourceLines)) * 100).toFixed(1);
  return [
    "| | |",
    "| --- | --- |",
    `| Packages | ${m.packages.counts.typescript} TypeScript · ${m.packages.counts.python} Python |`,
    `| Deployable Workers | ${m.packages.counts.typescriptDeployable} |`,
    `| Project lines | ${n(m.totals.projectLines)} across ${n(m.totals.projectFiles)} files (lockfiles excluded) |`,
    `| Test code | ${n(ts.testLines)} TypeScript lines (${tsShare}%) · ${n(py.testLines)} Python lines (${pyShare}%) |`,
    `| Test cases declared | ${n(ts.testCases)} vitest · ${n(py.testCases)} pytest · ${n(js.testCases)} node:test |`,
    `| Coverage floor | ${formatCoverageFloor(m.coverage)} |`,
    `| Zero-runtime-dependency packages | ${m.packages.counts.zeroRuntimeDependency} of ${m.packages.counts.typescript} TypeScript packages |`,
    `| Cross-language contract | ${m.schemas.analyticsEvents} analytics events, ${m.schemas.redactionFieldKeys} redaction field keys, ${m.schemas.redactionPatterns} patterns |`,
  ].join("\n");
}

function renderPackageTable(m) {
  const rows = [];
  const group = (title, packages) => {
    if (packages.length === 0) {
      return;
    }
    rows.push(`| **${title}** | | | |`);
    for (const pkg of packages) {
      rows.push(
        `| \`${pkg.name}\` | ${n(pkg.sourceLines)} | ${n(pkg.testLines)} | ${pkg.description} |`,
      );
    }
  };

  const tsPackages = m.packages.typescript;
  const contracts = tsPackages.filter((pkg) => pkg.name.endsWith("-contracts"));
  const workers = tsPackages.filter((pkg) => pkg.deployable && !contracts.includes(pkg));
  const libraries = tsPackages.filter((pkg) => !contracts.includes(pkg) && !workers.includes(pkg));

  rows.push("| Package | Source | Tests | Purpose |");
  rows.push("| --- | ---: | ---: | --- |");
  group("Contracts", contracts);
  group("Workers (deployed)", workers);
  group("Libraries (published)", libraries);
  group("Python", m.packages.python);
  return rows.join("\n");
}

function renderCoverageConfig(m) {
  const rows = [
    "| Package | Coverage exclusions beyond build and test scaffolding |",
    "| --- | --- |",
  ];
  for (const entry of m.coverage.sourceExclusions) {
    rows.push(`| \`${entry.name}\` | ${entry.excluded.map((e) => `\`${e}\``).join(", ")} |`);
  }
  for (const name of m.coverage.noExclusions) {
    rows.push(`| \`${name}\` | none |`);
  }
  return rows.join("\n");
}

/**
 * Renders the "for scale" TypeScript/Python/Node test-count sentence quoted in
 * portfolio/ARCHITECTURE-PACKAGES.md. It used to be hand-typed prose outside any marker
 * block, which meant `--check` could never see it drift. Generating it closes
 * that blind spot the same way the other quoted numbers are closed.
 *
 * @param {{code: {typescript: {sourceLines: number, testLines: number, testCases: number},
 *   python: {testCases: number}, javascript: {testCases: number}}}} m
 * @returns {string}
 */
function renderTestScale(m) {
  const ts = m.code.typescript;
  const py = m.code.python;
  const js = m.code.javascript;
  return `For scale: \`docs/metrics.json\` (regenerated and checked by \`scripts/repo-metrics.mjs\`) reports
${n(ts.sourceLines)} lines of TypeScript source against ${n(ts.testLines)} lines of TypeScript test across ${n(ts.testCases)} test
cases, plus ${n(py.testCases)} Python test cases and ${n(js.testCases)} in Node's own test runner for the \`scripts/\` tooling.`;
}

const BLOCKS = {
  "at-a-glance": renderAtAGlance,
  "package-table": renderPackageTable,
  "coverage-config": renderCoverageConfig,
  "test-scale": renderTestScale,
};

/** Which generated blocks each document is required to carry. */
const TARGET_BLOCKS = {
  "README.md": ["at-a-glance", "package-table"],
  "portfolio/METRICS.md": ["at-a-glance"],
  "portfolio/TESTING.md": ["coverage-config"],
  "portfolio/ARCHITECTURE-PACKAGES.md": ["test-scale"],
};

/**
 * Counts non-overlapping occurrences of `needle` in `haystack`.
 *
 * @param {string} haystack @param {string} needle @returns {number}
 */
function countOccurrences(haystack, needle) {
  let total = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return total;
    }
    total += 1;
    from = at + needle.length;
  }
}

/**
 * Locates the span a generated block owns.
 *
 * Every requested block must appear exactly once. A missing marker means the
 * gate has stopped gating that block, and a repeated marker means the
 * replacement span is ambiguous — rewriting from the first start marker to the
 * first end marker would delete whatever sits between them, including prose and
 * fenced examples that merely quote the marker syntax. Both are reported rather
 * than papered over.
 *
 * @param {string} content @param {string} name @param {string} file
 * @returns {{startIndex: number, endIndex: number, startLength: number}}
 */
function locateBlock(content, name, file) {
  if (BLOCKS[name] === undefined) {
    throw new Error(`repo-metrics: unknown generated block \`${name}\``);
  }
  const start = `<!-- metrics:${name}:start -->`;
  const end = `<!-- metrics:${name}:end -->`;
  const starts = countOccurrences(content, start);
  const ends = countOccurrences(content, end);

  if (starts === 0 || ends === 0) {
    throw new Error(
      `repo-metrics: ${file} is missing the marker \`${starts === 0 ? start : end}\`. Restore it, otherwise the generated block is no longer checked for drift.`,
    );
  }
  if (starts > 1 || ends > 1) {
    const marker = starts > 1 ? start : end;
    throw new Error(
      `repo-metrics: ${file} contains ${starts > 1 ? starts : ends} copies of the marker \`${marker}\`. Exactly one is required, because the span to replace is otherwise ambiguous.`,
    );
  }

  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (endIndex < startIndex) {
    throw new Error(
      `repo-metrics: ${file} has \`${end}\` before \`${start}\`. The markers must be in order.`,
    );
  }
  return { startIndex, endIndex, startLength: start.length };
}

/**
 * Verifies that a document still carries exactly one well-formed copy of each
 * block it owns. Run before anything is written, so a document that has lost
 * its markers stops the run instead of being half-updated.
 *
 * @param {string} content @param {string[]} blocks @param {string} file
 * @returns {void}
 */
export function assertBlockMarkers(content, blocks, file) {
  for (const name of blocks) {
    locateBlock(content, name, file);
  }
}

/**
 * Replaces the contents of the named `<!-- metrics:<name>:start -->` blocks.
 *
 * @param {string} content
 * @param {object} metrics
 * @param {{blocks?: string[], file?: string}} [options]
 * @returns {string}
 */
export function injectBlocks(content, metrics, options = {}) {
  const names = options.blocks ?? Object.keys(BLOCKS);
  const file = options.file ?? "document";
  let output = content;

  for (const name of names) {
    const { startIndex, endIndex, startLength } = locateBlock(output, name, file);
    const before = output.slice(0, startIndex + startLength);
    const after = output.slice(endIndex);
    output = `${before}\n${BLOCKS[name](metrics)}\n${after}`;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const CHART_STYLE = [
  "<style>",
  "  .bg{fill:#ffffff}",
  "  .label,.value,.title,.caption{font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}",
  "  .title{font-size:15px;font-weight:600;fill:#0f172a}",
  "  .caption{font-size:11px;fill:#64748b}",
  "  .label{font-size:11px;fill:#334155}",
  "  .value{font-size:10px;fill:#64748b}",
  "  .src{fill:#1e3a8a}",
  "  .tst{fill:#60a5fa}",
  "  .bar{fill:#1e3a8a}",
  "  @media (prefers-color-scheme: dark){",
  "    .bg{fill:#0b1220}.title{fill:#e2e8f0}.label{fill:#cbd5e1}",
  "    .caption,.value{fill:#94a3b8}.src{fill:#93c5fd}.tst{fill:#1d4ed8}.bar{fill:#93c5fd}",
  "  }",
  "</style>",
].join("\n");

function chartTestVsSource(m) {
  const rows = m.packages.typescript
    .concat(m.packages.python)
    .filter((pkg) => pkg.sourceLines + pkg.testLines > 0)
    .sort((a, b) => b.sourceLines + b.testLines - (a.sourceLines + a.testLines));
  const rowHeight = 20;
  const top = 62;
  const left = 190;
  const chartWidth = 470;
  const height = top + rows.length * rowHeight + 34;
  const width = left + chartWidth + 76;
  const max = Math.max(...rows.map((pkg) => pkg.sourceLines + pkg.testLines), 1);

  const bars = rows
    .map((pkg, index) => {
      const y = top + index * rowHeight;
      const srcW = (pkg.sourceLines / max) * chartWidth;
      const tstW = (pkg.testLines / max) * chartWidth;
      const short = pkg.name.replace("@ventora/", "");
      return [
        `<text class="label" x="${left - 8}" y="${y + 11}" text-anchor="end">${short}</text>`,
        `<rect class="src" x="${left}" y="${y + 2}" width="${srcW.toFixed(1)}" height="12" rx="2"/>`,
        `<rect class="tst" x="${(left + srcW).toFixed(1)}" y="${y + 2}" width="${tstW.toFixed(1)}" height="12" rx="2"/>`,
        `<text class="value" x="${(left + srcW + tstW + 6).toFixed(1)}" y="${y + 12}">${n(pkg.sourceLines + pkg.testLines)}</text>`,
      ].join("");
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Source and test lines per package">
<title>Source and test lines per package</title>
${CHART_STYLE}
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="16" y="24">Lines of code per package</text>
  <rect class="src" x="16" y="34" width="10" height="10" rx="2"/><text class="caption" x="31" y="43">source</text>
  <rect class="tst" x="80" y="34" width="10" height="10" rx="2"/><text class="caption" x="95" y="43">tests</text>
  ${bars}
  <text class="caption" x="16" y="${height - 12}">Generated by scripts/repo-metrics.mjs --charts</text>
</svg>
`;
}

function chartLanguageMix(m) {
  const rows = m.languages.filter((entry) => entry.lines > 0).slice(0, 8);
  const rowHeight = 24;
  const top = 52;
  const left = 110;
  const chartWidth = 420;
  const height = top + rows.length * rowHeight + 34;
  const width = left + chartWidth + 90;
  const max = Math.max(...rows.map((entry) => entry.lines), 1);

  const bars = rows
    .map((entry, index) => {
      const y = top + index * rowHeight;
      const barWidth = (entry.lines / max) * chartWidth;
      return [
        `<text class="label" x="${left - 8}" y="${y + 13}" text-anchor="end">${entry.language}</text>`,
        `<rect class="bar" x="${left}" y="${y + 2}" width="${barWidth.toFixed(1)}" height="15" rx="2"/>`,
        `<text class="value" x="${(left + barWidth + 6).toFixed(1)}" y="${y + 14}">${n(entry.lines)}</text>`,
      ].join("");
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Project lines by language">
<title>Project lines by language</title>
${CHART_STYLE}
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="16" y="26">Project lines by language</text>
  ${bars}
  <text class="caption" x="16" y="${height - 12}">Lockfiles excluded (${n(m.totals.lockfileLines)} lines). Generated by scripts/repo-metrics.mjs --charts</text>
</svg>
`;
}

/**
 * The SVG charts, keyed by their path under `portfolio/screenshots/` and paired with the
 * function that renders them from `metrics`.
 *
 * Charts are opt-in output (only written when `--charts` is passed), unlike
 * metrics.json and the marker blocks, which are always written. But once a
 * chart exists in the tree it can drift from the tree silently, the same way
 * a hand-typed number can, so `--check` compares every chart here against
 * what it would render today and fails on a mismatch even though `--check`
 * itself never writes one. See `docs/goal-portfolio-public/LEDGER.md` for the
 * incident this closes.
 *
 * @type {{rel: string, render: (m: object) => string}[]}
 */
const CHART_TARGETS = [
  { rel: "portfolio/screenshots/chart-test-vs-source.svg", render: chartTestVsSource },
  { rel: "portfolio/screenshots/chart-language-mix.svg", render: chartLanguageMix },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** True when this file was run directly rather than imported by a test. */
const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (!isEntrypoint) {
  // Imported for unit testing: expose the pure helpers, run nothing.
} else {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Repeats a write pass until it reports that it changed nothing.
 *
 * README.md and portfolio/TESTING.md are counted by the very inventory they
 * publish, and the generated tables have a variable number of rows, so adding a
 * package changes the README's own line count. One pass is therefore not a
 * fixed point and `--check` would fail straight after a successful write. Two
 * passes converge in practice; the bound exists so a genuine oscillation fails
 * loudly instead of spinning.
 *
 * @template T
 * @param {() => {changed: boolean, value: T}} pass one pass; `changed` is true
 *   when it wrote something, which means the inputs may have moved underneath it
 * @param {number} [maxPasses]
 * @returns {{value: T, passes: number}} the value from the settled pass
 */
export function writeUntilStable(pass, maxPasses = 3) {
  for (let attempt = 1; attempt <= maxPasses; attempt += 1) {
    const result = pass();
    if (!result.changed) {
      return { value: result.value, passes: attempt };
    }
  }
  throw new Error(
    `repo-metrics: generated output did not stabilise after ${maxPasses} passes. The metrics and the documents they are written into are feeding each other.`,
  );
}

function main() {
  const metricsPath = join(root, "docs", "metrics.json");
  /** @type {{path: string, rel: string, blocks: string[]}[]} */
  const targets = Object.entries(TARGET_BLOCKS).map(([rel, blocks]) => ({
    path: join(root, ...rel.split("/")),
    rel,
    blocks,
  }));

  if (isJson) {
    process.stdout.write(`${JSON.stringify(computeMetrics(), null, 2)}\n`);
    process.exit(0);
  }

  for (const target of targets) {
    if (!existsSync(target.path)) {
      throw new Error(
        `repo-metrics: ${target.rel} is missing. It holds the generated blocks ` +
          `${target.blocks.map((name) => `\`${name}\``).join(", ")}, so it cannot be skipped.`,
      );
    }
    assertBlockMarkers(readFileSync(target.path, "utf8"), target.blocks, target.rel);
  }

  if (isCheck) {
    const metrics = computeMetrics();
    const serialized = `${JSON.stringify(metrics, null, 2)}\n`;
    /** @type {string[]} */
    const drifted = [];

    if (!existsSync(metricsPath) || readFileSync(metricsPath, "utf8") !== serialized) {
      drifted.push(relative(root, metricsPath).split(sep).join("/"));
    }
    for (const target of targets) {
      const current = readFileSync(target.path, "utf8");
      if (injectBlocks(current, metrics, { blocks: target.blocks, file: target.rel }) !== current) {
        drifted.push(target.rel);
      }
    }

    /** @type {string[]} */
    const driftedCharts = [];
    for (const chart of CHART_TARGETS) {
      const chartPath = join(root, ...chart.rel.split("/"));
      const expected = chart.render(metrics);
      if (!existsSync(chartPath) || readFileSync(chartPath, "utf8") !== expected) {
        driftedCharts.push(chart.rel);
      }
    }

    if (drifted.length > 0) {
      process.stderr.write(
        `repo-metrics: generated content is stale in:\n${drifted.map((f) => `  ${f}`).join("\n")}\nRun \`pnpm run metrics\` and commit the result.\n`,
      );
      process.exit(1);
    }
    if (driftedCharts.length > 0) {
      process.stderr.write(
        `repo-metrics: generated charts are stale in:\n${driftedCharts.map((f) => `  ${f}`).join("\n")}\nRun \`pnpm run metrics:charts\` and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write("repo-metrics: up to date\n");
    process.exit(0);
  }

  mkdirSync(dirname(metricsPath), { recursive: true });

  const { value: metrics } = writeUntilStable(() => {
    const value = computeMetrics();
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    let changed = false;

    if (!existsSync(metricsPath) || readFileSync(metricsPath, "utf8") !== serialized) {
      writeFileSync(metricsPath, serialized);
      changed = true;
    }
    for (const target of targets) {
      const current = readFileSync(target.path, "utf8");
      const updated = injectBlocks(current, value, { blocks: target.blocks, file: target.rel });
      if (updated !== current) {
        writeFileSync(target.path, updated);
        changed = true;
      }
    }
    return { changed, value };
  });

  if (wantCharts) {
    const assets = join(root, "portfolio", "screenshots");
    mkdirSync(assets, { recursive: true });
    for (const chart of CHART_TARGETS) {
      writeFileSync(join(root, ...chart.rel.split("/")), chart.render(metrics));
    }
  }

  process.stdout.write(
    `repo-metrics: ${n(metrics.totals.projectLines)} lines across ${n(metrics.totals.projectFiles)} files, ` +
      `${metrics.packages.counts.typescript} TS + ${metrics.packages.counts.python} Python packages\n`,
  );
}

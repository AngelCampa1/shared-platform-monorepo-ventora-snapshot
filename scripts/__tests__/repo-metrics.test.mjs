import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBlockMarkers,
  countPytestCases,
  countTestCases,
  extractCoverageConfig,
  formatCoverageFloor,
  injectBlocks,
  selectProjectFiles,
  stripCommentsAndStrings,
  writeUntilStable,
} from "../repo-metrics.mjs";

test("stripCommentsAndStrings removes line comments but keeps newlines", () => {
  const stripped = stripCommentsAndStrings("const a = 1; // it('ghost')\nconst b = 2;");
  assert.match(stripped, /const a = 1;/);
  assert.doesNotMatch(stripped, /ghost/);
  assert.equal(stripped.split("\n").length, 2);
});

test("stripCommentsAndStrings removes block comments including JSDoc", () => {
  const source = "/**\n * it('documented')\n */\nit('real', () => {});";
  const stripped = stripCommentsAndStrings(source);
  assert.doesNotMatch(stripped, /documented/);
  // String bodies are emptied by design, so the call survives as `it('')`.
  assert.match(stripped, /it\(''/);
  assert.equal(countTestCases(source), 1);
});

test("stripCommentsAndStrings empties string bodies but preserves the quotes", () => {
  const stripped = stripCommentsAndStrings('const s = "it(fake)"; const t = `test(also fake)`;');
  assert.doesNotMatch(stripped, /fake/);
  assert.match(stripped, /const s = "";/);
  assert.match(stripped, /const t = ``;/);
});

test("stripCommentsAndStrings handles escaped quotes inside strings", () => {
  const stripped = stripCommentsAndStrings('const s = "a\\"it(x)"; it("real", () => {});');
  assert.doesNotMatch(stripped, /x/);
  assert.equal(countTestCases('const s = "a\\"it(x)"; it("real", () => {});'), 1);
});

test("stripCommentsAndStrings treats a regex holding quotes as a regex, not as strings", () => {
  const source = [
    'const allowed = wrangler.match(/^AI_SDR_ALLOWED_ORIGINS = "([^"]+)"/m)?.[1] ?? "";',
    'it("denies retired sessions from an allowed sibling origin", () => {});',
  ].join("\n");

  const stripped = stripCommentsAndStrings(source);
  assert.doesNotMatch(stripped, /AI_SDR_ALLOWED_ORIGINS/);
  assert.match(stripped, /it\(""/);
  assert.equal(countTestCases(source), 1);
});

test("stripCommentsAndStrings keeps a slash inside a regex character class from ending it", () => {
  const source = ['const path = value.replace(/[a-z/"]+/g, "");', 'it("real", () => {});'].join(
    "\n",
  );

  assert.doesNotMatch(stripCommentsAndStrings(source), /a-z/);
  assert.equal(countTestCases(source), 1);
});

test("stripCommentsAndStrings does not mistake division for a regex literal", () => {
  const source = ['const ratio = a / b; it("x", () => {});', 'it("y", () => {});'].join("\n");

  const stripped = stripCommentsAndStrings(source);
  assert.match(stripped, /const ratio = a \/ b;/);
  assert.equal(countTestCases(source), 2);
});

test("stripCommentsAndStrings handles an escaped slash and flags inside a regex", () => {
  const source = ['const re = /a\\/b"c/gim;', 'it("real", () => {});'].join("\n");

  const stripped = stripCommentsAndStrings(source);
  assert.doesNotMatch(stripped, /gim/);
  assert.equal(countTestCases(source), 1);
});

test("stripCommentsAndStrings leaves JSX self-closing tags alone", () => {
  const source = [
    'render(<Widget a={1} /> , <Other b={2} />); it("mounts", () => {});',
    'it("unmounts", () => {});',
  ].join("\n");

  assert.equal(countTestCases(source), 2);
});

test("countTestCases counts plain it and test declarations", () => {
  const source = ['it("a", () => {});', 'test("b", () => {});', 'it("c", () => {});'].join("\n");
  assert.equal(countTestCases(source), 3);
});

test("countTestCases counts a parametrized it.each block exactly once", () => {
  const source = 'it.each([1, 2, 3])("case %i", (n) => {});';
  assert.equal(countTestCases(source), 1);
});

test("countTestCases counts the tagged-template form of it.each", () => {
  const source = 'it.each`\n  a | b\n  ${1} | ${2}\n`("tagged", () => {});';
  assert.equal(countTestCases(source), 1);
});

test("countTestCases counts modifier chains", () => {
  const source = [
    'it.skip("a", () => {});',
    'test.only("b", () => {});',
    'it.todo("c");',
    'it.concurrent("d", () => {});',
    'test.fails("e", () => {});',
  ].join("\n");
  assert.equal(countTestCases(source), 5);
});

test("countTestCases ignores describe blocks", () => {
  const source = 'describe("suite", () => {\n  it("a", () => {});\n});';
  assert.equal(countTestCases(source), 1);
});

test("countTestCases ignores commented-out tests", () => {
  const source = [
    '// it("disabled", () => {});',
    '/* test("also disabled") */',
    'it("live");',
  ].join("\n");
  assert.equal(countTestCases(source), 1);
});

test("countTestCases ignores strings that merely contain test(", () => {
  const source = 'const label = "test(";\nconst other = "it(";\nit("real", () => {});';
  assert.equal(countTestCases(source), 1);
});

test("countTestCases ignores property access such as obj.test(", () => {
  const source = 'regex.test("value");\nsuite.it("value");\nit("real", () => {});';
  assert.equal(countTestCases(source), 1);
});

test("countTestCases returns zero for a file with no tests", () => {
  assert.equal(countTestCases("export const value = 1;\n"), 0);
});

test("countPytestCases counts sync and async test functions", () => {
  const source = [
    "def test_one():",
    "    pass",
    "",
    "async def test_two():",
    "    pass",
    "",
    "    def test_nested_in_class(self):",
    "        pass",
  ].join("\n");
  assert.equal(countPytestCases(source), 3);
});

test("countPytestCases ignores helpers and commented tests", () => {
  const source = [
    "def helper_test_thing():",
    "    pass",
    "# def test_commented():",
    "def testing_not_a_test():",
    "    pass",
    "def test_real():",
    "    pass",
  ].join("\n");
  assert.equal(countPytestCases(source), 1);
});

/**
 * Minimal metrics object with the shape the renderers read.
 *
 * @param {object} [overrides] merged over the `coverage` sub-object
 * @returns {object}
 */
function sampleMetrics(overrides = {}) {
  return {
    totals: { projectFiles: 1, projectLines: 1, lockfileFiles: 0, lockfileLines: 0 },
    languages: [],
    code: {
      typescript: { sourceLines: 1, testLines: 1, sourceFiles: 1, testFiles: 1, testCases: 1 },
      javascript: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 0 },
      python: { sourceLines: 1, testLines: 1, sourceFiles: 1, testFiles: 1, testCases: 1 },
    },
    packages: {
      typescript: [],
      python: [],
      counts: {
        typescript: 1,
        typescriptPublishable: 1,
        typescriptDeployable: 0,
        python: 1,
        zeroRuntimeDependency: 1,
      },
    },
    coverage: {
      typescriptConfigs: 19,
      perFileEverywhere: true,
      thresholds: [95],
      pythonPackages: 6,
      pythonFailUnder: [95],
      pythonGatedPackages: 6,
      sourceExclusions: [],
      noExclusions: [],
      ...overrides,
    },
    schemas: {
      analyticsEvents: 1,
      analyticsCategories: 1,
      redactionFieldKeys: 1,
      redactionPatterns: 1,
      redactionHipaa18: 1,
    },
  };
}

test("injectBlocks replaces a known block and leaves surrounding prose intact", () => {
  const metrics = {
    totals: { projectFiles: 10, projectLines: 100, lockfileFiles: 1, lockfileLines: 5 },
    languages: [],
    code: {
      typescript: { sourceLines: 60, testLines: 40, sourceFiles: 2, testFiles: 1, testCases: 7 },
      javascript: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 3 },
      python: { sourceLines: 10, testLines: 10, sourceFiles: 1, testFiles: 1, testCases: 5 },
    },
    packages: {
      typescript: [],
      python: [],
      counts: {
        typescript: 2,
        typescriptPublishable: 1,
        typescriptDeployable: 1,
        python: 1,
        zeroRuntimeDependency: 2,
      },
    },
    coverage: {
      typescriptConfigs: 2,
      perFileEverywhere: true,
      thresholds: [95],
      pythonPackages: 1,
      pythonFailUnder: [95],
      pythonGatedPackages: 1,
      sourceExclusions: [],
      noExclusions: [],
    },
    schemas: {
      analyticsEvents: 46,
      analyticsCategories: 7,
      redactionFieldKeys: 35,
      redactionPatterns: 7,
      redactionHipaa18: 4,
    },
  };

  const document = [
    "# Title",
    "",
    "Prose above.",
    "",
    "<!-- metrics:at-a-glance:start -->",
    "stale content",
    "<!-- metrics:at-a-glance:end -->",
    "",
    "Prose below.",
    "",
  ].join("\n");

  const result = injectBlocks(document, metrics, { blocks: ["at-a-glance"], file: "README.md" });
  assert.match(result, /Prose above\./);
  assert.match(result, /Prose below\./);
  assert.doesNotMatch(result, /stale content/);
  assert.match(result, /\| Packages \| 2 TypeScript · 1 Python \|/);
});

test("injectBlocks is idempotent", () => {
  const metrics = {
    totals: { projectFiles: 1, projectLines: 1, lockfileFiles: 0, lockfileLines: 0 },
    languages: [],
    code: {
      typescript: { sourceLines: 1, testLines: 1, sourceFiles: 1, testFiles: 1, testCases: 1 },
      javascript: { sourceLines: 0, testLines: 0, sourceFiles: 0, testFiles: 0, testCases: 0 },
      python: { sourceLines: 1, testLines: 1, sourceFiles: 1, testFiles: 1, testCases: 1 },
    },
    packages: {
      typescript: [],
      python: [],
      counts: {
        typescript: 1,
        typescriptPublishable: 1,
        typescriptDeployable: 0,
        python: 1,
        zeroRuntimeDependency: 1,
      },
    },
    coverage: {
      typescriptConfigs: 1,
      perFileEverywhere: true,
      thresholds: [95],
      pythonPackages: 1,
      pythonFailUnder: [95],
      pythonGatedPackages: 1,
      sourceExclusions: [],
      noExclusions: [],
    },
    schemas: {
      analyticsEvents: 1,
      analyticsCategories: 1,
      redactionFieldKeys: 1,
      redactionPatterns: 1,
      redactionHipaa18: 1,
    },
  };
  const document = "<!-- metrics:at-a-glance:start -->\n\n<!-- metrics:at-a-glance:end -->\n";
  const options = { blocks: ["at-a-glance"], file: "README.md" };
  const once = injectBlocks(document, metrics, options);
  assert.equal(injectBlocks(once, metrics, options), once);
});

test("injectBlocks fails when a required marker is missing", () => {
  const document = [
    "# Title",
    "<!-- metrics:at-a-glance:renamed -->",
    "content",
    "<!-- metrics:at-a-glance:end -->",
  ].join("\n");

  assert.throws(
    () => injectBlocks(document, sampleMetrics(), { blocks: ["at-a-glance"], file: "README.md" }),
    (error) => {
      assert.match(error.message, /README\.md/);
      assert.match(error.message, /metrics:at-a-glance:start/);
      return true;
    },
  );
});

test("injectBlocks fails when a document is missing every marker", () => {
  assert.throws(
    () =>
      injectBlocks("# No markers here\n", sampleMetrics(), {
        blocks: ["coverage-config"],
        file: "docs/ENGINEERING.md",
      }),
    /docs\/ENGINEERING\.md is missing the marker/,
  );
});

test("injectBlocks fails on a duplicated start marker instead of eating the content between", () => {
  const document = [
    "# Title",
    "",
    "Here is how the markers look:",
    "",
    "```md",
    "<!-- metrics:at-a-glance:start -->",
    "```",
    "",
    "Prose that must survive.",
    "",
    "<!-- metrics:at-a-glance:start -->",
    "stale content",
    "<!-- metrics:at-a-glance:end -->",
    "",
  ].join("\n");

  assert.throws(
    () => injectBlocks(document, sampleMetrics(), { blocks: ["at-a-glance"], file: "README.md" }),
    (error) => {
      assert.match(error.message, /README\.md contains 2 copies/);
      assert.match(error.message, /metrics:at-a-glance:start/);
      return true;
    },
  );
});

test("injectBlocks fails on a duplicated end marker", () => {
  const document = [
    "<!-- metrics:at-a-glance:start -->",
    "stale",
    "<!-- metrics:at-a-glance:end -->",
    "<!-- metrics:at-a-glance:end -->",
  ].join("\n");

  assert.throws(
    () => injectBlocks(document, sampleMetrics(), { blocks: ["at-a-glance"], file: "README.md" }),
    /contains 2 copies of the marker `<!-- metrics:at-a-glance:end -->`/,
  );
});

test("injectBlocks fails when the end marker precedes the start marker", () => {
  const document = [
    "<!-- metrics:at-a-glance:end -->",
    "inverted",
    "<!-- metrics:at-a-glance:start -->",
  ].join("\n");

  assert.throws(
    () => injectBlocks(document, sampleMetrics(), { blocks: ["at-a-glance"], file: "README.md" }),
    /markers must be in order/,
  );
});

test("injectBlocks rejects an unknown block name", () => {
  assert.throws(
    () => injectBlocks("", sampleMetrics(), { blocks: ["not-a-block"] }),
    /unknown generated block/,
  );
});

test("formatCoverageFloor states the shared floor once when every gate agrees", () => {
  assert.equal(
    formatCoverageFloor({
      thresholds: [95],
      perFileEverywhere: true,
      typescriptConfigs: 19,
      pythonFailUnder: [95],
      pythonGatedPackages: 6,
    }),
    "95% lines, branches, functions, statements, enforced **per file** across 19 vitest configs and 6 Python packages",
  );
});

test("formatCoverageFloor drops the per-file claim when a config does not set perFile", () => {
  const row = formatCoverageFloor({
    thresholds: [95],
    perFileEverywhere: false,
    typescriptConfigs: 19,
    pythonFailUnder: [95],
    pythonGatedPackages: 6,
  });
  assert.doesNotMatch(row, /per file/);
  assert.match(row, /^95% lines, branches, functions, statements across 19 vitest configs/);
});

test("formatCoverageFloor states both floors when Python differs from TypeScript", () => {
  const row = formatCoverageFloor({
    thresholds: [95],
    perFileEverywhere: true,
    typescriptConfigs: 19,
    pythonFailUnder: [80],
    pythonGatedPackages: 6,
  });
  assert.match(row, /95% .* across 19 vitest configs/);
  assert.match(row, /80% across 6 Python packages/);
});

test("formatCoverageFloor states a range when Python packages disagree with each other", () => {
  const row = formatCoverageFloor({
    thresholds: [95],
    perFileEverywhere: true,
    typescriptConfigs: 19,
    pythonFailUnder: [80, 90, 95],
    pythonGatedPackages: 6,
  });
  assert.match(row, /80–95% across 6 Python packages/);
});

test("formatCoverageFloor omits Python entirely when no Python package is gated", () => {
  const row = formatCoverageFloor({
    thresholds: [95],
    perFileEverywhere: true,
    typescriptConfigs: 19,
    pythonFailUnder: [],
    pythonGatedPackages: 0,
  });
  assert.doesNotMatch(row, /Python/);
  assert.equal(
    row,
    "95% lines, branches, functions, statements, enforced **per file** across 19 vitest configs",
  );
});

test("formatCoverageFloor claims nothing when no floor is configured", () => {
  assert.equal(
    formatCoverageFloor({
      thresholds: [],
      perFileEverywhere: false,
      typescriptConfigs: 0,
      pythonFailUnder: [],
      pythonGatedPackages: 0,
    }),
    "no coverage floor configured",
  );
});

test("the at-a-glance coverage row reflects perFile and the Python floor", () => {
  const document = "<!-- metrics:at-a-glance:start -->\n\n<!-- metrics:at-a-glance:end -->\n";
  const metrics = sampleMetrics({
    perFileEverywhere: false,
    thresholds: [95],
    pythonFailUnder: [80],
    pythonGatedPackages: 6,
  });

  const result = injectBlocks(document, metrics, { blocks: ["at-a-glance"], file: "README.md" });
  assert.doesNotMatch(result, /per file/);
  assert.match(result, /80% across 6 Python packages/);
});

test("extractCoverageConfig reads literal thresholds and excludes", () => {
  const source = [
    'import { defineConfig } from "vitest/config";',
    "export default defineConfig({",
    "  test: {",
    "    coverage: {",
    "      thresholds: { perFile: true, lines: 95 },",
    '      exclude: ["dist/**", "src/index.ts"],',
    "    },",
    "  },",
    "});",
  ].join("\n");

  assert.deepEqual(extractCoverageConfig(source, "demo/vitest.config.ts"), {
    thresholds: { perFile: true, lines: 95 },
    exclude: ["dist/**", "src/index.ts"],
  });
});

test("extractCoverageConfig fails instead of publishing null for a spread exclude list", () => {
  const source = [
    'import { defineConfig } from "vitest/config";',
    'const shared = ["dist/**"];',
    "export default defineConfig({",
    "  test: {",
    "    coverage: {",
    "      thresholds: { perFile: true, lines: 95 },",
    '      exclude: [...shared, "src/index.ts"],',
    "    },",
    "  },",
    "});",
  ].join("\n");

  assert.throws(
    () => extractCoverageConfig(source, "demo/vitest.config.ts"),
    (error) => {
      assert.match(error.message, /demo\/vitest\.config\.ts/);
      assert.match(error.message, /test\.coverage\.exclude/);
      assert.match(error.message, /\.\.\.shared/);
      return true;
    },
  );
});

test("extractCoverageConfig fails on a computed threshold value", () => {
  const source = [
    'import { defineConfig } from "vitest/config";',
    "export default defineConfig({",
    "  test: { coverage: { thresholds: { lines: floor(95) }, exclude: [] } },",
    "});",
  ].join("\n");

  assert.throws(
    () => extractCoverageConfig(source, "demo/vitest.config.ts"),
    /test\.coverage\.thresholds\.lines — `floor\(95\)` is not a literal/,
  );
});

test("extractCoverageConfig fails on a spread inside the coverage object", () => {
  const source = [
    'import { defineConfig } from "vitest/config";',
    "export default defineConfig({",
    "  test: { coverage: { ...base, exclude: [] } },",
    "});",
  ].join("\n");

  assert.throws(() => extractCoverageConfig(source, "demo/vitest.config.ts"), /\.\.\.base/);
});

test("extractCoverageConfig fails when the config is not a defineConfig object literal", () => {
  const source = 'import { base } from "./base";\nexport default base;';
  assert.throws(
    () => extractCoverageConfig(source, "demo/vitest.config.ts"),
    /no `defineConfig\(\{ \.\.\. \}\)` object literal found/,
  );
});

test("extractCoverageConfig returns null when a config declares no coverage block", () => {
  const source = [
    'import { defineConfig } from "vitest/config";',
    'export default defineConfig({ test: { environment: "node" } });',
  ].join("\n");

  assert.equal(extractCoverageConfig(source, "demo/vitest.config.ts"), null);
});

test("writeUntilStable stops as soon as a pass changes nothing", () => {
  let calls = 0;
  const result = writeUntilStable(() => {
    calls += 1;
    return { changed: false, value: calls };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { value: 1, passes: 1 });
});

test("writeUntilStable runs a second pass when the first one wrote", () => {
  // Models the real feedback loop: pass 1 rewrites README.md, which changes the
  // line count that produced it, so the numbers only settle on pass 2.
  let lineCount = 10;
  let published = 0;
  const result = writeUntilStable(() => {
    const changed = published !== lineCount;
    if (changed) {
      published = lineCount;
      lineCount += 1;
      if (lineCount > 11) {
        lineCount = 11;
      }
    }
    return { changed, value: published };
  });
  assert.equal(result.passes, 3);
  assert.equal(result.value, 11);
});

test("writeUntilStable fails loudly when the output never settles", () => {
  let flip = 0;
  assert.throws(
    () =>
      writeUntilStable(() => {
        flip += 1;
        return { changed: true, value: flip };
      }),
    /did not stabilise after 3 passes/,
  );
  assert.equal(flip, 3);
});

test("assertBlockMarkers accepts a document that owns exactly one copy of each block", () => {
  const document = [
    "<!-- metrics:at-a-glance:start -->",
    "<!-- metrics:at-a-glance:end -->",
    "<!-- metrics:package-table:start -->",
    "<!-- metrics:package-table:end -->",
  ].join("\n");

  assert.doesNotThrow(() =>
    assertBlockMarkers(document, ["at-a-glance", "package-table"], "README.md"),
  );
});

test("assertBlockMarkers rejects a document before anything is written", () => {
  assert.throws(
    () => assertBlockMarkers("# nothing here\n", ["package-table"], "README.md"),
    /README\.md is missing the marker `<!-- metrics:package-table:start -->`/,
  );
});

test("selectProjectFiles drops a tracked file that has been deleted from disk", () => {
  // `git ls-files --cached` keeps listing a deleted-but-unstaged file. Counting
  // it used to blow up with a raw ENOENT out of countLines.
  const files = selectProjectFiles(
    ["src/kept.ts", "docs/DELETED.md", ""],
    (file) => file !== "docs/DELETED.md",
  );

  assert.deepEqual(files, ["src/kept.ts"]);
});

test("selectProjectFiles excludes generated output so --check can reach a fixed point", () => {
  const files = selectProjectFiles(
    ["docs/metrics.json", "portfolio/screenshots/system-map.svg", "README.md"],
    () => true,
  );

  assert.deepEqual(files, ["README.md"]);
});

test("selectProjectFiles de-duplicates and sorts the inventory", () => {
  const files = selectProjectFiles(["b.ts", "a.ts", "b.ts"], () => true);

  assert.deepEqual(files, ["a.ts", "b.ts"]);
});

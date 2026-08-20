import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnsiLine, renderTerminalSvg, scrubPaths, toDisplayLines } from "../docs/term-svg.mjs";

const ESC = String.fromCharCode(27);

test("parseAnsiLine returns a single default-coloured span for plain text", () => {
  const spans = parseAnsiLine("All files | 100 |");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "All files | 100 |");
  assert.equal(spans[0].bold, false);
});

test("parseAnsiLine splits SGR colour runs into separate spans", () => {
  const spans = parseAnsiLine(`${ESC}[32mPASS${ESC}[0m rest`);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, "PASS");
  assert.equal(spans[0].color, "#4ade80");
  assert.equal(spans[1].text, " rest");
  assert.equal(spans[1].color, "#d1d5db");
});

test("parseAnsiLine tracks bold on and off", () => {
  const spans = parseAnsiLine(`${ESC}[1mbold${ESC}[22mplain`);
  assert.equal(spans[0].bold, true);
  assert.equal(spans[1].bold, false);
});

test("parseAnsiLine drops non-SGR escape sequences without emitting them", () => {
  const spans = parseAnsiLine(`${ESC}[2Kerased`);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "erased");
  assert.doesNotMatch(spans[0].text, /\[2K/);
});

test("parseAnsiLine leaves no raw escape byte in any span", () => {
  // Regression: building the CSI matcher inside a template literal silently
  // turned `\[` into a character class, which threw at module load.
  const spans = parseAnsiLine(`${ESC}[31mred${ESC}[39mdefault`);
  for (const span of spans) {
    assert.doesNotMatch(span.text, new RegExp(ESC));
  }
});

test("scrubPaths removes the absolute repository prefix", () => {
  const scrubbed = scrubPaths("D:\\code\\ventora-platform-portfolio\\src\\index.ts 100%");
  assert.doesNotMatch(scrubbed, /ventora-platform-portfolio/);
  assert.match(scrubbed, /src\\index\.ts 100%/);
});

test("scrubPaths replaces a Windows user directory with a tilde", () => {
  assert.match(scrubPaths("C:\\Users\\someone\\AppData"), /^~\\AppData$/);
});

test("scrubPaths replaces a POSIX home directory with a tilde", () => {
  assert.match(scrubPaths("/home/someone/project"), /^~\/project$/);
});

test("scrubPaths finishes quickly on a long path-like token without the repo name", () => {
  // Regression: a nested quantifier in the drive-letter pattern caused
  // catastrophic backtracking (measured: 30 segments = 9.4s) whenever the
  // literal "ventora-platform-portfolio" never appeared in the token.
  const segments = Array.from({ length: 40 }, (_, i) => `segment-${i}`).join("\\");
  const longToken = `D:\\${segments}\\file.ts`;
  const start = Date.now();
  scrubPaths(longToken);
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 500,
    `expected scrubPaths to finish in well under a second, took ${elapsed}ms`,
  );
});

test("scrubPaths leaves a GitHub URL to this repo untouched", () => {
  // This is a public portfolio repo, so its own GitHub URL showing up in
  // captured output is the normal case, not a machine path to scrub. The
  // drive-letter pattern used to false-match the "s:" inside "https://".
  const input = "see https://github.com/angel/ventora-platform-portfolio/blob/main/README.md";
  assert.equal(scrubPaths(input), input);
});

test("scrubPaths leaves a URL whose path contains /home/ untouched", () => {
  const input = "docs at https://x.dev/home/guide";
  assert.equal(scrubPaths(input), input);
});

test("toDisplayLines collapses carriage-return spinner frames to the final frame", () => {
  const lines = toDisplayLines("building\rbuilding.\rbuilding..\ndone");
  assert.deepEqual(lines, ["building..", "done"]);
});

test("toDisplayLines strips a UTF-8 byte order mark", () => {
  assert.equal(toDisplayLines("\ufefffirst")[0], "first");
});

test("toDisplayLines collapses runs of blank lines", () => {
  assert.deepEqual(toDisplayLines("a\n\n\n\nb"), ["a", "", "b"]);
});

test("renderTerminalSvg emits a valid root element with the command in the prompt", () => {
  const svg = renderTerminalSvg({ command: "pnpm verify", output: "ok" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>\n$/);
  assert.match(svg, /pnpm verify/);
  assert.match(svg, /<tspan class="prompt">\$ <\/tspan>/);
});

test("renderTerminalSvg escapes XML-significant characters in output", () => {
  const svg = renderTerminalSvg({ command: "echo", output: '<script>&"' });
  assert.match(svg, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(svg, /<script>/);
});

test("renderTerminalSvg never leaks an absolute path into the rendered image", () => {
  const svg = renderTerminalSvg({
    command: "pnpm test",
    output: "D:\\code\\ventora-platform-portfolio\\packages\\seo\\src\\index.ts",
  });
  assert.doesNotMatch(svg, /ventora-platform-portfolio/);
});

test("renderTerminalSvg truncates very long output and says how much it dropped", () => {
  const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const svg = renderTerminalSvg({ command: "long", output });
  assert.match(svg, /more lines/);
});

test("parseAnsiLine strips an OSC title sequence and leaves no control byte behind", () => {
  const BEL = String.fromCharCode(7);
  const spans = parseAnsiLine(`${ESC}]0;title${BEL}text`);
  const combined = spans.map((span) => span.text).join("");
  assert.equal(combined, "text");
  assert.equal(combined.includes(ESC), false);
  assert.equal(combined.includes(BEL), false);
});

test("renderTerminalSvg caps total visible characters at MAX_COLUMNS across multiple spans on one line", () => {
  // Regression: truncation was applied per-span (span.text.slice(0, MAX_COLUMNS))
  // instead of per-line, so a multi-colour line (like a coverage table row)
  // could render more columns than the canvas was sized for.
  const first = "a".repeat(80);
  const second = "b".repeat(80);
  const line = `${ESC}[32m${first}${ESC}[0m${second}`;
  const svg = renderTerminalSvg({ command: "x", output: line });
  const textBlocks = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)];
  const bodyBlock = textBlocks[textBlocks.length - 1];
  assert.ok(bodyBlock, "expected a body <text> element for the rendered line");
  const visible = bodyBlock[1].replace(/<[^>]+>/g, "");
  assert.equal(visible.length, 124);
  assert.equal(visible, `${first}${"b".repeat(44)}`);
});

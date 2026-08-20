#!/usr/bin/env node
/**
 * Renders captured terminal output to a self-contained SVG.
 *
 * SVG rather than PNG because terminal output is text: it stays crisp at any
 * zoom, weighs a few kilobytes instead of a few hundred, and diffs as text in
 * review. ANSI SGR colour codes are translated to `<tspan>` fills so a real
 * coverage table or a red failure line survives the trip.
 *
 * The rendered prompt is a bare `$` — never a machine path or username, since
 * these images are published.
 *
 *   node scripts/docs/term-svg.mjs --command "pnpm verify" --out portfolio/screenshots/x.svg < captured.txt
 *
 * Also importable: `renderTerminalSvg({ command, output, title })`.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Monospace metrics at 13px — measured for the font stack below. */
const CHAR_WIDTH = 7.8;
const LINE_HEIGHT = 19;
const PADDING_X = 18;
const PADDING_TOP = 46;
const PADDING_BOTTOM = 16;
const MAX_COLUMNS = 124;
const MAX_LINES = 46;

/** xterm palette, tuned for legibility on the dark surface used below. */
const ANSI_COLORS = new Map([
  [30, "#5c6370"],
  [31, "#f87171"],
  [32, "#4ade80"],
  [33, "#fbbf24"],
  [34, "#60a5fa"],
  [35, "#c084fc"],
  [36, "#22d3ee"],
  [37, "#d1d5db"],
  [90, "#6b7280"],
  [91, "#fca5a5"],
  [92, "#86efac"],
  [93, "#fcd34d"],
  [94, "#93c5fd"],
  [95, "#d8b4fe"],
  [96, "#67e8f9"],
  [97, "#f9fafb"],
]);

const DEFAULT_FG = "#d1d5db";

/** ASCII escape. Built from a char code so no control character sits in source. */
const ESC = String.fromCharCode(27);

/** @param {string} value @returns {string} */
function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BEL = String.fromCharCode(7);

/**
 * Strips ANSI escape sequences that are not CSI (`ESC [ ... letter`), plus
 * any C0 control byte other than tab that is not `ESC`. `ESC` itself is left
 * alone here so the caller's CSI loop can still recognise `ESC [ ... m`; a
 * leftover, unrecognised `ESC` is swept up afterwards by `dropStrayControlBytes`.
 * `0x1B` and `0x07` sit outside the XML 1.0 `Char` production, so if either
 * survives into the SVG a conforming renderer refuses the file. Handles:
 *
 *   - OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`), e.g. a terminal
 *     title-setting escape.
 *   - Other escape sequences of the general ECMA-48 form `ESC I* F` (zero or
 *     more intermediate bytes `0x20-0x2F` then one final byte `0x30-0x7E`),
 *     e.g. `ESC ( B`. CSI (`ESC [`) is excluded so the caller's SGR pattern
 *     still sees it.
 *   - Any leftover C0 control byte (`0x00-0x1F`) other than tab and `ESC`.
 *
 * @param {string} line @returns {string}
 */
function stripNonCsiEscapes(line) {
  return (
    line
      .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"), "")
      .replace(new RegExp(`${ESC}(?!\\[)[\\x20-\\x2F]*[\\x30-\\x7E]`, "g"), "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping raw C0 control bytes (ESC excluded here; it's dropped separately once CSI parsing is done) so the SVG stays XML 1.0 legal.
      .replace(/[\u0000-\u0008\u000A-\u001A\u001C-\u001F]/g, "")
  );
}

/**
 * Removes any stray C0 control byte other than tab from already-CSI-parsed
 * text, including a leftover `ESC` that was not part of a recognised sequence.
 *
 * @param {string} value @returns {string}
 */
function dropStrayControlBytes(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping raw C0 control bytes so the SVG stays XML 1.0 legal.
  return value.replace(/[\u0000-\u0008\u000A-\u001F]/g, "");
}

/**
 * Splits a line containing ANSI SGR escapes into coloured spans. Unsupported
 * CSI sequences (cursor movement, erase-line) are dropped rather than
 * rendered, which is what makes progress-spinner output legible. Non-CSI
 * escapes (OSC titles, charset-designation sequences) are stripped first,
 * and any remaining C0 control byte — including a stray `ESC` that was not
 * part of a recognised sequence — is dropped from each span's text so the
 * result is always safe to embed in XML.
 *
 * @param {string} line
 * @returns {{text: string, color: string, bold: boolean}[]}
 */
export function parseAnsiLine(line) {
  const cleaned = stripNonCsiEscapes(line);
  /** @type {{text: string, color: string, bold: boolean}[]} */
  const spans = [];
  let color = DEFAULT_FG;
  let bold = false;
  let buffer = "";

  const flush = () => {
    if (buffer.length > 0) {
      spans.push({ text: dropStrayControlBytes(buffer), color, bold });
      buffer = "";
    }
  };

  // Matches CSI sequences; only SGR (`m`) is interpreted, the rest are dropped.
  const pattern = new RegExp(`${ESC}\\[([0-9;]*)([A-Za-z])`, "g");
  let lastIndex = 0;
  let match = pattern.exec(cleaned);

  while (match !== null) {
    buffer += cleaned.slice(lastIndex, match.index);
    if (match[2] === "m") {
      flush();
      const codes = match[1].split(";").filter((code) => code.length > 0);
      if (codes.length === 0) {
        color = DEFAULT_FG;
        bold = false;
      }
      for (const raw of codes) {
        const code = Number(raw);
        if (code === 0) {
          color = DEFAULT_FG;
          bold = false;
        } else if (code === 1) {
          bold = true;
        } else if (code === 22) {
          bold = false;
        } else if (code === 39) {
          color = DEFAULT_FG;
        } else if (ANSI_COLORS.has(code)) {
          color = ANSI_COLORS.get(code) ?? DEFAULT_FG;
        }
      }
    }
    lastIndex = match.index + match[0].length;
    match = pattern.exec(cleaned);
  }

  buffer += cleaned.slice(lastIndex);
  flush();
  return spans;
}

/**
 * Rewrites absolute filesystem paths to repository-relative ones. Tool output
 * routinely prints the working directory (vitest coverage tables do), and these
 * SVGs are published, so a machine path would leak the author's directory
 * layout and username into a public asset.
 *
 * The drive-letter and `/home/` patterns are guarded so they never fire
 * inside a URL (e.g. the `s:` in `https://` or a literal `/home/` segment in
 * a URL path) — this is a public portfolio repo, so its own GitHub URL
 * showing up in captured output is expected and must survive untouched.
 *
 * @param {string} output @returns {string}
 */
export function scrubPaths(output) {
  return output
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>|]*?ventora-platform-portfolio[\\/]/gi, "")
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/]Users[\\/][^\s"'<>|\\/]+/gi, "~")
    .replace(/(?<![A-Za-z0-9_.:])\/home\/[^\s"'<>|/]+/g, "~");
}

/**
 * Removes carriage-return redraws so spinner frames collapse to their final
 * state instead of stacking on one line.
 *
 * @param {string} output @returns {string[]}
 */
export function toDisplayLines(output) {
  return scrubPaths(output)
    .replace(/^﻿/, "")
    .replace(/﻿/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const frames = line.split("\r");
      return frames[frames.length - 1];
    })
    .filter((line, index, all) => !(line.trim() === "" && all[index - 1]?.trim() === ""));
}

/**
 * @param {{command: string, output: string, title?: string}} options
 * @returns {string}
 */
export function renderTerminalSvg({ command, output, title }) {
  const rawLines = toDisplayLines(output);
  const truncated = rawLines.length > MAX_LINES;
  const lines = truncated ? rawLines.slice(0, MAX_LINES - 1) : rawLines;
  if (truncated) {
    lines.push(`… ${rawLines.length - (MAX_LINES - 1)} more lines`);
  }

  const promptLine = `$ ${command}`;
  const columns = Math.min(
    MAX_COLUMNS,
    Math.max(promptLine.length, ...lines.map((line) => stripAnsi(line).length), 40),
  );
  const width = Math.ceil(columns * CHAR_WIDTH + PADDING_X * 2);
  const height = Math.ceil(PADDING_TOP + (lines.length + 1) * LINE_HEIGHT + PADDING_BOTTOM);

  const body = lines
    .map((line, index) => {
      const y = PADDING_TOP + (index + 2) * LINE_HEIGHT;
      const spans = parseAnsiLine(line);
      if (spans.length === 0) {
        return "";
      }
      // Truncation is a per-line budget, not a per-span cap: a coloured line
      // is often several spans (see `pnpm run test:coverage`'s tables), and
      // capping each span independently would let the line as a whole run
      // past the canvas width computed from MAX_COLUMNS.
      let remaining = MAX_COLUMNS;
      const content = spans
        .map((span) => {
          if (remaining <= 0) {
            return "";
          }
          const visible = span.text.slice(0, remaining);
          remaining -= visible.length;
          const text = escapeXml(visible);
          const weight = span.bold ? ' font-weight="600"' : "";
          return `<tspan fill="${span.color}"${weight} xml:space="preserve">${text}</tspan>`;
        })
        .join("");
      return `  <text x="${PADDING_X}" y="${y}">${content}</text>`;
    })
    .filter((line) => line.length > 0)
    .join("\n");

  const label = title ?? command;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<style>
  text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;}
  .chrome{fill:#0d1117}
  .bar{fill:#161b22}
  .dot1{fill:#ff5f57}.dot2{fill:#febc2e}.dot3{fill:#28c840}
  .prompt{fill:#7ee787}
  .cmd{fill:#e6edf3;font-weight:600}
</style>
  <rect class="chrome" width="${width}" height="${height}" rx="8"/>
  <path class="bar" d="M0 8a8 8 0 0 1 8-8h${width - 16}a8 8 0 0 1 8 8v22H0z"/>
  <circle class="dot1" cx="18" cy="16" r="5.5"/>
  <circle class="dot2" cx="36" cy="16" r="5.5"/>
  <circle class="dot3" cx="54" cy="16" r="5.5"/>
  <text x="${PADDING_X}" y="${PADDING_TOP + LINE_HEIGHT}"><tspan class="prompt">$ </tspan><tspan class="cmd">${escapeXml(command)}</tspan></text>
${body}
</svg>
`;
}

/** @param {string} value @returns {string} */
function stripAnsi(value) {
  return value.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

/** True when run directly rather than imported by a test. */
const isEntrypoint = process.argv[1]?.endsWith("term-svg.mjs") === true;

if (isEntrypoint) {
  const args = process.argv.slice(2);
  const readFlag = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const command = readFlag("command");
  const out = readFlag("out");
  const input = readFlag("in");
  if (command === undefined || out === undefined) {
    process.stderr.write("usage: term-svg.mjs --command <cmd> --out <file.svg> [--in <file>]\n");
    process.exit(1);
  }
  const output = input === undefined ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  writeFileSync(out, renderTerminalSvg({ command, output, title: readFlag("title") }));
  process.stdout.write(`wrote ${out}\n`);
}

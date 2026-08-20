import type React from "react";
import { isSafeLinkUrl } from "./AiCsWidget.js";

// Block types produced by the block parser
type ParagraphBlock = { kind: "paragraph"; lines: string[] };
type CodeBlock = { kind: "code"; text: string };
type UnorderedListBlock = { kind: "ulist"; items: string[] };
type OrderedListBlock = { kind: "olist"; items: string[] };
type TableBlock = { kind: "table"; headers: string[]; rows: string[][] };
type MarkdownBlock =
  | ParagraphBlock
  | CodeBlock
  | UnorderedListBlock
  | OrderedListBlock
  | TableBlock;

// Inline token types
type TextToken = { kind: "text"; value: string };
type BoldToken = { kind: "bold"; value: string };
type ItalicToken = { kind: "italic"; value: string };
type InlineCodeToken = { kind: "inlineCode"; value: string };
type LinkToken = { kind: "link"; label: string; url: string };
type InlineToken = TextToken | BoldToken | ItalicToken | InlineCodeToken | LinkToken;

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    /* v8 ignore next */
    if (match.index === undefined) continue;
    const before = text.slice(lastIndex, match.index);
    if (before.length > 0) tokens.push({ kind: "text", value: before });

    const token = match[0];
    if (token.startsWith("**")) {
      tokens.push({ kind: "bold", value: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      tokens.push({ kind: "inlineCode", value: token.slice(1, -1) });
    } else if (token.startsWith("*")) {
      tokens.push({ kind: "italic", value: token.slice(1, -1) });
    } else {
      // Link: [label](url)
      const closeBracket = token.indexOf("](");
      const label = token.slice(1, closeBracket);
      const url = token.slice(closeBracket + 2, -1);
      tokens.push({ kind: "link", label, url });
    }

    lastIndex = match.index + token.length;
  }

  const tail = text.slice(lastIndex);
  if (tail.length > 0) tokens.push({ kind: "text", value: tail });

  return tokens;
}

function renderInlineTokens(tokens: InlineToken[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    if (token.kind === "text") return token.value;
    if (token.kind === "bold") return <strong key={key}>{token.value}</strong>;
    if (token.kind === "italic") return <em key={key}>{token.value}</em>;
    if (token.kind === "inlineCode") return <code key={key}>{token.value}</code>;
    // link
    if (isSafeLinkUrl(token.url)) {
      return (
        <a key={key} href={token.url} target="_blank" rel="noopener noreferrer">
          {token.label}
        </a>
      );
    }
    // unsafe link — render as plain text (label only, drop the URL)
    return token.label;
  });
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return renderInlineTokens(parseInlineTokens(text), keyPrefix);
}

function renderParagraphLines(lines: string[], keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    /* v8 ignore next */
    const line = lines[i] ?? "";
    nodes.push(...renderInline(line, `${keyPrefix}-line-${i}`));
    if (i < lines.length - 1) {
      nodes.push(<br key={`${keyPrefix}-br-${i}`} />);
    }
  }
  return nodes;
}

// Table helpers — semantics mirror AI-SDR's isMarkdownTableRow / isMarkdownTableSeparator / tableCells
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && tableCells(line).length > 1;
}

function isMarkdownTableSeparator(line: string): boolean {
  return TABLE_SEPARATOR_RE.test(line);
}

function parseBlocks(raw: string): MarkdownBlock[] {
  const lines = raw.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let ulistItems: string[] = [];
  let olistItems: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraphLines });
      paragraphLines = [];
    }
  };
  const flushUlist = (): void => {
    if (ulistItems.length > 0) {
      blocks.push({ kind: "ulist", items: ulistItems });
      ulistItems = [];
    }
  };
  const flushOlist = (): void => {
    if (olistItems.length > 0) {
      blocks.push({ kind: "olist", items: olistItems });
      olistItems = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (inFence) {
      if (line.trimStart().startsWith("```")) {
        // End of fence
        blocks.push({ kind: "code", text: fenceLines.join("\n") });
        fenceLines = [];
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      i++;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushUlist();
      flushOlist();
      inFence = true;
      fenceLines = [];
      i++;
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushUlist();
      flushOlist();
      i++;
      continue;
    }

    // Table detection: current line is a table row AND next line is a separator
    const nextLine = lines[i + 1] ?? "";
    if (isMarkdownTableRow(trimmed) && isMarkdownTableSeparator(nextLine.trim())) {
      flushParagraph();
      flushUlist();
      flushOlist();
      const headers = tableCells(trimmed);
      // skip header line and separator line
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const bodyLine = lines[i] ?? "";
        const bodyTrimmed = bodyLine.trim();
        if (bodyTrimmed === "" || !isMarkdownTableRow(bodyTrimmed)) break;
        rows.push(tableCells(bodyTrimmed));
        i++;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const ulistMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    const olistMatch = /^\d+\.\s+(.+)$/.exec(trimmed);

    if (ulistMatch) {
      flushParagraph();
      flushOlist();
      /* v8 ignore next */
      ulistItems.push((ulistMatch[1] ?? "").trim());
    } else if (olistMatch) {
      flushParagraph();
      flushUlist();
      /* v8 ignore next */
      olistItems.push((olistMatch[1] ?? "").trim());
    } else {
      flushUlist();
      flushOlist();
      paragraphLines.push(trimmed);
    }

    i++;
  }

  // Flush any open fence as a code block (unclosed fence)
  if (inFence && fenceLines.length > 0) {
    blocks.push({ kind: "code", text: fenceLines.join("\n") });
  }

  flushParagraph();
  flushUlist();
  flushOlist();

  return blocks.length > 0 ? blocks : [{ kind: "paragraph", lines: [""] }];
}

/**
 * Renders a markdown string as React elements. XSS-safe by construction —
 * never uses dangerouslySetInnerHTML.
 *
 * Supported: bold (**x**), italic (*x*), inline code (`x`), fenced code
 * blocks (```), safe links ([label](url)), unordered lists (- / * / +),
 * ordered lists (1.), paragraphs, soft line breaks, GitHub-flavored markdown
 * tables (header row + separator with 3+ dashes + body rows).
 */
export function renderMarkdown(content: string): React.ReactNode {
  const blocks = parseBlocks(content);

  return blocks.map((block, blockIndex) => {
    const bk = `b${blockIndex}`;
    if (block.kind === "code") {
      return (
        <pre key={`${bk}-code`} data-aics-md-pre="">
          <code>{block.text}</code>
        </pre>
      );
    }

    if (block.kind === "ulist") {
      return (
        <ul key={`${bk}-ul`} data-aics-md-ul="">
          {block.items.map((item, i) => (
            <li key={`${bk}-li-${i}-${item.slice(0, 12)}`}>{renderInline(item, `${bk}-li${i}`)}</li>
          ))}
        </ul>
      );
    }

    if (block.kind === "olist") {
      return (
        <ol key={`${bk}-ol`} data-aics-md-ol="">
          {block.items.map((item, i) => (
            <li key={`${bk}-li-${i}-${item.slice(0, 12)}`}>{renderInline(item, `${bk}-li${i}`)}</li>
          ))}
        </ol>
      );
    }

    if (block.kind === "table") {
      return (
        <div key={`${bk}-tbl-wrap`} data-aics-table-wrap="">
          <table data-aics-table="">
            <thead>
              <tr>
                {block.headers.map((header, hi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table column order is stable by position
                  <th key={`${bk}-th-${hi}`}>{renderInline(header, `${bk}-th${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table row order is stable by position
                <tr key={`${bk}-tr-${ri}`}>
                  {block.headers.map((_header, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cell order is stable by position
                    <td key={`${bk}-td-${ri}-${ci}`}>
                      {renderInline(row[ci] ?? "", `${bk}-td${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    // paragraph
    return (
      <p key={`${bk}-p`} data-aics-md-p="">
        {renderParagraphLines(block.lines, bk)}
      </p>
    );
  });
}

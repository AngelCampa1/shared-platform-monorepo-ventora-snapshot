// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown.js";

afterEach(cleanup);

function Wrapper({ content }: { content: string }): React.ReactElement {
  return <div data-testid="root">{renderMarkdown(content)}</div>;
}

describe("renderMarkdown", () => {
  it("renders plain text unchanged", () => {
    render(<Wrapper content="Hello world" />);
    expect(screen.getByTestId("root").textContent).toBe("Hello world");
    expect(screen.getByTestId("root").querySelector("strong")).toBeNull();
  });

  it("renders bold **x**", () => {
    render(<Wrapper content="**bold** text" />);
    const strong = screen.getByTestId("root").querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
  });

  it("renders italic *x*", () => {
    render(<Wrapper content="*italic* text" />);
    const em = screen.getByTestId("root").querySelector("em");
    expect(em).not.toBeNull();
    expect(em?.textContent).toBe("italic");
  });

  it("renders inline code `x`", () => {
    render(<Wrapper content="use `console.log` here" />);
    const code = screen.getByTestId("root").querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("console.log");
  });

  it("renders fenced code block", () => {
    const content = "```\nconst x = 1;\n```";
    render(<Wrapper content={content} />);
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("renders fenced code block with language hint", () => {
    const content = "```ts\nconst x: number = 1;\n```";
    render(<Wrapper content={content} />);
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("const x: number = 1;");
  });

  it("renders safe link as anchor with rel/target", () => {
    render(<Wrapper content="[Visit](https://example.com)" />);
    const a = screen.getByTestId("root").querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe("Visit");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders unsafe javascript: link as plain text, NOT anchor", () => {
    render(<Wrapper content="[click](javascript:alert(1))" />);
    const a = screen.getByTestId("root").querySelector("a");
    expect(a).toBeNull();
    // The label text must still appear
    expect(screen.getByTestId("root").textContent).toContain("click");
  });

  it("renders unsafe data: link as plain text, NOT anchor", () => {
    render(<Wrapper content="[x](data:text/html,<h1>xss</h1>)" />);
    const a = screen.getByTestId("root").querySelector("a");
    expect(a).toBeNull();
  });

  it("renders unordered list items (- prefix)", () => {
    const content = "- alpha\n- beta\n- gamma";
    render(<Wrapper content={content} />);
    const ul = screen.getByTestId("root").querySelector("ul");
    expect(ul).not.toBeNull();
    const items = ul?.querySelectorAll("li");
    expect(items?.length).toBe(3);
    expect(items?.[0]?.textContent).toBe("alpha");
    expect(items?.[1]?.textContent).toBe("beta");
    expect(items?.[2]?.textContent).toBe("gamma");
  });

  it("renders unordered list items (* prefix)", () => {
    const content = "* one\n* two";
    render(<Wrapper content={content} />);
    const ul = screen.getByTestId("root").querySelector("ul");
    expect(ul).not.toBeNull();
    const items = ul?.querySelectorAll("li");
    expect(items?.length).toBe(2);
  });

  it("renders ordered list", () => {
    const content = "1. first\n2. second\n3. third";
    render(<Wrapper content={content} />);
    const ol = screen.getByTestId("root").querySelector("ol");
    expect(ol).not.toBeNull();
    const items = ol?.querySelectorAll("li");
    expect(items?.length).toBe(3);
    expect(items?.[0]?.textContent).toBe("first");
    expect(items?.[2]?.textContent).toBe("third");
  });

  it("renders multi-paragraph text as separate <p> elements", () => {
    const content = "Para one.\n\nPara two.";
    render(<Wrapper content={content} />);
    const paragraphs = screen.getByTestId("root").querySelectorAll("p");
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(paragraphs[0]?.textContent).toContain("Para one.");
    expect(paragraphs[1]?.textContent).toContain("Para two.");
  });

  it("renders soft line break as <br/> within a paragraph", () => {
    const content = "line one\nline two";
    render(<Wrapper content={content} />);
    const br = screen.getByTestId("root").querySelector("br");
    expect(br).not.toBeNull();
  });

  it("renders unclosed fenced code block gracefully", () => {
    const content = "```\nconst x = 1;";
    render(<Wrapper content={content} />);
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("renders empty string without crashing", () => {
    render(<Wrapper content="" />);
    // Should render at least a p element or nothing — no crash
    const root = screen.getByTestId("root");
    expect(root).not.toBeNull();
  });

  it("does not use dangerouslySetInnerHTML (no innerHTML assignment)", () => {
    // XSS safety: raw HTML in content must not be interpreted
    const content = "<script>alert(1)</script> normal";
    render(<Wrapper content={content} />);
    const scripts = screen.getByTestId("root").querySelectorAll("script");
    expect(scripts.length).toBe(0);
    // The text content should contain the literal characters
    expect(screen.getByTestId("root").textContent).toContain("normal");
  });
});

describe("renderMarkdown — tables", () => {
  it("renders a basic 2-column table with thead th and tbody td", () => {
    const content = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const ths = table?.querySelectorAll("thead th");
    expect(ths?.length).toBe(2);
    expect(ths?.[0]?.textContent).toBe("Name");
    expect(ths?.[1]?.textContent).toBe("Age");
    const rows = table?.querySelectorAll("tbody tr");
    expect(rows?.length).toBe(2);
    const firstRowCells = rows?.[0]?.querySelectorAll("td");
    expect(firstRowCells?.[0]?.textContent).toBe("Alice");
    expect(firstRowCells?.[1]?.textContent).toBe("30");
  });

  it("renders inline markdown inside table cells (bold and link)", () => {
    const content =
      "| Col | Extra |\n| --- | --- |\n| **bold** | x |\n| [link](https://example.com) | y |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const strong = table?.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
    const a = table?.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });

  it("pads a row with fewer cells than headers with empty trailing cells", () => {
    // Body row has 2 cells but headers have 3 — third td must be empty
    const content = "| A | B | C |\n| --- | --- | --- |\n| one | two |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const tds = table?.querySelectorAll("tbody tr td");
    // 3 headers → 3 tds; body row only supplied 2 cells so last is empty
    expect(tds?.length).toBe(3);
    expect(tds?.[0]?.textContent).toBe("one");
    expect(tds?.[1]?.textContent).toBe("two");
    expect(tds?.[2]?.textContent).toBe("");
  });

  it("truncates a row with more cells than headers to header count", () => {
    const content = "| A | B |\n| --- | --- |\n| one | two | three | four |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const tds = table?.querySelectorAll("tbody tr td");
    // 2 headers → 2 tds, extras truncated
    expect(tds?.length).toBe(2);
    expect(tds?.[0]?.textContent).toBe("one");
    expect(tds?.[1]?.textContent).toBe("two");
  });

  it("does NOT render a table when there is no separator line", () => {
    const content = "| Name | Age |\n| Alice | 30 |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).toBeNull();
    // Falls back to paragraph-ish text
    expect(screen.getByTestId("root").textContent).toContain("Name");
  });

  it("does NOT treat a separator with fewer than 3 dashes as a table (parity)", () => {
    // Single or double dash — should NOT trigger table parsing
    const content = "| A | B |\n| - | - |\n| x | y |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).toBeNull();
  });

  it("parses a table that immediately follows a paragraph and precedes a list", () => {
    const content = "Intro paragraph.\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |\n\n- list item";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const p = screen.getByTestId("root").querySelector("p");
    expect(p).not.toBeNull();
    expect(p?.textContent).toContain("Intro paragraph.");
    const li = screen.getByTestId("root").querySelector("li");
    expect(li).not.toBeNull();
    expect(li?.textContent).toBe("list item");
  });

  it("degrades an unsafe link inside a cell to plain text (no anchor)", () => {
    const content = "| Link | Extra |\n| --- | --- |\n| [bad](javascript:alert(1)) | x |";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).not.toBeNull();
    const a = table?.querySelector("a");
    expect(a).toBeNull();
    // Label text still visible
    expect(table?.textContent).toContain("bad");
  });

  it("does not interpret pipe-like text inside a fenced code block as a table", () => {
    const content = "```\n| A | B |\n| --- | --- |\n| x | y |\n```";
    render(<Wrapper content={content} />);
    const table = screen.getByTestId("root").querySelector("table");
    expect(table).toBeNull();
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre).not.toBeNull();
  });
});

// ── Defect D FALSE POSITIVE: parseBlocks preserves content around unclosed fence ──
describe("renderMarkdown unclosed fence content preservation (Defect D — FALSE POSITIVE)", () => {
  it("paragraph before unclosed fence is flushed and rendered as <p>", () => {
    // flushParagraph() is called when the opening ``` is encountered, so
    // "before fence" must appear as a paragraph even if the fence is never closed.
    const content = "before fence\n```\ncode line";
    render(<Wrapper content={content} />);
    const root = screen.getByTestId("root");
    expect(root.querySelector("p")?.textContent).toContain("before fence");
    expect(root.querySelector("pre")?.textContent).toContain("code line");
  });

  it("all lines inside an unclosed fence are preserved in the code block", () => {
    // After the loop, inFence=true + fenceLines has both lines → code block emitted.
    // No content is silently dropped.
    const content = "```\ncode\nafter content";
    render(<Wrapper content={content} />);
    const root = screen.getByTestId("root");
    const pre = root.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("code");
    expect(pre?.textContent).toContain("after content");
  });
});

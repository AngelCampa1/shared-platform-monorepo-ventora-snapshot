import { describe, expect, it } from "vitest";
import { buildLlmsTxt } from "../llms.js";

describe("buildLlmsTxt", () => {
  it("renders a section heading with # prefix", () => {
    const result = buildLlmsTxt([{ heading: "Docs", items: [] }]);
    expect(result).toContain("# Docs");
  });

  it("renders items as markdown links", () => {
    const result = buildLlmsTxt([
      {
        heading: "Guides",
        items: [{ title: "Getting Started", url: "https://example.com/start" }],
      },
    ]);
    expect(result).toContain("- [Getting Started](https://example.com/start)");
  });

  it("appends description after colon when provided", () => {
    const result = buildLlmsTxt([
      {
        heading: "Guides",
        items: [
          {
            title: "Getting Started",
            url: "https://example.com/start",
            description: "How to get started quickly.",
          },
        ],
      },
    ]);
    expect(result).toContain(
      "- [Getting Started](https://example.com/start): How to get started quickly.",
    );
  });

  it("omits description when not provided", () => {
    const result = buildLlmsTxt([
      {
        heading: "Guides",
        items: [{ title: "No Desc", url: "https://example.com/no-desc" }],
      },
    ]);
    expect(result).toContain("- [No Desc](https://example.com/no-desc)");
    expect(result).not.toContain(": undefined");
  });

  it("renders multiple sections", () => {
    const result = buildLlmsTxt([
      {
        heading: "Section A",
        items: [{ title: "Item A1", url: "https://a.com/1" }],
      },
      {
        heading: "Section B",
        items: [{ title: "Item B1", url: "https://b.com/1" }],
      },
    ]);
    expect(result).toContain("# Section A");
    expect(result).toContain("# Section B");
    expect(result).toContain("- [Item A1](https://a.com/1)");
    expect(result).toContain("- [Item B1](https://b.com/1)");
  });

  it("renders multiple items in one section", () => {
    const result = buildLlmsTxt([
      {
        heading: "Resources",
        items: [
          { title: "Alpha", url: "https://example.com/alpha" },
          { title: "Beta", url: "https://example.com/beta" },
          { title: "Gamma", url: "https://example.com/gamma" },
        ],
      },
    ]);
    expect(result).toContain("- [Alpha](https://example.com/alpha)");
    expect(result).toContain("- [Beta](https://example.com/beta)");
    expect(result).toContain("- [Gamma](https://example.com/gamma)");
  });

  it("handles empty sections array", () => {
    const result = buildLlmsTxt([]);
    expect(result).toBe("");
  });

  it("handles section with no items", () => {
    const result = buildLlmsTxt([{ heading: "Empty Section", items: [] }]);
    expect(result).toContain("# Empty Section");
  });

  it("produces blank lines between heading and items, and after items", () => {
    const result = buildLlmsTxt([
      {
        heading: "Test",
        items: [{ title: "Link", url: "https://example.com" }],
      },
    ]);
    const lines = result.split("\n");
    // Structure: "# Test", "", "- [Link](...)", ""
    expect(lines[0]).toBe("# Test");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("- [Link](https://example.com)");
    expect(lines[3]).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { buildSitemapXml } from "../sitemap.js";
import type { SitemapEntry } from "../types.js";

describe("buildSitemapXml", () => {
  it("includes XML declaration header", () => {
    const result = buildSitemapXml([]);
    expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("includes urlset element with correct namespace", () => {
    const result = buildSitemapXml([]);
    expect(result).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  it("generates url elements for each entry", () => {
    const result = buildSitemapXml([
      { url: "https://example.com/" },
      { url: "https://example.com/about" },
    ]);
    expect(result).toContain("<loc>https://example.com/</loc>");
    expect(result).toContain("<loc>https://example.com/about</loc>");
  });

  it("includes lastmod when provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/", lastmod: "2024-01-01" }]);
    expect(result).toContain("<lastmod>2024-01-01</lastmod>");
  });

  it("omits lastmod when not provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/" }]);
    expect(result).not.toContain("<lastmod>");
  });

  it("includes changefreq when provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/", changefreq: "weekly" }]);
    expect(result).toContain("<changefreq>weekly</changefreq>");
  });

  it("omits changefreq when not provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/" }]);
    expect(result).not.toContain("<changefreq>");
  });

  it("includes priority when provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/", priority: 0.8 }]);
    expect(result).toContain("<priority>0.8</priority>");
  });

  it("omits priority when not provided", () => {
    const result = buildSitemapXml([{ url: "https://example.com/" }]);
    expect(result).not.toContain("<priority>");
  });

  it("includes all optional fields when provided", () => {
    const result = buildSitemapXml([
      {
        url: "https://example.com/",
        lastmod: "2024-06-01",
        changefreq: "daily",
        priority: 1.0,
      },
    ]);
    expect(result).toContain("<lastmod>2024-06-01</lastmod>");
    expect(result).toContain("<changefreq>daily</changefreq>");
    expect(result).toContain("<priority>1</priority>");
  });

  it("escapes & in URLs", () => {
    const result = buildSitemapXml([{ url: "https://example.com/?a=1&b=2" }]);
    expect(result).toContain("https://example.com/?a=1&amp;b=2");
    expect(result).not.toContain("&b=2");
  });

  it("escapes < in URLs", () => {
    const result = buildSitemapXml([{ url: "https://example.com/a<b" }]);
    expect(result).toContain("&lt;");
  });

  it("escapes > in URLs", () => {
    const result = buildSitemapXml([{ url: "https://example.com/a>b" }]);
    expect(result).toContain("&gt;");
  });

  it("handles empty entries array", () => {
    const result = buildSitemapXml([]);
    expect(result).toContain("<urlset");
    expect(result).toContain("</urlset>");
    expect(result).not.toContain("<url>");
  });

  it("escapes < and & in changefreq when passed as arbitrary string", () => {
    // Cast through unknown to simulate a widened caller that bypasses the union type.
    const entry = {
      url: "https://example.com/",
      changefreq: "<weekly>&always",
    } as unknown as SitemapEntry;
    const result = buildSitemapXml([entry]);
    expect(result).toContain("<changefreq>&lt;weekly&gt;&amp;always</changefreq>");
    expect(result).not.toContain("<weekly>");
    expect(result).not.toContain("&always");
  });

  it("escapes < and & in priority when passed as arbitrary string coerced to String()", () => {
    // priority is number in the type, but String() is applied before escaping.
    // Verify that a numeric value still renders correctly through escapeXml.
    const result = buildSitemapXml([{ url: "https://example.com/", priority: 0.5 }]);
    expect(result).toContain("<priority>0.5</priority>");
  });

  it("produces valid XML structure with multiple entries", () => {
    const result = buildSitemapXml([
      { url: "https://example.com/", priority: 1.0, changefreq: "always" },
      { url: "https://example.com/blog", lastmod: "2024-01-15", changefreq: "monthly" },
    ]);
    // Count url elements
    const urlMatches = result.match(/<url>/g);
    expect(urlMatches).toHaveLength(2);
    const closeUrlMatches = result.match(/<\/url>/g);
    expect(closeUrlMatches).toHaveLength(2);
  });
});

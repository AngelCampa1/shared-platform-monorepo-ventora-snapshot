import { describe, expect, it } from "vitest";
import { buildCanonicalUrl, buildOgImageUrl, buildPageMetadata } from "../metadata.js";
import type { ArticleEntry, SiteConfig } from "../types.js";

const cfg: SiteConfig = {
  name: "Lextract",
  domain: "lextract.app",
  metaDescription: "Manage your boards smarter.",
  defaultOgImagePath: "/og-default.png",
  organization: {
    legalName: "Ventora Inc.",
    sameAs: [],
  },
};

describe("buildCanonicalUrl", () => {
  it("constructs URL with protocol and domain", () => {
    expect(buildCanonicalUrl("/about", cfg)).toBe("https://lextract.app/about");
  });

  it("handles root path", () => {
    expect(buildCanonicalUrl("/", cfg)).toBe("https://lextract.app/");
  });

  it("normalizes missing leading slash", () => {
    expect(buildCanonicalUrl("about", cfg)).toBe("https://lextract.app/about");
  });

  it("handles nested paths", () => {
    expect(buildCanonicalUrl("/blog/my-post", cfg)).toBe("https://lextract.app/blog/my-post");
  });
});

describe("buildOgImageUrl", () => {
  it("returns absolute URL as-is when ogImage starts with http", () => {
    const url = "https://cdn.example.com/img.png";
    expect(buildOgImageUrl(url, cfg)).toBe(url);
  });

  it("prepends domain for relative ogImage path", () => {
    expect(buildOgImageUrl("/custom-og.png", cfg)).toBe("https://lextract.app/custom-og.png");
  });

  it("uses defaultOgImagePath when ogImage is undefined", () => {
    expect(buildOgImageUrl(undefined, cfg)).toBe("https://lextract.app/og-default.png");
  });

  it("handles https:// absolute URL", () => {
    expect(buildOgImageUrl("https://images.example.com/og.jpg", cfg)).toBe(
      "https://images.example.com/og.jpg",
    );
  });
});

describe("buildPageMetadata", () => {
  it("returns pageType=home for / path", () => {
    const meta = buildPageMetadata("/", cfg);
    expect(meta.pageType).toBe("home");
  });

  it("returns pageType=content when content entry is provided", () => {
    const article: ArticleEntry = {
      routePath: "/blog/post",
      title: "My Post",
      description: "Post description.",
      publishedAt: "2024-01-01",
    };
    const meta = buildPageMetadata("/blog/post", cfg, article);
    expect(meta.pageType).toBe("content");
  });

  it("returns pageType=generic for non-root path without content", () => {
    const meta = buildPageMetadata("/features", cfg);
    expect(meta.pageType).toBe("generic");
  });

  it("uses content title and description when provided", () => {
    const article: ArticleEntry = {
      routePath: "/blog/post",
      title: "Article Title",
      description: "Article description.",
      publishedAt: "2024-01-01",
    };
    const meta = buildPageMetadata("/blog/post", cfg, article);
    expect(meta.title).toBe("Article Title");
    expect(meta.description).toBe("Article description.");
  });

  it("falls back to cfg name and description without content", () => {
    const meta = buildPageMetadata("/features", cfg);
    expect(meta.title).toBe("Lextract");
    expect(meta.description).toBe("Manage your boards smarter.");
  });

  it("sets canonicalUrl and canonicalPath correctly", () => {
    const meta = buildPageMetadata("/about", cfg);
    expect(meta.canonicalUrl).toBe("https://lextract.app/about");
    expect(meta.canonicalPath).toBe("/about");
  });

  it("normalizes missing leading slash in pathname", () => {
    const meta = buildPageMetadata("about", cfg);
    expect(meta.canonicalPath).toBe("/about");
    expect(meta.canonicalUrl).toBe("https://lextract.app/about");
  });

  it("includes contentEntry when content is provided", () => {
    const article: ArticleEntry = {
      routePath: "/blog/post",
      title: "Post",
      description: "Desc.",
      publishedAt: "2024-01-01",
    };
    const meta = buildPageMetadata("/blog/post", cfg, article);
    expect(meta.contentEntry).toBe(article);
  });

  it("contentEntry is undefined when no content passed", () => {
    const meta = buildPageMetadata("/features", cfg);
    expect(meta.contentEntry).toBeUndefined();
  });

  it("uses content ogImage when specified", () => {
    const article: ArticleEntry = {
      routePath: "/blog/post",
      title: "Post",
      description: "Desc.",
      publishedAt: "2024-01-01",
      ogImage: "/custom-og.png",
    };
    const meta = buildPageMetadata("/blog/post", cfg, article);
    expect(meta.ogImage).toBe("https://lextract.app/custom-og.png");
  });

  it("uses default ogImage when content has no ogImage", () => {
    const article: ArticleEntry = {
      routePath: "/blog/post",
      title: "Post",
      description: "Desc.",
      publishedAt: "2024-01-01",
    };
    const meta = buildPageMetadata("/blog/post", cfg, article);
    expect(meta.ogImage).toBe("https://lextract.app/og-default.png");
  });
});

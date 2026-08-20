import { describe, expect, it } from "vitest";
import {
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildFaqPageJsonLd,
  buildHowToJsonLd,
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildSoftwareApplicationJsonLd,
  buildWebSiteJsonLd,
  serializeJsonLd,
} from "../schema.js";
import type { ArticleEntry, SiteConfig } from "../types.js";

const cfg: SiteConfig = {
  name: "Lextract",
  domain: "lextract.app",
  metaDescription: "Manage your boards smarter.",
  defaultOgImagePath: "/og-default.png",
  organization: {
    legalName: "Ventora Inc.",
    sameAs: ["https://twitter.com/lextract", "https://github.com/lextract"],
  },
};

describe("buildWebSiteJsonLd", () => {
  it("returns correct @type and @id", () => {
    const result = buildWebSiteJsonLd(cfg);
    expect(result["@type"]).toBe("WebSite");
    expect(result["@id"]).toBe("https://lextract.app/#website");
  });

  it("includes site name and url", () => {
    const result = buildWebSiteJsonLd(cfg);
    expect(result.name).toBe("Lextract");
    expect(result.url).toBe("https://lextract.app/");
  });

  it("references organization by @id", () => {
    const result = buildWebSiteJsonLd(cfg);
    const publisher = result.publisher as Record<string, unknown>;
    expect(publisher["@id"]).toBe("https://lextract.app/#organization");
  });

  it("includes description and language", () => {
    const result = buildWebSiteJsonLd(cfg);
    expect(result.description).toBe("Manage your boards smarter.");
    expect(result.inLanguage).toBe("en");
  });
});

describe("buildOrganizationJsonLd", () => {
  it("returns correct @type", () => {
    const result = buildOrganizationJsonLd(cfg);
    expect(result["@type"]).toBe("Organization");
  });

  it("includes legalName and sameAs", () => {
    const result = buildOrganizationJsonLd(cfg);
    expect(result.name).toBe("Ventora Inc.");
    const sameAs = result.sameAs as string[];
    expect(sameAs).toContain("https://twitter.com/lextract");
    expect(sameAs).toContain("https://github.com/lextract");
  });

  it("has correct @id", () => {
    const result = buildOrganizationJsonLd(cfg);
    expect(result["@id"]).toBe("https://lextract.app/#organization");
  });
});

describe("buildBreadcrumbJsonLd", () => {
  it("returns null for root path", () => {
    expect(buildBreadcrumbJsonLd("/", cfg)).toBeNull();
  });

  it("returns null for empty path after splitting", () => {
    expect(buildBreadcrumbJsonLd("", cfg)).toBeNull();
  });

  it("returns BreadcrumbList for non-root path", () => {
    const result = buildBreadcrumbJsonLd("/blog", cfg);
    expect(result).not.toBeNull();
    expect(result?.["@type"]).toBe("BreadcrumbList");
  });

  it("first item is always Home", () => {
    const result = buildBreadcrumbJsonLd("/blog", cfg);
    const items = result?.itemListElement as Array<Record<string, unknown>>;
    expect(items[0]?.name).toBe("Home");
    expect(items[0]?.position).toBe(1);
  });

  it("capitalizes segment labels", () => {
    const result = buildBreadcrumbJsonLd("/how-to-use", cfg);
    const items = result?.itemListElement as Array<Record<string, unknown>>;
    expect(items[1]?.name).toBe("How To Use");
  });

  it("uses override labels when provided", () => {
    const result = buildBreadcrumbJsonLd("/blog/my-post", cfg, {
      "/blog/my-post": "My Custom Post Title",
    });
    const items = result?.itemListElement as Array<Record<string, unknown>>;
    expect(items[2]?.name).toBe("My Custom Post Title");
  });

  it("builds correct href for nested paths", () => {
    const result = buildBreadcrumbJsonLd("/blog/my-post", cfg);
    const items = result?.itemListElement as Array<Record<string, unknown>>;
    expect(items[1]?.item).toBe("https://lextract.app/blog");
    expect(items[2]?.item).toBe("https://lextract.app/blog/my-post");
  });

  it("position increments correctly for multi-segment path", () => {
    const result = buildBreadcrumbJsonLd("/a/b/c", cfg);
    const items = result?.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    expect(items[3]?.position).toBe(4);
  });
});

describe("buildArticleJsonLd", () => {
  const entry = {
    routePath: "/blog/my-post",
    title: "My Post",
    description: "A great post.",
    publishedAt: "2024-01-01",
    updatedAt: "2024-01-10",
  };

  it("returns Article type", () => {
    const result = buildArticleJsonLd(entry, cfg);
    expect(result["@type"]).toBe("Article");
  });

  it("includes headline and description", () => {
    const result = buildArticleJsonLd(entry, cfg);
    expect(result.headline).toBe("My Post");
    expect(result.description).toBe("A great post.");
  });

  it("uses default og image when none specified", () => {
    const result = buildArticleJsonLd(entry, cfg);
    expect(result.image).toBe("https://lextract.app/og-default.png");
  });

  it("uses custom og image path", () => {
    const result = buildArticleJsonLd({ ...entry, ogImage: "/custom.png" }, cfg);
    expect(result.image).toBe("https://lextract.app/custom.png");
  });

  it("uses absolute og image URL as-is", () => {
    const result = buildArticleJsonLd(
      { ...entry, ogImage: "https://cdn.example.com/img.png" },
      cfg,
    );
    expect(result.image).toBe("https://cdn.example.com/img.png");
  });

  it("includes datePublished and dateModified", () => {
    const result = buildArticleJsonLd(entry, cfg);
    expect(result.datePublished).toBe("2024-01-01");
    expect(result.dateModified).toBe("2024-01-10");
  });

  it("omits dateModified when updatedAt is undefined", () => {
    const entryNoUpdated: ArticleEntry = {
      routePath: entry.routePath,
      title: entry.title,
      description: entry.description,
      publishedAt: entry.publishedAt,
    };
    const result = buildArticleJsonLd(entryNoUpdated, cfg);
    expect("dateModified" in result).toBe(false);
  });

  it("normalizes routePath without leading slash", () => {
    const result = buildArticleJsonLd({ ...entry, routePath: "blog/my-post" }, cfg);
    const page = result.mainEntityOfPage as Record<string, unknown>;
    expect(page["@id"]).toBe("https://lextract.app/blog/my-post");
  });
});

describe("buildFaqPageJsonLd", () => {
  it("returns null for empty array", () => {
    expect(buildFaqPageJsonLd([])).toBeNull();
  });

  it("returns FAQPage type for non-empty array", () => {
    const result = buildFaqPageJsonLd([{ q: "What?", a: "This." }]);
    expect(result?.["@type"]).toBe("FAQPage");
  });

  it("maps questions and answers correctly", () => {
    const result = buildFaqPageJsonLd([
      { q: "How does it work?", a: "Very well." },
      { q: "Is it free?", a: "Yes." },
    ]);
    const mainEntity = result?.mainEntity as Array<Record<string, unknown>>;
    expect(mainEntity).toHaveLength(2);
    expect(mainEntity[0]?.name).toBe("How does it work?");
    const answer = mainEntity[0]?.acceptedAnswer as Record<string, unknown>;
    expect(answer.text).toBe("Very well.");
  });
});

describe("buildProductJsonLd", () => {
  it("returns Product type", () => {
    const result = buildProductJsonLd(
      { name: "Pro Plan", description: "The best.", url: "https://lextract.app/pro" },
      cfg,
    );
    expect(result["@type"]).toBe("Product");
  });

  it("includes name, description, url", () => {
    const result = buildProductJsonLd(
      { name: "Pro Plan", description: "The best.", url: "https://lextract.app/pro" },
      cfg,
    );
    expect(result.name).toBe("Pro Plan");
    expect(result.url).toBe("https://lextract.app/pro");
  });

  it("includes image when provided", () => {
    const result = buildProductJsonLd(
      {
        name: "Pro Plan",
        description: "Best",
        url: "https://lextract.app/pro",
        image: "/pro.png",
      },
      cfg,
    );
    expect(result.image).toBe("/pro.png");
  });

  it("omits image when not provided", () => {
    const result = buildProductJsonLd(
      { name: "Pro Plan", description: "Best", url: "https://lextract.app/pro" },
      cfg,
    );
    expect("image" in result).toBe(false);
  });

  it("includes offers when provided", () => {
    const result = buildProductJsonLd(
      {
        name: "Pro Plan",
        description: "Best",
        url: "https://lextract.app/pro",
        offers: { price: "9.99", priceCurrency: "USD", priceValidUntil: "2025-12-31" },
      },
      cfg,
    );
    const offers = result.offers as Record<string, unknown>;
    expect(offers.price).toBe("9.99");
    expect(offers.priceCurrency).toBe("USD");
    expect(offers.priceValidUntil).toBe("2025-12-31");
  });

  it("includes offers without priceValidUntil", () => {
    const result = buildProductJsonLd(
      {
        name: "Pro Plan",
        description: "Best",
        url: "https://lextract.app/pro",
        offers: { price: "0", priceCurrency: "USD" },
      },
      cfg,
    );
    const offers = result.offers as Record<string, unknown>;
    expect("priceValidUntil" in offers).toBe(false);
  });

  it("includes aggregateRating when provided", () => {
    const result = buildProductJsonLd(
      {
        name: "Pro Plan",
        description: "Best",
        url: "https://lextract.app/pro",
        aggregateRating: { ratingValue: 4.8, reviewCount: 200 },
      },
      cfg,
    );
    const rating = result.aggregateRating as Record<string, unknown>;
    expect(rating.ratingValue).toBe(4.8);
    expect(rating.reviewCount).toBe(200);
  });
});

describe("buildSoftwareApplicationJsonLd", () => {
  it("returns SoftwareApplication type", () => {
    const result = buildSoftwareApplicationJsonLd(
      { name: "Lextract App", description: "An app.", url: "https://lextract.app" },
      cfg,
    );
    expect(result["@type"]).toBe("SoftwareApplication");
  });

  it("includes optional fields when provided", () => {
    const result = buildSoftwareApplicationJsonLd(
      {
        name: "Lextract App",
        description: "An app.",
        url: "https://lextract.app",
        operatingSystem: "Web",
        applicationCategory: "BusinessApplication",
        offers: { price: "0", priceCurrency: "USD" },
      },
      cfg,
    );
    expect(result.operatingSystem).toBe("Web");
    expect(result.applicationCategory).toBe("BusinessApplication");
    const offers = result.offers as Record<string, unknown>;
    expect(offers.price).toBe("0");
  });

  it("omits optional fields when not provided", () => {
    const result = buildSoftwareApplicationJsonLd(
      { name: "App", description: "Desc", url: "https://lextract.app" },
      cfg,
    );
    expect("operatingSystem" in result).toBe(false);
    expect("applicationCategory" in result).toBe(false);
    expect("offers" in result).toBe(false);
  });
});

describe("buildHowToJsonLd", () => {
  it("returns HowTo type", () => {
    const result = buildHowToJsonLd(
      { name: "How to use Lextract", steps: [{ name: "Step 1", text: "Do this." }] },
      cfg,
    );
    expect(result["@type"]).toBe("HowTo");
  });

  it("maps steps correctly", () => {
    const result = buildHowToJsonLd(
      {
        name: "How to use Lextract",
        steps: [
          { name: "Step 1", text: "Do this.", url: "https://lextract.app/step1" },
          { name: "Step 2", text: "Then this." },
        ],
      },
      cfg,
    );
    const steps = result.step as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]?.name).toBe("Step 1");
    expect(steps[0]?.url).toBe("https://lextract.app/step1");
    expect("url" in (steps[1] as Record<string, unknown>)).toBe(false);
  });

  it("includes description and totalTime when provided", () => {
    const result = buildHowToJsonLd(
      {
        name: "Setup",
        description: "How to set up.",
        steps: [{ name: "Step 1", text: "Go." }],
        totalTime: "PT30M",
      },
      cfg,
    );
    expect(result.description).toBe("How to set up.");
    expect(result.totalTime).toBe("PT30M");
  });

  it("omits description and totalTime when not provided", () => {
    const result = buildHowToJsonLd(
      { name: "Setup", steps: [{ name: "Step 1", text: "Go." }] },
      cfg,
    );
    expect("description" in result).toBe(false);
    expect("totalTime" in result).toBe(false);
  });
});

describe("serializeJsonLd", () => {
  it("serializes a single object", () => {
    const result = serializeJsonLd({ "@type": "WebSite", name: "Test" });
    expect(result).toBe('{"@type":"WebSite","name":"Test"}');
  });

  it("serializes an array", () => {
    const result = serializeJsonLd([{ "@type": "WebSite" }, { "@type": "Organization" }]);
    expect(result).toContain('"@type":"WebSite"');
    expect(result).toContain('"@type":"Organization"');
  });

  it("escapes < as \\u003c to prevent XSS", () => {
    const result = serializeJsonLd({ text: "<script>alert(1)</script>" });
    expect(result).not.toContain("<script>");
    expect(result).toContain("\\u003cscript>");
  });

  it("does not escape other HTML characters", () => {
    const result = serializeJsonLd({ text: "a > b & c" });
    expect(result).toContain("a > b & c");
  });
});

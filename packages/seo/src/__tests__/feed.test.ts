import { describe, expect, it } from "vitest";
import { buildAtomFeed, buildJsonFeed } from "../feed.js";
import type { FeedItem, SiteConfig } from "../types.js";

const cfg: SiteConfig = {
  name: "Lextract",
  domain: "lextract.app",
  metaDescription: "Manage your boards smarter.",
  defaultOgImagePath: "/og-default.png",
  organization: {
    legalName: "Ventora Inc.",
    sameAs: [],
  },
  feed: {
    title: "Lextract Blog",
    description: "Latest updates from Lextract.",
  },
};

const cfgNoFeed: SiteConfig = {
  name: "Lextract",
  domain: "lextract.app",
  metaDescription: "Default description.",
  defaultOgImagePath: "/og.png",
  organization: { legalName: "Ventora Inc.", sameAs: [] },
};

const item1: FeedItem = {
  id: "https://lextract.app/blog/post-1",
  title: "First Post",
  url: "https://lextract.app/blog/post-1",
  content: "<p>Hello world</p>",
  summary: "A brief intro.",
  publishedAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-05T00:00:00Z",
  author: { name: "Angel Campa", url: "https://lextract.app/about" },
  tags: ["intro", "news"],
};

const item2: FeedItem = {
  id: "https://lextract.app/blog/post-2",
  title: "Second Post",
  url: "https://lextract.app/blog/post-2",
  content: "<p>Second post content</p>",
  publishedAt: "2024-02-01T00:00:00Z",
};

function getFirstJsonFeedItem(result: ReturnType<typeof buildJsonFeed>) {
  const feedItem = result.items[0];
  expect(feedItem).toBeDefined();
  if (feedItem === undefined) {
    throw new Error("Expected JSON feed to contain an item");
  }
  return feedItem;
}

describe("buildAtomFeed", () => {
  it("includes XML declaration", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("includes Atom namespace", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain('xmlns="http://www.w3.org/2005/Atom"');
  });

  it("uses feed.title from cfg when available", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<title>Lextract Blog</title>");
  });

  it("falls back to cfg.name when feed.title is absent", () => {
    const result = buildAtomFeed([item1], cfgNoFeed);
    expect(result).toContain("<title>Lextract</title>");
  });

  it("uses feed.description from cfg when available", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<subtitle>Latest updates from Lextract.</subtitle>");
  });

  it("falls back to cfg.metaDescription when feed.description is absent", () => {
    const result = buildAtomFeed([item1], cfgNoFeed);
    expect(result).toContain("<subtitle>Default description.</subtitle>");
  });

  it("includes entry id", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain(`<id>${item1.id}</id>`);
  });

  it("includes entry title", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<title>First Post</title>");
  });

  it("includes published and updated dates", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain(`<published>${item1.publishedAt}</published>`);
    expect(result).toContain(`<updated>${item1.updatedAt}</updated>`);
  });

  it("uses publishedAt as updated when updatedAt is not set", () => {
    const result = buildAtomFeed([item2], cfg);
    expect(result).toContain(`<updated>${item2.publishedAt}</updated>`);
  });

  it("includes author block when provided", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<author>");
    expect(result).toContain("<name>Angel Campa</name>");
    expect(result).toContain("<uri>https://lextract.app/about</uri>");
  });

  it("omits author block when not provided", () => {
    const result = buildAtomFeed([item2], cfg);
    expect(result).not.toContain("<author>");
  });

  it("includes author without url", () => {
    const itemWithAuthorNoUrl: FeedItem = {
      ...item1,
      author: { name: "No URL Author" },
    };
    const result = buildAtomFeed([itemWithAuthorNoUrl], cfg);
    expect(result).toContain("<name>No URL Author</name>");
    expect(result).not.toContain("<uri>");
  });

  it("includes summary when provided", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<summary>A brief intro.</summary>");
  });

  it("omits summary when not provided", () => {
    const result = buildAtomFeed([item2], cfg);
    expect(result).not.toContain("<summary>");
  });

  it("includes content in CDATA", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain("<![CDATA[<p>Hello world</p>]]>");
  });

  it("splits embedded CDATA terminators in content", () => {
    const result = buildAtomFeed([{ ...item1, content: "<p>before ]]> after</p>" }], cfg);
    expect(result).toContain("<![CDATA[<p>before ]]]]><![CDATA[> after</p>]]>");
    expect(result).not.toContain("<![CDATA[<p>before ]]> after</p>]]>");
  });

  it("includes category tags when provided", () => {
    const result = buildAtomFeed([item1], cfg);
    expect(result).toContain('<category term="intro"/>');
    expect(result).toContain('<category term="news"/>');
  });

  it("omits category when no tags", () => {
    const result = buildAtomFeed([item2], cfg);
    expect(result).not.toContain("<category");
  });

  it("escapes & in titles", () => {
    const specialItem: FeedItem = {
      ...item2,
      title: "Rocks & Roles",
    };
    const result = buildAtomFeed([specialItem], cfg);
    expect(result).toContain("Rocks &amp; Roles");
  });

  it("handles empty items array", () => {
    const result = buildAtomFeed([], cfg);
    expect(result).toContain("<feed");
    expect(result).not.toContain("<entry>");
  });

  it("sets feed-level updated to most recent item date", () => {
    const result = buildAtomFeed([item1, item2], cfg);
    // item1 has updatedAt 2024-01-05, item2 publishedAt 2024-02-01 — item2 is more recent
    expect(result).toContain("<updated>2024-02-01T00:00:00Z</updated>");
  });
});

describe("buildJsonFeed", () => {
  it("sets version to JSON Feed 1.1", () => {
    const result = buildJsonFeed([item1], cfg);
    expect(result.version).toBe("https://jsonfeed.org/version/1.1");
  });

  it("uses feed.title from cfg when available", () => {
    const result = buildJsonFeed([item1], cfg);
    expect(result.title).toBe("Lextract Blog");
  });

  it("falls back to cfg.name when feed.title absent", () => {
    const result = buildJsonFeed([item1], cfgNoFeed);
    expect(result.title).toBe("Lextract");
  });

  it("sets home_page_url correctly", () => {
    const result = buildJsonFeed([item1], cfg);
    expect(result.home_page_url).toBe("https://lextract.app/");
  });

  it("sets feed_url correctly", () => {
    const result = buildJsonFeed([item1], cfg);
    expect(result.feed_url).toBe("https://lextract.app/feed.json");
  });

  it("sets description from feed config", () => {
    const result = buildJsonFeed([item1], cfg);
    expect(result.description).toBe("Latest updates from Lextract.");
  });

  it("maps id, url, title, content_html", () => {
    const result = buildJsonFeed([item1], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.id).toBe(item1.id);
    expect(feedItem.url).toBe(item1.url);
    expect(feedItem.title).toBe(item1.title);
    expect(feedItem.content_html).toBe(item1.content);
  });

  it("maps date_published and date_modified", () => {
    const result = buildJsonFeed([item1], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.date_published).toBe(item1.publishedAt);
    expect(feedItem.date_modified).toBe(item1.updatedAt);
  });

  it("omits date_modified when updatedAt is undefined", () => {
    const result = buildJsonFeed([item2], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect("date_modified" in feedItem).toBe(false);
  });

  it("maps authors when author is provided", () => {
    const result = buildJsonFeed([item1], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.authors).toHaveLength(1);
    expect(feedItem.authors?.[0]?.name).toBe("Angel Campa");
    expect(feedItem.authors?.[0]?.url).toBe("https://lextract.app/about");
  });

  it("maps author without url", () => {
    const itemWithAuthorNoUrl: FeedItem = {
      ...item1,
      author: { name: "No URL" },
    };
    const result = buildJsonFeed([itemWithAuthorNoUrl], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.authors?.[0]?.name).toBe("No URL");
    const author = feedItem.authors?.[0];
    expect(author).toBeDefined();
    if (author === undefined) {
      throw new Error("Expected JSON feed item to contain an author");
    }
    expect("url" in author).toBe(false);
  });

  it("omits authors when no author provided", () => {
    const result = buildJsonFeed([item2], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect("authors" in feedItem).toBe(false);
  });

  it("maps tags when provided", () => {
    const result = buildJsonFeed([item1], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.tags).toEqual(["intro", "news"]);
  });

  it("omits tags when not provided", () => {
    const result = buildJsonFeed([item2], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect("tags" in feedItem).toBe(false);
  });

  it("maps summary when provided", () => {
    const result = buildJsonFeed([item1], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect(feedItem.summary).toBe("A brief intro.");
  });

  it("omits summary when not provided", () => {
    const result = buildJsonFeed([item2], cfg);
    const feedItem = getFirstJsonFeedItem(result);
    expect("summary" in feedItem).toBe(false);
  });

  it("handles empty items array", () => {
    const result = buildJsonFeed([], cfg);
    expect(result.items).toHaveLength(0);
  });
});

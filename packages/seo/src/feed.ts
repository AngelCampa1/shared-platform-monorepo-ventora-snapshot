import type { FeedItem, JsonFeed, SiteConfig } from "./types.js";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(value: string): string {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

export function buildAtomFeed(items: FeedItem[], cfg: SiteConfig): string {
  const base = `https://${cfg.domain}`;
  const feedTitle = cfg.feed?.title ?? cfg.name;
  const feedDescription = cfg.feed?.description ?? cfg.metaDescription;

  const mostRecentUpdated =
    items.length > 0
      ? (items
          .map((i) => i.updatedAt ?? i.publishedAt)
          .sort()
          .reverse()[0] ?? new Date().toISOString())
      : new Date().toISOString();

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(feedTitle)}</title>`,
    `  <subtitle>${escapeXml(feedDescription)}</subtitle>`,
    `  <link href="${escapeXml(base)}/" rel="alternate" type="text/html"/>`,
    `  <link href="${escapeXml(`${base}/feed.atom`)}" rel="self" type="application/atom+xml"/>`,
    `  <id>${escapeXml(base)}/</id>`,
    `  <updated>${mostRecentUpdated}</updated>`,
    "  <generator>@ventora/seo</generator>",
  ];

  for (const item of items) {
    lines.push("  <entry>");
    lines.push(`    <id>${escapeXml(item.id)}</id>`);
    lines.push(`    <title>${escapeXml(item.title)}</title>`);
    lines.push(`    <link href="${escapeXml(item.url)}" rel="alternate"/>`);
    lines.push(`    <published>${item.publishedAt}</published>`);
    lines.push(`    <updated>${item.updatedAt ?? item.publishedAt}</updated>`);

    if (item.author !== undefined) {
      lines.push("    <author>");
      lines.push(`      <name>${escapeXml(item.author.name)}</name>`);
      if (item.author.url !== undefined) {
        lines.push(`      <uri>${escapeXml(item.author.url)}</uri>`);
      }
      lines.push("    </author>");
    }

    if (item.summary !== undefined) {
      lines.push(`    <summary>${escapeXml(item.summary)}</summary>`);
    }

    lines.push(`    <content type="html"><![CDATA[${cdata(item.content)}]]></content>`);

    if (item.tags !== undefined) {
      for (const tag of item.tags) {
        lines.push(`    <category term="${escapeXml(tag)}"/>`);
      }
    }

    lines.push("  </entry>");
  }

  lines.push("</feed>");

  return lines.join("\n");
}

export function buildJsonFeed(items: FeedItem[], cfg: SiteConfig): JsonFeed {
  const base = `https://${cfg.domain}`;
  const feedTitle = cfg.feed?.title ?? cfg.name;
  const feedDescription = cfg.feed?.description ?? cfg.metaDescription;

  return {
    version: "https://jsonfeed.org/version/1.1",
    title: feedTitle,
    home_page_url: `${base}/`,
    feed_url: `${base}/feed.json`,
    description: feedDescription,
    items: items.map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      content_html: item.content,
      ...(item.summary !== undefined ? { summary: item.summary } : {}),
      date_published: item.publishedAt,
      ...(item.updatedAt !== undefined ? { date_modified: item.updatedAt } : {}),
      ...(item.author !== undefined
        ? {
            authors: [
              {
                name: item.author.name,
                ...(item.author.url !== undefined ? { url: item.author.url } : {}),
              },
            ],
          }
        : {}),
      ...(item.tags !== undefined ? { tags: item.tags } : {}),
    })),
  };
}

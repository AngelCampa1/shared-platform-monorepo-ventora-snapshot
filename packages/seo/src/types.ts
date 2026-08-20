export type JsonLdValue = string | number | boolean | null | JsonLdObject | JsonLdValue[];
export type JsonLdObject = { [key: string]: JsonLdValue };

export type SiteConfig = {
  name: string;
  domain: string; // e.g. "lextract.app" — no protocol
  metaDescription: string;
  defaultOgImagePath: string; // e.g. "/og-default.png"
  organization: {
    legalName: string;
    sameAs: string[];
  };
  funnel?: {
    stages: string[];
    collections: string[];
    silos?: string[];
  };
  llms?: {
    productDescription: string;
    keyFeatures: string[];
    targetAudience: string;
  };
  indexNow?: {
    keyLocation: string; // path like "/<key>.txt"
  };
  feed?: {
    title: string;
    description: string;
  };
};

export type ArticleEntry = {
  routePath: string;
  title: string;
  description: string;
  ogImage?: string;
  publishedAt: string; // ISO date string
  updatedAt?: string;
  faqs?: readonly { q: string; a: string }[];
};

export type ProductEntry = {
  name: string;
  description: string;
  url: string;
  image?: string;
  offers?: { price: string; priceCurrency: string; priceValidUntil?: string };
  aggregateRating?: { ratingValue: number; reviewCount: number };
};

export type AppEntry = {
  name: string;
  description: string;
  url: string;
  operatingSystem?: string;
  applicationCategory?: string;
  offers?: { price: string; priceCurrency: string };
};

export type HowToEntry = {
  name: string;
  description?: string;
  steps: { name: string; text: string; url?: string }[];
  totalTime?: string; // ISO 8601 duration e.g. "PT30M"
};

export type SiteRoute = {
  path: string;
  title: string;
  collection?: string;
  relatedPaths?: string[];
  funnelStage?: string;
  silo?: string;
  isLandingPage?: boolean;
};

export type InternalLinkGraph = {
  nodes: Map<string, SiteRoute>;
  edges: Map<string, Set<string>>; // path → set of linked paths
};

export type RelatedEntries = {
  silo: SiteRoute[];
  funnel: SiteRoute[];
  collection: SiteRoute[];
};

export type SitemapEntry = {
  url: string;
  lastmod?: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
};

export type LlmsTxtSection = {
  heading: string;
  items: { title: string; url: string; description?: string }[];
};

export type FeedItem = {
  id: string;
  title: string;
  url: string;
  content: string;
  summary?: string;
  publishedAt: string;
  updatedAt?: string;
  author?: { name: string; url?: string };
  tags?: string[];
};

export type JsonFeed = {
  version: string;
  title: string;
  home_page_url: string;
  feed_url: string;
  description?: string;
  items: JsonFeedItem[];
};

type JsonFeedItem = {
  id: string;
  url: string;
  title: string;
  content_html: string;
  summary?: string;
  date_published: string;
  date_modified?: string;
  authors?: { name: string; url?: string }[];
  tags?: string[];
};

export type ResolvedPageMeta = {
  canonicalUrl: string;
  canonicalPath: string;
  title: string;
  description: string;
  ogImage: string;
  pageType: "home" | "content" | "collection" | "generic";
  contentEntry?: ArticleEntry;
};

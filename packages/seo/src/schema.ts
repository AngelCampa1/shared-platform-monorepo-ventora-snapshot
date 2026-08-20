import type {
  AppEntry,
  ArticleEntry,
  HowToEntry,
  JsonLdObject,
  ProductEntry,
  SiteConfig,
} from "./types.js";

function siteUrl(cfg: SiteConfig): string {
  return `https://${cfg.domain}`;
}

export function buildWebSiteJsonLd(cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${base}/#website`,
    name: cfg.name,
    url: `${base}/`,
    description: cfg.metaDescription,
    inLanguage: "en",
    publisher: { "@id": `${base}/#organization` },
  };
}

export function buildOrganizationJsonLd(cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${base}/#organization`,
    name: cfg.organization.legalName,
    url: `${base}/`,
    logo: `${base}/logo-mark.png`,
    sameAs: [...cfg.organization.sameAs],
  };
}

export function buildBreadcrumbJsonLd(
  pathname: string,
  cfg: SiteConfig,
  overrides?: Record<string, string>,
): JsonLdObject | null {
  const base = siteUrl(cfg);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const items = [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: `${base}/`,
    },
    ...segments.map((segment, index) => {
      const segPath = `/${segments.slice(0, index + 1).join("/")}`;
      const href = `${base}${segPath}`;
      const label =
        overrides?.[segPath] ??
        segment.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());

      return {
        "@type": "ListItem",
        position: index + 2,
        name: label,
        item: href,
      };
    }),
  ];

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  };
}

export function buildArticleJsonLd(entry: ArticleEntry, cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  const url = `${base}${entry.routePath.startsWith("/") ? entry.routePath : `/${entry.routePath}`}`;

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    headline: entry.title,
    description: entry.description,
    image: entry.ogImage
      ? entry.ogImage.startsWith("http")
        ? entry.ogImage
        : `${base}${entry.ogImage}`
      : `${base}${cfg.defaultOgImagePath}`,
    datePublished: entry.publishedAt,
    ...(entry.updatedAt !== undefined ? { dateModified: entry.updatedAt } : {}),
    inLanguage: "en",
    author: { "@type": "Organization", name: cfg.name, url: `${base}/` },
    publisher: { "@id": `${base}/#organization` },
  };
}

export function buildFaqPageJsonLd(faqs: readonly { q: string; a: string }[]): JsonLdObject | null {
  if (!faqs || faqs.length === 0) {
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };
}

export function buildProductJsonLd(product: ProductEntry, cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  const result: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description,
    url: product.url,
    brand: { "@type": "Organization", "@id": `${base}/#organization` },
  };

  if (product.image !== undefined) {
    result.image = product.image;
  }

  if (product.offers !== undefined) {
    const offer: JsonLdObject = {
      "@type": "Offer",
      price: product.offers.price,
      priceCurrency: product.offers.priceCurrency,
    };
    if (product.offers.priceValidUntil !== undefined) {
      offer.priceValidUntil = product.offers.priceValidUntil;
    }
    result.offers = offer;
  }

  if (product.aggregateRating !== undefined) {
    result.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: product.aggregateRating.ratingValue,
      reviewCount: product.aggregateRating.reviewCount,
    };
  }

  return result;
}

export function buildSoftwareApplicationJsonLd(app: AppEntry, cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  const result: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    description: app.description,
    url: app.url,
    publisher: { "@id": `${base}/#organization` },
  };

  if (app.operatingSystem !== undefined) {
    result.operatingSystem = app.operatingSystem;
  }

  if (app.applicationCategory !== undefined) {
    result.applicationCategory = app.applicationCategory;
  }

  if (app.offers !== undefined) {
    result.offers = {
      "@type": "Offer",
      price: app.offers.price,
      priceCurrency: app.offers.priceCurrency,
    };
  }

  return result;
}

export function buildHowToJsonLd(howto: HowToEntry, cfg: SiteConfig): JsonLdObject {
  const base = siteUrl(cfg);
  const result: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: howto.name,
    publisher: { "@id": `${base}/#organization` },
    step: howto.steps.map((step) => {
      const stepObj: JsonLdObject = {
        "@type": "HowToStep",
        name: step.name,
        text: step.text,
      };
      if (step.url !== undefined) {
        stepObj.url = step.url;
      }
      return stepObj;
    }),
  };

  if (howto.description !== undefined) {
    result.description = howto.description;
  }

  if (howto.totalTime !== undefined) {
    result.totalTime = howto.totalTime;
  }

  return result;
}

export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

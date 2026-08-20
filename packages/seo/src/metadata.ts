import type { ArticleEntry, ResolvedPageMeta, SiteConfig } from "./types.js";

export function buildCanonicalUrl(pathname: string, cfg: SiteConfig): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `https://${cfg.domain}${normalizedPath}`;
}

export function buildOgImageUrl(ogImage: string | undefined, cfg: SiteConfig): string {
  if (ogImage?.startsWith("http")) {
    return ogImage;
  }
  return `https://${cfg.domain}${ogImage ?? cfg.defaultOgImagePath}`;
}

export function buildPageMetadata(
  pathname: string,
  cfg: SiteConfig,
  content?: ArticleEntry,
): ResolvedPageMeta {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const canonicalUrl = buildCanonicalUrl(normalizedPath, cfg);

  let pageType: ResolvedPageMeta["pageType"];
  if (normalizedPath === "/") {
    pageType = "home";
  } else if (content !== undefined) {
    pageType = "content";
  } else {
    pageType = "generic";
  }

  const base: Omit<ResolvedPageMeta, "contentEntry"> = {
    canonicalUrl,
    canonicalPath: normalizedPath,
    title: content?.title ?? cfg.name,
    description: content?.description ?? cfg.metaDescription,
    ogImage: buildOgImageUrl(content?.ogImage, cfg),
    pageType,
  };

  if (content !== undefined) {
    return { ...base, contentEntry: content };
  }

  return base;
}

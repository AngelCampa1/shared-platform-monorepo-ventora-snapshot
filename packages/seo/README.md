# @ventora/seo

JSON-LD builders, page metadata, sitemaps, Atom/JSON feeds, an `llms.txt` builder, internal-link-graph tools, and IndexNow submission, all driven by one `SiteConfig`.

## Install

```bash
pnpm add @ventora/seo
```

## Usage

```ts
import { buildPageMetadata, buildWebSiteJsonLd, serializeJsonLd, type SiteConfig } from "@ventora/seo";

const site: SiteConfig = {
  name: "GrantPipe",
  domain: "grantpipe.com",
  metaDescription: "Grant tracking for nonprofits.",
  defaultOgImagePath: "/og-default.png",
  organization: { legalName: "Ventora Labs", sameAs: [] },
};

const meta = buildPageMetadata("/pricing", site);
const jsonLd = serializeJsonLd(buildWebSiteJsonLd(site));
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | Everything below, plus `buildLlmsTxt`, `buildInternalLinkGraph`, `detectOrphans`, `resolveFunnelAwareRelatedEntries` |
| `./schema` | `buildWebSiteJsonLd`, `buildOrganizationJsonLd`, `buildBreadcrumbJsonLd`, `buildArticleJsonLd`, `buildFaqPageJsonLd`, `buildProductJsonLd`, `buildSoftwareApplicationJsonLd`, `buildHowToJsonLd`, `serializeJsonLd` |
| `./metadata` | `buildCanonicalUrl`, `buildOgImageUrl`, `buildPageMetadata` |
| `./sitemap` | `buildSitemapXml` |
| `./feed` | `buildAtomFeed`, `buildJsonFeed` |
| `./indexnow` | `submitToIndexNow` |

## Notes

- `buildLlmsTxt`, `buildInternalLinkGraph`, `detectOrphans`, and `resolveFunnelAwareRelatedEntries` are only available from the `.` entry point. There is no dedicated subpath for them.
- Every builder takes the same `SiteConfig` object, so a product configures its domain, org, and default OG image once and reuses it across JSON-LD, metadata, sitemap, and feed calls.

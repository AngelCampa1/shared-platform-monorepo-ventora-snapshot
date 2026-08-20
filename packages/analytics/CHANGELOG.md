# @ventora/analytics

## 1.0.0

### Major Changes

- 30b9f98: Remove retired product IDs, origins, analytics products, and hosted widget brand presets from shared platform packages. This intentionally narrows product-id contracts for retired products.

## 0.2.1

### Patch Changes

- d79586a: Align server-side property redaction with the Python `ventora_analytics` mirror. `sanitizeProperties` now drops keys containing `password`, `token`, `secret`, or `credential`, or ending in `key` or `auth` — previously `credential` and `auth` keys (e.g. `api_credential`, `x_auth`) were forwarded to PostHog from the TypeScript path while being scrubbed in Python. Both language implementations now apply the identical rule.

## 0.2.0

### Minor Changes

- 5c0a643: Initial release of all ventora-platform packages. Provides shared observability, analytics, SEO, email, storage, API client, auth, and billing utilities for all Ventora products.

### Patch Changes

- 9171f94: Tighten cutoff readiness gates: package export type resolution, per-file coverage thresholds, storage signed URL typing, API retry normalization, and billing peer resolution.
- 3c1c1b2: Fix repository quality gates by aligning generated analytics output with formatter rules, preserving no-body API requests without a JSON content type, and removing lint-only test assertions from SEO helpers.

# @ventora/api-client

## 0.2.2

### Patch Changes

- Updated dependencies [387c5eb]
  - @ventora/observability@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @ventora/observability@0.2.1

## 0.2.0

### Minor Changes

- 5c0a643: Initial release of all ventora-platform packages. Provides shared observability, analytics, SEO, email, storage, API client, auth, and billing utilities for all Ventora products.

### Patch Changes

- 9171f94: Tighten cutoff readiness gates: package export type resolution, per-file coverage thresholds, storage signed URL typing, API retry normalization, and billing peer resolution.
- 3c1c1b2: Fix repository quality gates by aligning generated analytics output with formatter rules, preserving no-body API requests without a JSON content type, and removing lint-only test assertions from SEO helpers.
- b1c6f40: Multi-agent review sweep — bug fixes across packages:
  - `@ventora/auth-better`: `requireRole` now throws `AuthRequiredError` (not `ForbiddenRoleError`) when the session has no active organization/member, matching the semantics of `requireOrg`. `ForbiddenRoleError` is reserved for actual role-mismatch.
  - `@ventora/api-client`: `uploadFile` progress callback no longer divides by zero when `event.total === 0` (would previously emit `Infinity` as a percent).
  - `@ventora/email-renderer`: `verifyHmac` now strictly validates input is 64 hex chars (rejecting odd-length hex strings and non-hex characters) before attempting signature verification.
  - `@ventora/seo`: `buildSitemapXml` now XML-escapes `changefreq` and `priority` values defensively.

- Updated dependencies [9171f94]
- Updated dependencies [5c0a643]
  - @ventora/observability@0.2.0

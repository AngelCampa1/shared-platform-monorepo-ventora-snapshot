# @ventora/storage

## 0.2.2

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.
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
- Updated dependencies [9171f94]
- Updated dependencies [5c0a643]
  - @ventora/observability@0.2.0

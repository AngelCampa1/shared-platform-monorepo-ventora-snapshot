# @ventora/billing

## 1.0.0

### Major Changes

- 30b9f98: Remove retired product IDs, origins, analytics products, and hosted widget brand presets from shared platform packages. This intentionally narrows product-id contracts for retired products.

## 0.2.2

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.2.1

### Patch Changes

- 15658c9: Finish incomplete public surfaces: make advanced auth descriptors validate and fail closed for unsupported security controls instead of resolving unsafe no-op Better Auth plugins, and make billing mock mode exercise checkout and webhook flows.

## 0.2.0

### Minor Changes

- 5c0a643: Initial release of all ventora-platform packages. Provides shared observability, analytics, SEO, email, storage, API client, auth, and billing utilities for all Ventora products.

### Patch Changes

- 9171f94: Tighten cutoff readiness gates: package export type resolution, per-file coverage thresholds, storage signed URL typing, API retry normalization, and billing peer resolution.

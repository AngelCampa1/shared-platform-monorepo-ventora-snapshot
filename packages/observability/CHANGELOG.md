# @ventora/observability

## 0.2.2

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.2.1

### Patch Changes

- Fix optional peer dependencies being eagerly imported, which crashed consumers on import.
  - `@ventora/observability`: the main entry transitively imported `@sentry/cloudflare` (an optional peer) at module top level via the capture helpers. The runtime Sentry calls now come from `@sentry/core` (a regular dependency), so `@sentry/cloudflare` and `@sentry/node` are genuinely optional again. Behavior is unchanged for existing consumers; the capture API stays synchronous. This also unbreaks `@ventora/storage`, which re-exports observability's error types.
  - `@ventora/email`: `resend` is now loaded lazily on first send instead of at module load, so importing the package for the unsubscribe-token or CAN-SPAM helpers no longer requires `resend` to be installed. `createEmailClient` stays synchronous.
  - `@ventora/auth-better`: `better-auth` is now a required (non-optional) peer dependency. `createAuth` is synchronous and cannot function without it, so marking it optional was misleading and silenced npm's missing-peer warning. The `./helpers` and `./advanced` subpaths remain usable without `better-auth`.

## 0.2.0

### Minor Changes

- 5c0a643: Initial release of all ventora-platform packages. Provides shared observability, analytics, SEO, email, storage, API client, auth, and billing utilities for all Ventora products.

### Patch Changes

- 9171f94: Tighten cutoff readiness gates: package export type resolution, per-file coverage thresholds, storage signed URL typing, API retry normalization, and billing peer resolution.

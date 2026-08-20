# @ventora/email

## 0.2.3

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.2.2

### Patch Changes

- Fix optional peer dependencies being eagerly imported, which crashed consumers on import.
  - `@ventora/observability`: the main entry transitively imported `@sentry/cloudflare` (an optional peer) at module top level via the capture helpers. The runtime Sentry calls now come from `@sentry/core` (a regular dependency), so `@sentry/cloudflare` and `@sentry/node` are genuinely optional again. Behavior is unchanged for existing consumers; the capture API stays synchronous. This also unbreaks `@ventora/storage`, which re-exports observability's error types.
  - `@ventora/email`: `resend` is now loaded lazily on first send instead of at module load, so importing the package for the unsubscribe-token or CAN-SPAM helpers no longer requires `resend` to be installed. `createEmailClient` stays synchronous.
  - `@ventora/auth-better`: `better-auth` is now a required (non-optional) peer dependency. `createAuth` is synchronous and cannot function without it, so marking it optional was misleading and silenced npm's missing-peer warning. The `./helpers` and `./advanced` subpaths remain usable without `better-auth`.

## 0.2.1

### Patch Changes

- f060971: Close two TypeScript↔Python parity gaps in the email package:
  - `verifyUnsubscribeToken` now enforces token expiry, mirroring the Python `verify_unsubscribe_token`. It accepts an optional `maxAgeSeconds` (default 30 days) and rejects tokens whose `iat` is older than that — previously the TS path verified the HMAC signature but never checked age, so arbitrarily old tokens were accepted.
  - `assertCanSpamCompliance` placeholder detection now matches the Python mirror exactly: it rejects an address that is bracketed (`[...]`) or contains `placeholder` or `todo` (case-insensitive). Previously the TS path only flagged bracketed addresses, so values like `"TODO: set address"` or `"Placeholder Address"` passed TS validation while failing in Python.

## 0.2.0

### Minor Changes

- 5c0a643: Initial release of all ventora-platform packages. Provides shared observability, analytics, SEO, email, storage, API client, auth, and billing utilities for all Ventora products.

### Patch Changes

- 9171f94: Tighten cutoff readiness gates: package export type resolution, per-file coverage thresholds, storage signed URL typing, API retry normalization, and billing peer resolution.

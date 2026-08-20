# Python Package Release Notes

## 2026-06-11 (retired product cleanup)

- `ventora-analytics` 0.2.0: Removes retired product IDs from the generated analytics product literal, matching the TypeScript analytics contract. This is a breaking contract cleanup for callers that still send retired product IDs.

## 2026-05-27 (backend audit)

- `ventora-billing` 0.1.3: Aligns Stripe subscription webhook allowlisting with the TypeScript billing package.
- `ventora-analytics` 0.1.2: Preserves the explicit EU PostHog host instead of rewriting it to the US ingestion endpoint, matching the TypeScript analytics package.
- `ventora-email` 0.1.2: Rejects malformed unsubscribe tokens that use future, non-finite, or legacy millisecond-issued timestamps, and signs renderer requests with the timestamp/nonce-bound HMAC payload required by the email-renderer Worker.
- `ventora-llm` 0.1.2: Stops retrying non-retryable OpenRouter 4xx client errors and ignores non-object JSON extraction payloads instead of merging invalid shapes.
- `ventora-observability` 0.1.1: Applies the shared HIPAA redaction rule updates to the packaged Python ruleset.
- `ventora-storage` 0.1.3: Normalizes unsafe object key path segments so generated storage keys cannot preserve traversal-like filename components.

## 2026-05-19 (parity follow-up)

- `ventora-billing` 0.1.2: Fixes `is_in_active_trial` to return `False` (not `True`) for a `trialing` subscription with no `trial_ends_at`, matching the TypeScript `isInActiveTrial` mirror — a record missing its trial end date is no longer treated as an active trial.
- `ventora-storage` 0.1.2: `ObjectStorageService.download` now raises `FileNotFoundError` for a missing object (S3 `404`/`NoSuchKey`/`NotFound`) instead of letting the raw `botocore` `ClientError` escape, mirroring the TypeScript adapter's `NotFoundError` behavior.
- `ventora-email` 0.1.1: Aligns `assert_can_spam_compliance` placeholder detection with the TypeScript `@ventora/email` mirror — any bracketed (`[...]`) address is now treated as a placeholder, alongside the existing `placeholder`/`todo` keyword checks.

## 2026-05-19

- `ventora-storage` 0.1.1: Adds signed download URL and direct upload capability helpers, and rejects malformed signed-token expirations fail-closed.
- `ventora-billing` 0.1.1: Adds checkout URL validation and rounds trial-day calculations up to avoid shortening partial-day trials.
- `ventora-llm` 0.1.1: Extracts nested embedded JSON payloads from model responses before validation.
- `ventora-analytics` 0.1.1: Aligns property redaction with the TypeScript `@ventora/analytics` mirror — drops keys containing `password`, `token`, `secret`, or `credential`, or ending in `key` or `auth`.

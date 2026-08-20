# @ventora/observability

Sentry init/capture for both Cloudflare Workers and Node, request correlation IDs, a typed `AppError` hierarchy, and PII redaction.

## Install

```bash
pnpm add @ventora/observability
```

## Usage

```ts
import {
  AppError,
  NotFoundError,
  captureException,
  withCorrelationId,
  redact,
} from "@ventora/observability";

try {
  await withCorrelationId(crypto.randomUUID(), async () => {
    throw new NotFoundError("Invoice not found");
  });
} catch (err) {
  captureException(err, { tags: { area: "billing" } });
}

redact({ email: "user@example.com", apiKey: "sk_live_xxx" });
// => { email: "[email]", apiKey: "[redacted]" }
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `initSentryCloudflare`, `initSentryNode`, `captureException`, `captureMessage`, `withCorrelationId`, `getCorrelationId`, `generateRequestId`, `isValidRequestId`, `AppError`/`NotFoundError`/`UnauthorizedError`/`ForbiddenError`/`ValidationError`/`ConflictError`/`RateLimitError`, `buildInternalErrorBody`, `toUserFacingError`, `redact`, `DEFAULT_RULES` |
| `./redact-hipaa` | `HIPAA_RULES`, `redact` |

## Notes

- `@sentry/cloudflare` and `@sentry/node` are both optional peer dependencies; `initSentryNode` dynamic-imports `@sentry/node` so a Worker build never bundles the Node SDK.
- `withCorrelationId` uses `AsyncLocalStorage` on Node (concurrency-safe) and a module-level variable on Cloudflare Workers (safe there because each Worker invocation is single-tenant).
- `redact()` runs `DEFAULT_RULES` by default; pass `HIPAA_RULES` from `./redact-hipaa` to also strip MRN/NPI/DEA/date-of-service identifiers ahead of the base pattern set.

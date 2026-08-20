# @ventora/ai-sdr-worker

Cloudflare Worker runtime for the shared AI-SDR widget: session, chat, and handoff APIs backed by OpenRouter and a Durable Object session store.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /health` | Liveness check. |
| `GET /client/ai-sdr.js`, `/client/v0.3.x/ai-sdr.js` | Hosted ESM widget client (alias + versioned, v0.3.0-v0.3.7). |
| `GET /client/ai-sdr.global.js`, `/client/v0.3.x/ai-sdr.global.js` | Hosted global/IIFE widget client (alias + versioned). |
| `POST /v1/sessions` | Create a chat session for a product. Requires allowed origin + client assertion. |
| `POST /v1/chat` | Send a chat turn; returns an SSE stream (`message.delta`, `source`, `plan.recommendation`, `trial.cta`, `lead.captured`, `message.done`, `error`). Requires allowed origin + client assertion. |
| `POST /v1/handoff` | Request a human handoff for a session. Requires allowed origin + client assertion. |
| `OPTIONS *` | CORS preflight. |

## Configuration

| Binding / secret | Purpose |
| --- | --- |
| `AI_SDR_SESSIONS` (Durable Object) | Session storage; falls back to an in-memory store when unbound. |
| `AI_SDR_ALLOWED_ORIGINS` (var) | Comma-separated origins allowed to call the session/chat/handoff routes. |
| `AI_SDR_SESSION_TTL_SECONDS` (var) | Session lifetime, default `86400`. |
| `CRM_INGEST_ENDPOINT` (var) | Base CRM lead-ingest URL. Absent -> lead push is skipped. |
| `POSTHOG_HOST` (var) | PostHog ingest host, defaults to the US region. |
| `AI_SDR_CONTEXT_SECRET` (secret) | HMAC secret for signed product-context fetches. |
| `AI_SDR_CONTEXT_ENDPOINTS` (secret) | JSON map of `productId` to signed context endpoint. |
| `AI_SDR_CLIENT_ASSERTION_SECRET` (secret) | HMAC secret verifying `/v1/*` request signatures. |
| `OPENROUTER_API_KEY` (secret) | OpenRouter API key for chat completions and lead extraction. |
| `CRM_INGEST_SECRET` (secret) | HMAC secret for signing CRM lead-ingest pushes. |
| `SENTRY_DSN` (secret, optional) | Error telemetry; absent = no-op. |
| `POSTHOG_API_KEY` (secret, optional) | Product analytics; absent = no-op. |

## Deploy

```bash
pnpm --filter @ventora/ai-sdr-worker run deploy
```

## Notes
- Every signed request (client assertion and product-context fetch) uses an HMAC-over-timestamp-nonce-method-path-body payload with a 5-minute freshness window (`maxSkewMs` defaults to `300_000`) and a timing-safe signature comparison; client assertions are additionally replay-checked over a 5-minute window (`CLIENT_ASSERTION_REPLAY_WINDOW_MS`). Nonce state lives in the `AiSdrSession` Durable Object when `AI_SDR_SESSIONS` is bound, which is the deployed configuration; a process-local cache stands in when it is not.
- Sessions live in a Durable Object (`AiSdrSession`, SQLite-backed) when `AI_SDR_SESSIONS` is bound; a process-local `MemorySessionStore` is the fallback for tests and unbound environments.
- Failed CRM pushes are queued in a durable outbox and retried on a fixed backoff ladder (`PUSH_BACKOFF_MS = [0, 30s, 120s, 600s, 3600s]`) for up to 5 attempts before being dropped.
- Lead extraction only runs when `shouldExtract` sees a fresh contact or qualification signal in the last few user turns, and a CRM push only fires once the profile clears a plausible-email threshold. Both gates exist to protect latency and cost on the hot chat path.

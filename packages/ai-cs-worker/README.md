# @ventora/ai-cs-worker

Cloudflare Worker runtime for the shared, authenticated app-support widget: session, chat, context, and escalation APIs backed by OpenRouter and a Durable Object session store.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /health` | Liveness check. |
| `GET /client/ai-cs.js`, `/client/v0.x.x/ai-cs.js` | Hosted ESM widget client (alias + versioned, v0.1.0-v0.3.1). |
| `GET /client/ai-cs.global.js`, `/client/v0.x.x/ai-cs.global.js` | Hosted global/IIFE widget client (alias + versioned). |
| `POST /v1/sessions` | Create a support session for an app + user. Requires allowed origin + client assertion. |
| `POST /v1/chat` | Send a chat turn; returns an SSE stream (app-context events, `message.delta`, `support.escalation.requested`, `message.done`). Requires allowed origin, client assertion, and session ownership. |
| `POST /v1/escalations` | Request a human escalation for a session. Requires allowed origin, client assertion, and session ownership. |
| `OPTIONS *` | CORS preflight. |

## Configuration

| Binding / secret | Purpose |
| --- | --- |
| `AI_CS_SESSIONS` (Durable Object) | Session storage; falls back to an in-memory store when unbound. |
| `AI_CS_ALLOWED_ORIGINS` (var) | Comma-separated origins allowed to call the session/chat/escalation routes. |
| `AI_CS_SESSION_TTL_SECONDS` (var) | Session lifetime, default `86400`. |
| `AI_CS_CLIENT_ASSERTION_SECRET` (secret) | HMAC secret verifying `/v1/*` request signatures. |
| `AI_CS_CONTEXT_SECRET` (secret) | HMAC secret for signed app-context fetches. |
| `AI_CS_CONTEXT_ENDPOINTS` (secret) | JSON map of `appId` to signed context endpoint. |
| `OPENROUTER_API_KEY` (secret) | OpenRouter API key for chat completions. |

## Deploy

```bash
pnpm --filter @ventora/ai-cs-worker run deploy
```

## Notes
- Client assertions and app-context fetches use an HMAC-over-timestamp-nonce-method-path-body payload verified with a timing-safe comparison and replay-checked via `consumeClientAssertion`; the caller's own `Authorization` header (the app's user session token) is forwarded as-is to the context endpoint alongside the Worker's own HMAC signature, so the product backend authenticates the end user while the Worker authenticates the request origin.
- Sessions live in a Durable Object (`AiCsSession`, SQLite-backed) when `AI_CS_SESSIONS` is bound; a process-local `MemorySessionStore` (a plain `Map`) is the fallback for tests and unbound environments.
- `/v1/chat` and `/v1/escalations` check both `requestMatchesSessionOwner` and `requestMatchesSessionOrigin` before touching a session, so a valid client assertion alone is not enough to act on someone else's session.

# BFF Route Templates

Copy-paste backend-for-frontend (BFF) route templates that mint HMAC client-assertion
headers and proxy AI assistant calls (session creation, chat, handoff/escalation) to
the deployed Workers.

Why a BFF at all: CORS is not an auth boundary. The Workers reject any session/chat/
handoff/escalation request that lacks valid HMAC headers, and the assertion secret
(`AI_SDR_CLIENT_ASSERTION_SECRET` / `AI_CS_CLIENT_ASSERTION_SECRET`) must **never**
reach the browser. The product backend holds the secret, signs each request, and
proxies it. This is also where you durably capture leads (AI-SDR) and escalations/
tickets (AI-CS). See the receiver sections in [AI_SDR.md](../../AI_SDR.md) and
[AI_CS.md](../../AI_CS.md).

## Signing contract (must match `@ventora/ai-assistant-contracts`)

```
payload    = `${timestamp}.${nonce}.${METHOD}.${path}.${sha256Hex(stableJson(body))}`
signature  = hmacSha256Hex(secret, payload)        // 64-char lowercase hex
headers    = { X-Ventora-Timestamp, X-Ventora-Nonce, X-Ventora-Signature }
```

- `timestamp`: ISO 8601 string (`new Date().toISOString()`).
- `nonce`: a UUID; the Worker rejects replays.
- `METHOD`: uppercased HTTP method (`POST`).
- `path`: the Worker path being called, e.g. `/v1/sessions`, `/v1/chat`, `/v1/handoff`, `/v1/escalations`.
- `stableJson`: JSON with **recursively sorted keys** and compact separators. You
  must send the exact same bytes you signed (sign the canonical form, then send it).
- For AI-CS, also forward the same browser `Origin`; the Worker binds the session to
  its original origin and rejects later calls from a different one.

## Files

- `nextjs-app-router.ts` holds Next.js App Router route handlers. TypeScript backends can
  import `buildHmacPayload` / `signHmacPayload` directly from `@ventora/ai-assistant-contracts`.
- `fastapi.py` holds a FastAPI router. There is no Python assistant-contracts package, so the
  signing primitive is reimplemented with `hashlib`/`hmac` (kept byte-for-byte
  compatible with the TS helpers).

Both default to AI-SDR (`/v1/handoff`, `AI_SDR_*`); the inline comments mark the
two-line change to target AI-CS (`/v1/escalations`, `AI_CS_*`, forward `Origin`).

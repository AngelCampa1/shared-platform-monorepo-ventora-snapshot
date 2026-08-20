# @ventora/ai-assistant-contracts

Shared HMAC request-signing and SSE-event contracts that the AI-SDR and AI-CS protocol packages both build on.

## Install

```bash
pnpm add @ventora/ai-assistant-contracts
```

## Usage

```ts
import {
  buildHmacPayload,
  signHmacPayload,
  verifyHmacSignature,
} from "@ventora/ai-assistant-contracts";

const timestamp = new Date().toISOString();
const nonce = crypto.randomUUID();
const body = { sessionId: "sess_123", message: "Hello" };

const payload = buildHmacPayload({ timestamp, nonce, method: "POST", path: "/v1/chat", body });
const signature = signHmacPayload(payload, secret);

const result = verifyHmacSignature({ payload, signature, secret, timestamp });
// { ok: true } or { ok: false, reason: "invalid_signature" | "malformed_signature" | "timestamp_skew" }
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `buildHmacPayload`, `signHmacPayload`, `verifyHmacSignature`, `sha256Hex`, `stableJson`, `createAssistantSseEventValidator`, `isAiAssistantSseEvent`, `parseAiAssistantSseEventName`, shared contract types (`AiAssistantContext`, `AiAssistantMessage`, `HmacHeaders`, `HmacVerificationResult`, ...) |

## Notes

- Zero runtime dependencies. SHA-256 and HMAC-SHA256 are implemented directly against `Uint8Array`, without `crypto.subtle` or a crypto library.
- `verifyHmacSignature` defaults to a 5-minute timestamp skew window and does a constant-time signature comparison.
- `@ventora/ai-cs-contracts` and `@ventora/ai-sdr-contracts` both depend on this package and re-export its HMAC primitives, so most consumers install one of those instead of this one directly.

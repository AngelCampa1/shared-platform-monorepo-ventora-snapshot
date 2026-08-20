# @ventora/ai-sdr-contracts

Protocol types, runtime type guards, and SSE-event validators for the AI-SDR session/chat/handoff/CRM-ingest API.

## Install

```bash
pnpm add @ventora/ai-sdr-contracts
```

## Usage

```ts
import { isCrmLeadIngestRequest, type CrmLeadIngestRequest } from "@ventora/ai-sdr-contracts";

const payload: CrmLeadIngestRequest = {
  productKey: "grantpipe",
  sdrSessionId: "sess_123",
  profile: {
    contact: { email: "buyer@example.com" },
    qualification: { useCase: "grant tracking" },
    derived: {},
    status: "qualified",
  },
  activities: [{ type: "session_started" }],
  occurredAt: new Date().toISOString(),
};

isCrmLeadIngestRequest(payload); // true, validated before it reaches a product CRM
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `isAiSdrSseEvent`, `parseSseEventName`, `isHandoffRequest`, `isCrmLeadIngestRequest`, `isCrmLeadIngestResponse`, `isLeadProfile`, `isLeadQualification`, `isLeadDerived`, `isContactInfo`, `isLeadStatus`, `isLeadActivityInput`, protocol types (`CreateSessionRequest`, `ChatRequest`, `HandoffRequest`, `LeadProfile`, `CrmLeadIngestRequest`, `AiSdrSseEvent`, ...), plus the re-exported HMAC primitives from `@ventora/ai-assistant-contracts` |

## Notes

- Ships runtime type guards (`isXxx`), not just TypeScript types. The AI-SDR worker uses these to validate an untrusted request body without pulling in a schema-validation library.
- `CrmLeadIngestRequest`/`Response` back the worker's durable CRM outbox: lead pushes to a product's CRM retry on this contract until accepted.

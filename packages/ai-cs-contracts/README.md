# @ventora/ai-cs-contracts

Protocol types and SSE-event validators for the authenticated AI-CS session/chat/escalation API, shared between the AI-CS worker and its clients.

## Install

```bash
pnpm add @ventora/ai-cs-contracts
```

## Usage

```ts
import { isAiCsSseEvent, type AiCsChatRequest } from "@ventora/ai-cs-contracts";

const request: AiCsChatRequest = {
  sessionId: "sess_123",
  appId: "camaudit",
  userId: "user_42",
  message: "How do I run a reconciliation?",
};

const candidate = JSON.parse(sseData);
if (isAiCsSseEvent(candidate)) {
  // candidate.event is "session.created" | "message.delta" | "source" | "cta"
  // | "navigation.suggestion" | "workflow.step" | "support.escalation.requested"
  // | "message.done" | "error" | "heartbeat"
}
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `isAiCsSseEvent`, `parseAiCsSseEventName`, request/response/context types (`AiCsSessionRequest`, `AiCsChatRequest`, `AiCsEscalationRequest`, `AiCsAppContext`, `AiCsSseEvent`, ...), plus the re-exported HMAC primitives from `@ventora/ai-assistant-contracts` |

## Notes

- `AiCsChatRequest` and `AiCsEscalationRequest` require `appId` and `userId` on every call, not just the session. The worker re-checks them against the looked-up session as defense in depth, since one shared client-assertion secret otherwise can't prove which app/user a body speaks for.
- Adds AI-CS-specific SSE events (`navigation.suggestion`, `workflow.step`, `support.escalation.requested`) on top of the shared set defined in `@ventora/ai-assistant-contracts`.

# @ventora/ai-cs

Browser client for the AI-CS worker: session management, chat streaming, escalation requests, and both a React widget and a plain-DOM mount helper.

## Install

```bash
pnpm add @ventora/ai-cs
```

## Usage

```ts
import { createAiCsSession, sendAiCsChatMessage, type AiCsApiConfig } from "@ventora/ai-cs";

// signRequest calls your backend, which holds the shared HMAC secret.
const api: AiCsApiConfig = {
  baseUrl: "https://ai-cs.example.com",
  signRequest: (req) => backendSignRequest(req.method, req.path, req.serializedBody),
};

const session = await createAiCsSession(api, { appId: "camaudit", userId: "user_42" });
const request = { sessionId: session.sessionId, appId: "camaudit", userId: "user_42", message: "How do I export a report?" };
await sendAiCsChatMessage(api, request, { onEvent: (e) => console.log(e.event, e.data) });
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createAiCsSession`, `createAiCsSessionManager`, `sendAiCsChatMessage`, `requestAiCsSupportEscalation`, `createAiCsSseParser`, `createAiCsWidget` (plain-DOM mount), `AiCsApiError`, plus everything re-exported from `@ventora/ai-cs-contracts` |
| `./react` | `AiCsWidget` (React component), `useAiCsWidget` hook, `resolveAiCsBrand`, `ensureAiCsStyles`, `AI_CS_STYLES` |

## Notes

- `react`/`react-dom` >=18 are peer dependencies for the `./react` subpath only; the `.` entry point has no React dependency.
- `createAiCsWidget` and `<AiCsWidget>` are both singleton-guarded: a second concurrent mount is dropped with a console warning instead of producing two widgets.
- Callers supply `signRequest` (mints a fresh assertion per call from your backend) or a static `clientAssertion`. This package never holds the HMAC secret.

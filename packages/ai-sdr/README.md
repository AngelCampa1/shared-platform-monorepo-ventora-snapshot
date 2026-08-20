# @ventora/ai-sdr

Browser client and embeddable, dependency-free DOM widget for the AI-SDR worker.

## Install

```bash
pnpm add @ventora/ai-sdr
```

## Usage

```ts
import { createAiSdrWidget, type AiSdrApiConfig } from "@ventora/ai-sdr";

const api: AiSdrApiConfig = {
  baseUrl: "https://ai-sdr.example.com",
  clientAssertion: await fetchAssertionFromYourBackend(),
};

const widget = createAiSdrWidget({
  target: document.getElementById("sdr-widget")!,
  api,
  session: { productId: "grantpipe", visitorId: crypto.randomUUID() },
  callbacks: {
    onLeadCaptured: (lead) => console.log(lead.leadId, lead.status),
  },
});

await widget.open();
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createAiSdrWidget`, `createAiSdrSession`, `sendAiSdrChatMessage`, `requestAiSdrHandoff`, `createAiSdrSseParser`, `AiSdrApiError`, plus everything re-exported from `@ventora/ai-sdr-contracts` |

## Notes

- `createAiSdrWidget` renders directly to the DOM with no framework dependency. There is no React build of this widget.
- Ships built-in brand presets for `camaudit`, `capveri`, `grantpipe`, and `lextract`; unknown `productId` values fall back to a neutral theme. All rendered buttons/links use pill (`border-radius: 9999px`) styling.
- The widget is a page-level singleton: a second `createAiSdrWidget` call while one is already mounted is dropped with a console warning rather than mounting a duplicate.

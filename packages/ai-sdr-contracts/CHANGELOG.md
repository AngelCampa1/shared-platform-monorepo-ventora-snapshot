# @ventora/ai-sdr-contracts

## 0.3.0

### Minor Changes

- 444e57f: Add optional `meetingLinks` field (and `MeetingLink` type) to `ProductContext` and `AiCsAppContext` so signed AI context can carry booking links (e.g. cal.com) through to the AI-SDR and AI-CS workers.

## 0.2.1

### Patch Changes

- 505e43f: Add shared assistant protocol contracts for AI-SDR and AI-CS, introduce authenticated app AI-CS contracts and browser helpers, and layer AI-SDR contracts on the shared assistant primitives.
- 15f1787: Polish the embeddable AI SDR widget with rich message rendering, PostHog-compatible tracking, pill CTAs, message-id-safe streaming, stronger accessible labelling, and richer canonical plan pricing context.
- Updated dependencies [505e43f]
  - @ventora/ai-assistant-contracts@0.2.0

## 0.2.0

### Minor Changes

- 200af29: Add shared AI-SDR contracts, HMAC/SSE helpers, and the browser client/widget package.

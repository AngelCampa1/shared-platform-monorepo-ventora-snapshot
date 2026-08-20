# @ventora/ai-cs-contracts

## 0.3.0

### Minor Changes

- 444e57f: Add optional `meetingLinks` field (and `MeetingLink` type) to `ProductContext` and `AiCsAppContext` so signed AI context can carry booking links (e.g. cal.com) through to the AI-SDR and AI-CS workers.

## 0.2.0

### Minor Changes

- 505e43f: Add shared assistant protocol contracts for AI-SDR and AI-CS, introduce authenticated app AI-CS contracts and browser helpers, and layer AI-SDR contracts on the shared assistant primitives.

### Patch Changes

- Updated dependencies [505e43f]
  - @ventora/ai-assistant-contracts@0.2.0

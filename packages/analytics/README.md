# @ventora/analytics

PostHog analytics wrapper where every event name is checked against a compile-time union generated from the shared event schema.

## Install

```bash
pnpm add @ventora/analytics
```

## Usage

```ts
import { initAnalytics, trackEvent, identifyUser } from "@ventora/analytics/browser";

initAnalytics({ posthogKey: "phc_xxx", environment: "production", productSlug: "grantpipe" });
identifyUser("user_42", { plan: "pro" });
trackEvent("trial_started", { planId: "pro" });
// trackEvent("made_up_event", {}) fails to compile: event names come from ApprovedEvent
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `ApprovedEvent`/`VentoraProduct` types, `APPROVED_EVENTS`, `AnalyticsConfig`/`UserTraits`/`OrgProps`/`AnalyticsEnv` types, `sanitizeProperties` |
| `./browser` | `initAnalytics`, `trackEvent`, `identifyUser`, `groupOrganization`, `resetAnalytics` |
| `./server` | `captureServerEvent`, `sanitizeProperties`, `AnalyticsEnv` |
| `./events` | The generated `ApprovedEvent` union and `APPROVED_EVENTS` map |

## Notes

- `posthog-js` is an optional peer dependency, loaded via dynamic `import()` so server bundles never pull it in. `./server` posts events to the PostHog capture endpoint over `fetch` instead.
- `ApprovedEvent` is generated from `schemas/analytics-events.json` (see the repo root); it is not hand-maintained and stays in sync with the Python event taxonomy by codegen.
- `sanitizeProperties` (used by both browser and server capture) strips any property key matching a secret-like pattern (`password`, `token`, `secret`, `credential`, `*key`, `*auth`) and truncates string values to 1000 characters before anything leaves the process.

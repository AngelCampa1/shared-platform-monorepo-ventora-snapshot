# ventora-analytics

PostHog event capture (sync, async, and fire-and-forget) restricted to a shared, approved event taxonomy.

## Install

```bash
uv add ventora-analytics
```

## Usage

```python
from ventora_analytics import AnalyticsEnv, capture_event, capture_event_async, is_approved_event

env = AnalyticsEnv(posthog_key="phc_...", posthog_host="https://us.i.posthog.com")

if is_approved_event("checkout_completed"):
    capture_event(
        "checkout_completed",
        distinct_id="user_123",
        organization_id="org_456",
        properties={"plan": "pro"},
        env=env,
    )

# Async call site (e.g. inside an async FastAPI handler)
await capture_event_async(
    "trial_started",
    distinct_id="user_123",
    env=env,
)
```

## Notes
- `capture_event`/`capture_event_async` no-op when `env.posthog_key` is unset or the event name is not in `APPROVED_EVENTS`, and swallow all send failures. Analytics must never crash the calling service.
- `sanitize_properties` strips any key containing `password`/`token`/`secret`/`credential` or ending in `key`/`auth`, drops `None` values, and truncates long strings to 1000 chars before a payload is sent.
- `_generated_events.py` (source of `APPROVED_EVENTS`, `ApprovedEvent`, `VentoraProduct`) is generated from `schemas/analytics-events.json` by `scripts/codegen-schemas.mjs` and shared with the TypeScript `@ventora/analytics` package's own generated file. Never hand-edit it. Regenerate via `pnpm schemas:generate`.

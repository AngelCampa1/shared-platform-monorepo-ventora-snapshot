# @ventora/ai-sdr-worker

## 1.0.1

### Patch Changes

- Replace visible human handoff CTAs with founder booking links and hide widget launchers while panels are open.
- Updated dependencies [444e57f]
  - @ventora/ai-sdr-contracts@0.3.0

## 1.0.0

### Major Changes

- 30b9f98: Remove retired product IDs, origins, analytics products, and hosted widget brand presets from shared platform packages. This intentionally narrows product-id contracts for retired products.

### Patch Changes

- e06609a: AI-SDR hosted client: discard a stored chat session id once it passes the worker session TTL (24h). Returning visitors no longer fire a doomed first `/v1/chat` that 404s before the silent-recovery path mints a fresh session — the stale id is dropped proactively, so the common "came back the next day" case starts a fresh session with no stray network error in the console. The 404-recovery path remains as the backstop for early server-side eviction; legacy stored ids without a timestamp are still trusted.
- 4b3b68e: Tighten CAMAudit assistant grounding and widget polish: AI-SDR now uses signed trial/CTA plan context, selects the best matching signed plan instead of always recommending the first plan, and avoids desktop modal semantics when the page remains interactive. AI-CS hosted and React widgets now use the same mobile breakpoint and 44px pill controls for the affected actions.

## 0.4.0

### Minor Changes

- 5f71af4: Allow `http://localhost` OpenRouter and signed-context endpoints in non-production environments.

  Both AI workers gain an explicit, dev-only relaxation of their SSRF endpoint guards:
  `openRouterEndpoint` and `parseHttpsUrl` (used for the signed app/product-context
  endpoints) now accept `http://localhost` / `http://127.0.0.1` URLs **only** when the
  environment is an explicit non-production value (`ENVIRONMENT` or `NODE_ENV` ∈
  `{"local", "development", "test"}`).

  The allowance is keyed on an explicit dev value, never on an unset variable: a
  misconfigured production deployment with `ENVIRONMENT` unset stays fully
  https/openrouter.ai-locked. In production the guards are unchanged — OpenRouter is
  pinned to `https://openrouter.ai`, and context endpoints must be `https:`.

  This unblocks fully deterministic, in-depth local E2E testing of the authenticated
  chat-SSE pipeline against mock OpenRouter + mock signed-context servers (no network,
  no real keys). The new behavior is covered by unit tests in both workers and by the
  `scripts/e2e/chat-sse.e2e.mjs` end-to-end test.

### Patch Changes

- db97d88: Fix two hosted-client bugs that broke the embedded AI-SDR widget for every plain
  `init()` embedding (floriva and any other surface that mounts the widget without
  opening it programmatically), and publish the corrected client under fresh,
  never-cached version paths.
  1. **Launcher never mounted on init.** The hosted client only injected the launcher
     button when the panel was first opened, so a normal `AiSdr.init({...})` left the
     page with no visible affordance. The launcher is now mounted eagerly on `init()`.
  2. **Closed panel overlaid the page and swallowed clicks.** The closed/base panel kept
     `display:flex` (author CSS beats the UA `[hidden]{display:none}`) and was hidden only
     via `opacity:0` while retaining `pointer-events:auto` — an invisible fixed overlay
     that intercepted clicks on the launcher and the page beneath it. The closed/base state
     now also sets `visibility:hidden;pointer-events:none`; the open state sets
     `visibility:visible;pointer-events:auto`; the exiting state keeps
     `visibility:visible;pointer-events:none` so the close animation still plays without
     capturing input.

  Because versioned client routes are served `Cache-Control: immutable`, mutating an
  already-cached version's bytes can never reach clients that cached that URL. The fixes
  are therefore published under fresh version paths: the launcher-mount fix as
  `/client/v0.3.2/*` and the closed-panel-overlay fix as `/client/v0.3.3/*`. Both the ESM
  (`ai-sdr.js`) and IIFE global (`ai-sdr.global.js`) entrypoints are served at each new
  version. Consumers pin a specific version, so they pick up the fix by bumping their
  pinned URL (floriva is pinned to `v0.3.3`).

  Verified end-to-end on production: launcher mounts → click opens the panel → session
  creates (201 via the same-origin BFF) → chat streams a brand-accurate SSE reply →
  handoff reaches the "queued" banner.

- 5bb34db: minimax-m2.7 only model policy, expert-on-product system prompt, and double-mount guard for hosted init.

  All three routing paths (primary, fallback, escalation) now default to `minimax/minimax-m2.7` with no hardcoded provider restriction — OpenRouter routes to any available provider unless overridden via env vars. The `provider` key is omitted entirely from the OpenRouter payload when the providers array is empty.

  The AI-SDR system prompt is rewritten to lead with what the product does, what problems it solves, and how — inviting a free trial when it fits. Human/Founder contact is only offered when the user explicitly asks.

  `aiSdrInit` in the hosted client now guards against double mounting: a second call returns the existing widget and warns rather than creating a second DOM root. `destroy()` clears the flag so re-initialisation after teardown works correctly.

  Visual fixes: the hidden error toast no longer leaks its dark-red background as a stray bar above the composer (`[data-ai-sdr-toast][hidden]` is now `display:none`), and the in-bubble "Copy" action is given a legible pill style instead of the unstyled browser default.

  Pill buttons: the header handoff button, header close button, send button, in-bubble action buttons, error-toast buttons, and inline-retry button are now full pills (`border-radius:9999px`), so every button in the hosted widget honours the pill design canon.

- 6dee0c3: Fix Durable Object SQL reads crashing on zero rows. `consumeClientAssertion` and `readSession` used the Cloudflare `SqlStorage` cursor `.one()`, which throws ("Expected exactly one result from SQL query") whenever the result set is not exactly one row. Zero rows is the normal outcome for a fresh client-assertion nonce and for a missing/expired session, so every valid first request to `POST /v1/sessions` returned a 500 instead of succeeding, and reads of unknown sessions 500'd instead of 404'ing. Both call sites now use `.toArray()` and inspect the row count, restoring the intended replay-check (409 on duplicate) and session-read (404 on missing) behaviour.

  The Durable Object unit-test mocks were made faithful to the runtime — the fake SQL cursor's `.one()` now throws on a row count other than one (previously it returned `null` for zero rows, masking the bug) — and regression tests assert a fresh client assertion returns 200 and a missing session read returns 404. Coverage configuration for both workers now excludes `node_modules` and ephemeral `.wrangler` build artifacts so the per-file 95% coverage gate evaluates only authored source.

## 0.3.1

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.3.0

### Minor Changes

- d79586a: Give the AI-SDR assistant real multi-turn memory and surface plan recommendations. The worker already persisted a per-session transcript but never sent it to the model, so every turn was stateless; `buildOpenRouterPayload` now includes the prior conversation (capped at the 20 most recent messages) between the system prompt and the current user message, threaded through both the primary and fallback routes. The hosted browser widget now renders `plan.recommendation` events (reason and price summary), which the worker emitted but no client previously displayed.

## 0.2.1

### Patch Changes

- Hosted client v0.3.1 adds defensive malformed JSON handling for API responses and forwards the documented `subtitle` option through `VentoraAiSdr.init`.

## 0.2.0

### Minor Changes

- a5e13a5: UI/UX overhaul for the AI-SDR and AI-CS embeddable surfaces.
  - `@ventora/ai-sdr-worker`: hosted client v0.3.0 rewritten as a component model (Launcher/Panel/Header/Transcript/MessageBubble/Composer/HandoffBanner/SourcesList/Toast) with WCAG 2.1 AA semantics: real modal (`aria-modal`, inert siblings, document-level focus trap), `aria-live` transcript, `aria-busy` during stream, safe-URL allowlist (`http`/`https`/`mailto` only — blocks `javascript:`/`data:`), refcounted inert coordination for multi-widget pages, reduced-motion + RTL + 100dvh mobile + safe-area-inset support. v0.2.0 client is unchanged.
  - `@ventora/ai-cs-worker`: new hosted client served from `GET /client/ai-cs.js` and `GET /client/v0.1.0/ai-cs.js` (plus `.global.js` variants). Mirrors the AI-SDR component model and adds CS-specific rendering for `source`, `navigation.suggestion`, `workflow.step`, and escalation status events. HMAC client assertion is accepted via config and forwarded as `X-Ventora-Timestamp` / `X-Ventora-Nonce` / `X-Ventora-Signature` headers.
  - `@ventora/ai-cs`: new `@ventora/ai-cs/react` subpath export. Adds `<AiCsWidget />` and `useAiCsWidget()` for React 18+ consumers. The hook composes the existing `createAiCsSessionManager` / `sendAiCsChatMessage` / `requestAiCsSupportEscalation` primitives (no duplication) and accepts a `signRequest` callback so host apps can sign requests from their own backend. React peer dependency added (`react`, `react-dom` `>=18`).

## 0.1.2

### Patch Changes

- Updated dependencies [505e43f]
- Updated dependencies [15f1787]
  - @ventora/ai-sdr-contracts@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [200af29]
  - @ventora/ai-sdr-contracts@0.2.0

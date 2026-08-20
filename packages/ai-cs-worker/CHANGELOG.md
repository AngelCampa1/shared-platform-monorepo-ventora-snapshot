# @ventora/ai-cs-worker

## 1.0.1

### Patch Changes

- Replace visible human handoff CTAs with founder booking links and hide widget launchers while panels are open.
- Updated dependencies [444e57f]
  - @ventora/ai-cs-contracts@0.3.0

## 1.0.0

### Major Changes

- 30b9f98: Remove retired product IDs, origins, analytics products, and hosted widget brand presets from shared platform packages. This intentionally narrows product-id contracts for retired products.

### Patch Changes

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

- 5bb34db: Lock AI-CS to minimax/minimax-m2.7 only, remove auto-escalation triggers, rewrite persona as in-app how-to expert, and add double-mount guard on `AiCs.init`.
  - **Model policy**: `buildOpenRouterPayload` now omits the `provider` key entirely when `AI_CS_PRIMARY_PROVIDERS` is empty/unset (lets OpenRouter route freely). Fallback path also defaults to `minimax/minimax-m2.7` with no provider restriction; `openai/gpt-5.4-nano` and `openai,azure`/`fireworks,together,morph` defaults are removed.
  - **No auto-escalation**: `NEGATIVE_TRIGGER_RE`, `triggeredByNegative`, and `checkNegativeTrigger` removed from the hosted widget. The escalate host is now persistently visible from panel creation. `updateEscalateVisibility` auto-reveal logic removed. Escalation still works when the user explicitly clicks the control.
  - **Persona rewrite**: `buildSystemPrompt` now positions the assistant as a step-by-step how-to expert for the authenticated app, instructs it to map questions to exact navigation targets/screen names from signed context, and explicitly prohibits proactively offering human support unless the user asks.
  - **Double-mount guard**: `AiCs.init` on the global module tracks the mounted instance under `globalThis.__ventoraAiCsWidget`. Calling `init` again before `destroy` returns the existing instance and emits a `console.warn`. `destroy` clears the flag so re-init works after teardown.
  - **Pill buttons**: the hosted widget's close, overflow, stop, inline-retry, message-action, send, banner-action, banner-dismiss, and toast-dismiss buttons are now full pills (`border-radius:9999px`), matching the React widget and the pill design canon.

- 6dee0c3: Fix Durable Object SQL reads crashing on zero rows. `consumeClientAssertion` and `readSession` used the Cloudflare `SqlStorage` cursor `.one()`, which throws ("Expected exactly one result from SQL query") whenever the result set is not exactly one row. Zero rows is the normal outcome for a fresh client-assertion nonce and for a missing/expired session, so every valid first request to `POST /v1/sessions` returned a 500 instead of succeeding, and reads of unknown sessions 500'd instead of 404'ing. Both call sites now use `.toArray()` and inspect the row count, restoring the intended replay-check (409 on duplicate) and session-read (404 on missing) behaviour.

  The Durable Object unit-test mocks were made faithful to the runtime — the fake SQL cursor's `.one()` now throws on a row count other than one (previously it returned `null` for zero rows, masking the bug) — and regression tests assert a fresh client assertion returns 200 and a missing session read returns 404. Coverage configuration for both workers now excludes `node_modules` and ephemeral `.wrangler` build artifacts so the per-file 95% coverage gate evaluates only authored source.

## 0.3.0

### Minor Changes

- d79586a: Give the AI-CS assistant real multi-turn memory and page awareness. The worker persisted a per-session transcript but never sent it to the model, so every turn was stateless; `buildOpenRouterPayload` now includes the prior conversation (capped at the 20 most recent messages) between the system prompt and the current user message. The known `currentPath` is now included in the system prompt so the assistant can give help relevant to the user's current screen (the prompt is unchanged when no path is known).

### Patch Changes

- 2224782: Sanitize `currentPath` before embedding it in the AI-CS system prompt. The path is user-controlled and was previously interpolated raw into the system message sent to the third-party model, so an email/phone in the path leaked to OpenRouter (every other path through the worker already redacts it) and a newline could inject text into the system role. The system prompt now runs `currentPath` through the existing `sanitizePath` (PII redaction, newline stripping, leading-slash enforcement, 200-char cap), matching the minimized app-context path.

## 0.2.0

### Minor Changes

- a5e13a5: UI/UX overhaul for the AI-SDR and AI-CS embeddable surfaces.
  - `@ventora/ai-sdr-worker`: hosted client v0.3.0 rewritten as a component model (Launcher/Panel/Header/Transcript/MessageBubble/Composer/HandoffBanner/SourcesList/Toast) with WCAG 2.1 AA semantics: real modal (`aria-modal`, inert siblings, document-level focus trap), `aria-live` transcript, `aria-busy` during stream, safe-URL allowlist (`http`/`https`/`mailto` only — blocks `javascript:`/`data:`), refcounted inert coordination for multi-widget pages, reduced-motion + RTL + 100dvh mobile + safe-area-inset support. v0.2.0 client is unchanged.
  - `@ventora/ai-cs-worker`: new hosted client served from `GET /client/ai-cs.js` and `GET /client/v0.1.0/ai-cs.js` (plus `.global.js` variants). Mirrors the AI-SDR component model and adds CS-specific rendering for `source`, `navigation.suggestion`, `workflow.step`, and escalation status events. HMAC client assertion is accepted via config and forwarded as `X-Ventora-Timestamp` / `X-Ventora-Nonce` / `X-Ventora-Signature` headers.
  - `@ventora/ai-cs`: new `@ventora/ai-cs/react` subpath export. Adds `<AiCsWidget />` and `useAiCsWidget()` for React 18+ consumers. The hook composes the existing `createAiCsSessionManager` / `sendAiCsChatMessage` / `requestAiCsSupportEscalation` primitives (no duplication) and accepts a `signRequest` callback so host apps can sign requests from their own backend. React peer dependency added (`react`, `react-dom` `>=18`).

# @ventora/ai-cs

## 1.0.6

### Patch Changes

- d363c75: Scrub "founder" naming from the CS widget defaults: the default escalate label is now "Talk to a person", the availability copy drops the founder wording, and the default escalate suggestion uses the `AI_CS_ESCALATE_SUGGESTION` sentinel instead of a literal string. The escalation booking behavior is unchanged (helpers renamed to `resolveEscalationBookingUrl` / `openEscalationBookingUrl`).

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

## 0.6.0

### Minor Changes

- b38468e: AI-CS: render markdown in assistant replies (bold, italic, code, links, lists) to match AI-SDR.

### Patch Changes

- a324f1d: AI-CS: keep source and suggestion chips legible in auto dark mode.
- c10900b: Set DEFAULT_COPY.subtitle to "Replies in seconds" so the chat header renders a two-line title+subtitle out of the box, matching AI-SDR parity; products passing subtitle:"" still suppress it.
- e9dbab3: Add welcome empty-state with heading, subline, and starter suggestion chips to the AI-CS React widget, bringing it to parity with the AI-SDR sibling.
- 0fddf79: Hide the persistent "Talk to a human" pill in the empty state so it no longer duplicates the welcome suggestion chip.
- d023306: Render GitHub-flavored markdown tables in assistant replies (parity with the AI-SDR widget).
- 49d54bb: Prevent overlapping sends in the support widget: rapidly pressing Enter or clicking Send no longer starts two concurrent streams or duplicates the message. A synchronous in-flight guard now blocks a new send until the current one finishes or is stopped, matching the AI-SDR widget.
- 14557bd: Replace collapsible sources `<details>` with always-visible pill chip row matching the suggestion-chip visual language.
- 200cc22: Render the stop-generating button as a transparent centered pill instead of a full-width solid bar.
- 3803d59: Fix invisible composer input under dark brand palettes: the message field background now derives from the surface and text tokens instead of a hardcoded white, so typed text stays readable in any brand.
- bac9b0e: Fix the AI-CS chat widget getting stuck in the streaming state after an answer finishes. The streaming counter was mutated inside a React state updater, which React 18 can replay, leaving `isStreaming` permanently true (stop button never cleared, composer not restored). Streaming is now tracked by a set of in-flight message IDs mutated outside updaters. Also fixed a CSS specificity issue where the composer's `hidden` attribute was overridden by `display:flex`, so the composer now correctly hides while a reply streams.

## 0.5.1

### Patch Changes

- 4e7e95b: The importable AI-CS React widget now classifies chat send failures before
  showing the error banner, so users never see a raw machine code (e.g.
  `app_context_unavailable`) or a bare HTTP status word. Status classes map to
  plain copy (auth, forbidden, rate-limited, unavailable) with a generic
  fallback, matching the worker hosted client.

  The widget also recovers transparently from an evicted session: on a `404`
  from `/v1/chat` it mints a fresh session via the session manager and retries
  the send once (guarded against loops), so a returning visitor whose session
  expired no longer hits a dead widget.

## 0.5.0

### Minor Changes

- 5bb34db: **No auto-escalation / persistent escalate control (breaking prop removal)**

  The "Talk to a human" escalate button is now always visible when the chat panel is open. It is never auto-revealed or hidden based on message count, keyword triggers, or error state. The user can always click it to request a human handoff.

  Removed public API surface:
  - `negativeTriggers?: RegExp` prop on `<AiCsWidget>` — deleted. The prop no longer exists and passing it will cause a TypeScript error.

  Internal state removed: `triggeredByNegative`, `assistantMsgCount`, `DEFAULT_NEGATIVE_TRIGGERS`, and the `escalateEligible` computation. The escalate network action (`escalate()`) and its click handler are unchanged.

  **Singleton / double-mount guard**

  Both `<AiCsWidget>` (React) and `createAiCsWidget` (vanilla) now guard against a second concurrent mount:
  - `<AiCsWidget>`: a module-level `Set` tracks mounted instances. A second concurrent instance renders `null` and emits a `console.warn`. The flag is cleared on unmount so unmount → remount of the same instance works correctly.
  - `createAiCsWidget` (new export on `@ventora/ai-cs`): vanilla factory that mounts the React widget into a host `<div data-aics-mount-host>`. If `[data-aics-root]` is already present in the document at call time (or races in before the async import resolves), it is a no-op and warns once. `handle.destroy()` unmounts and removes the host so a subsequent mount works.

  **New export**: `createAiCsWidget(options: AiCsVanillaWidgetOptions): AiCsWidgetHandle` on the root `@ventora/ai-cs` entry point.

### Patch Changes

- ab3588d: Render the send, stop, and retry action buttons as pills (`border-radius:9999px`) to match the canonical pill-button shape already used by the launcher, jump, navigation, and escalate controls.

  Also round the header close button and the banner-close button to full pills, so every button in the React widget honours the pill design canon.

## 0.4.2

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.4.1

### Patch Changes

- Harden AI-CS request signing contracts and update DOM test dependencies to patched versions.

## 0.4.0

### Minor Changes

- 0fc7a3a: Harden AI-CS React widget UI/UX and accessibility: opt out of automatic dark mode via the `data-aics-theme` attribute, fix the panel font-family stack, correct the failed-bubble retry lifecycle, and make the escalation-queued banner text configurable through the new `escalationQueued` copy field (defaults preserved).

## 0.3.0

### Minor Changes

- a5e13a5: UI/UX overhaul for the AI-SDR and AI-CS embeddable surfaces.
  - `@ventora/ai-sdr-worker`: hosted client v0.3.0 rewritten as a component model (Launcher/Panel/Header/Transcript/MessageBubble/Composer/HandoffBanner/SourcesList/Toast) with WCAG 2.1 AA semantics: real modal (`aria-modal`, inert siblings, document-level focus trap), `aria-live` transcript, `aria-busy` during stream, safe-URL allowlist (`http`/`https`/`mailto` only — blocks `javascript:`/`data:`), refcounted inert coordination for multi-widget pages, reduced-motion + RTL + 100dvh mobile + safe-area-inset support. v0.2.0 client is unchanged.
  - `@ventora/ai-cs-worker`: new hosted client served from `GET /client/ai-cs.js` and `GET /client/v0.1.0/ai-cs.js` (plus `.global.js` variants). Mirrors the AI-SDR component model and adds CS-specific rendering for `source`, `navigation.suggestion`, `workflow.step`, and escalation status events. HMAC client assertion is accepted via config and forwarded as `X-Ventora-Timestamp` / `X-Ventora-Nonce` / `X-Ventora-Signature` headers.
  - `@ventora/ai-cs`: new `@ventora/ai-cs/react` subpath export. Adds `<AiCsWidget />` and `useAiCsWidget()` for React 18+ consumers. The hook composes the existing `createAiCsSessionManager` / `sendAiCsChatMessage` / `requestAiCsSupportEscalation` primitives (no duplication) and accepts a `signRequest` callback so host apps can sign requests from their own backend. React peer dependency added (`react`, `react-dom` `>=18`).

- a7adc85: Persist AI-SDR and AI-CS sessions across page loads and expose APIs for starting a fresh chat.

## 0.2.0

### Minor Changes

- 505e43f: Add shared assistant protocol contracts for AI-SDR and AI-CS, introduce authenticated app AI-CS contracts and browser helpers, and layer AI-SDR contracts on the shared assistant primitives.

### Patch Changes

- Updated dependencies [505e43f]
  - @ventora/ai-cs-contracts@0.2.0

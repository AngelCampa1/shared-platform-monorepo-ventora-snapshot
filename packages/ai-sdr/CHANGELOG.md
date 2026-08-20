# @ventora/ai-sdr

## 1.0.2

### Patch Changes

- d363c75: Remove the "Talk to the founder" handoff button and its email-capture confirm panel from the SDR widget. The generic SSE-driven handoff confirmation is retained (copy is now product-neutral: "Thanks. We'll be in touch."), and the `requestAiSdrHandoff` transport export is unchanged.

## 1.0.1

### Patch Changes

- Updated dependencies [444e57f]
  - @ventora/ai-sdr-contracts@0.3.0

## 1.0.0

### Major Changes

- 30b9f98: Remove retired product IDs, origins, analytics products, and hosted widget brand presets from shared platform packages. This intentionally narrows product-id contracts for retired products.

## 0.3.3

### Patch Changes

- 5bb34db: Add idempotent double-mount guard to `createAiSdrWidget`. If a `[data-ai-sdr-widget]` root is already present in the document when `open()` or `startNewChat()` is called, the duplicate mount is silently skipped and `console.warn` fires once. Calling `destroy()` removes the root so a subsequent legitimate mount works. This prevents accidental double-init when the embed script is included twice on marketing pages.
- 117d5d2: Fix two brand-preset defects in the importable AI-SDR widget so it adapts to
  each product's branding consistently with the deployed hosted-client and
  @ventora/ai-cs:
  - camaudit now resolves accent `#1f5a52` (7.95:1 contrast on white, WCAG AA)
    instead of the low-contrast `#2f8379`.
    A mutual-distinctness regression test now guards that every shipped product
    resolves to a unique accent.

## 0.3.2

### Patch Changes

- 387c5eb: Harden backend and cross-language contracts found during the backend audit: Better Auth email/password and signup hook wiring, billing webhook classification parity, unsubscribe and storage token validation, and default HIPAA redaction coverage.

## 0.3.1

### Patch Changes

- Harden AI-SDR CTA link rendering against unsafe URL schemes and update DOM test dependencies to patched versions.

## 0.3.0

### Minor Changes

- a7adc85: Persist AI-SDR and AI-CS sessions across page loads and expose APIs for starting a fresh chat.

## 0.2.1

### Patch Changes

- 15f1787: Polish the embeddable AI SDR widget with rich message rendering, PostHog-compatible tracking, pill CTAs, message-id-safe streaming, stronger accessible labelling, and richer canonical plan pricing context.
- Updated dependencies [505e43f]
- Updated dependencies [15f1787]
  - @ventora/ai-sdr-contracts@0.2.1

## 0.2.0

### Minor Changes

- 200af29: Add shared AI-SDR contracts, HMAC/SSE helpers, and the browser client/widget package.

### Patch Changes

- Updated dependencies [200af29]
  - @ventora/ai-sdr-contracts@0.2.0

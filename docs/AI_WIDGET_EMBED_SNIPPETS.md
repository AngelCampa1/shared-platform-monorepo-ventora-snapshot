# AI-SDR / AI-CS Embed Snippets

Drop-in snippets for the hosted widgets and the `@ventora/ai-cs/react`
component. Use these to verify the widget in your product without leaving the
host shell.

The full integration contracts live in `docs/AI_SDR.md` and `docs/AI_CS.md`;
this file is the short reference for the embed surfaces only.

## 1. AI-SDR hosted widget (anonymous visitors)

The AI-SDR widget is a global bundle served by the Cloudflare Worker named
`ventora-ai-sdr-worker`. It mounts a launcher button and modal panel, and is
safe to load on public marketing pages.

```html
<!-- Anywhere in <body>. -->
<script src="https://ventora-ai-sdr-worker.example-account.workers.dev/client/ai-sdr.global.js" defer></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    window.AiSdr.init({
      baseUrl: "https://ventora-ai-sdr-worker.example-account.workers.dev",
      session: {
        productId: "lextract", // one of the brand presets, see below
        // visitorId: currentVisitor.id, // optional; defaults to anonymous storage
      },
      subtitle: "Replies in seconds",
      brand: {
        productName: "Lextract",
      },
      // Optional: pin a specific bundle for a stable rollout.
      // src="https://ventora-ai-sdr-worker.example-account.workers.dev/client/v0.3.7/ai-sdr.global.js"
    });
  });
</script>
```

Brand presets shipped with the hosted worker: `camaudit`, `capveri`,
`grantpipe`, `lextract`. All presets meet
WCAG AA contrast (>= 4.5:1) against the panel background.

CSS custom properties for full theming override:

```css
:root {
  --ai-sdr-accent: #1f5a52;
  --ai-sdr-accent-text: #ffffff;
  --ai-sdr-surface: #ffffff;
  --ai-sdr-text: #0f172a;
  --ai-sdr-radius-lg: 16px;
  --ai-sdr-radius-md: 12px;
}
```

### In-product verification checklist

1. Open the page, click the launcher - focus moves into the panel input.
2. Press `Esc` - panel closes, focus returns to the launcher.
3. Send a message - typing indicator and `aria-busy="true"` appear on the
   transcript; tokens stream in.
4. Click `Stop` mid-stream - request aborts, partial reply remains.
5. Disconnect the network, send again - error toast appears with a `Retry`
   action.
6. Click `Talk to a human` - handoff banner displays with the route from
   `handoff.status`.
7. With `prefers-reduced-motion: reduce`, animations are disabled.
8. Resize to 375 x 667 - panel fills `100dvh`, footer respects
   `env(safe-area-inset-bottom)`.

## 2. AI-CS hosted widget (authenticated app support)

The AI-CS hosted widget is a global bundle served by the Cloudflare Worker
named `ventora-ai-cs-worker`. It lives behind your auth boundary and will not
call the worker until your backend returns signed request details.

```html
<script src="https://ventora-ai-cs-worker.example-account.workers.dev/client/ai-cs.global.js" defer></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    window.AiCs.init({
      baseUrl: "https://ventora-ai-cs-worker.example-account.workers.dev",
      brand: { id: "lextract" },
      clientAssertion: {
        body: {
          appId: "lextract",
          userId: currentUser.id,
          currentPath: window.location.pathname,
        },
      },
      // Optional: pin a specific bundle for a stable rollout.
      // src="https://ventora-ai-cs-worker.example-account.workers.dev/client/v0.3.1/ai-cs.global.js"
      // Hosted widget contract: forward { path, body } to your backend and
      // return { body, headers } where headers contains the Ventora HMAC
      // assertion for that exact body.
      signRequest: async ({ path, body }) => {
        const res = await fetch("/api/ai-cs/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, body }),
        });
        // { body, headers: { "X-Ventora-Timestamp": "...", "X-Ventora-Nonce": "...", "X-Ventora-Signature": "..." } }
        return res.json();
      },
    });
  });
</script>
```

Events rendered by the AI-CS widget that AI-SDR does not handle:

- `source` - inline citation chips below the assistant message.
- `navigation.suggestion` - quick-action chip that calls
  `window.location.assign(target.path)` after URL allowlist checks.
- `workflow.step` - workflow status row in the panel header.
- `escalation` - replaces the composer with an escalation receipt banner.

### In-product verification checklist

Run the AI-SDR checklist plus:

9. Without `signRequest`, the widget should refuse to mount and surface a
   visible config error. Production must always sign.
10. Trigger a workflow step from your support flow - the header row updates
    live.
11. Click a navigation suggestion - host route changes.
12. Trigger an escalation - composer locks, banner shows the receipt id.

## 3. AI-CS React component (`@ventora/ai-cs/react`)

For React 18+ product apps the SDK ships a drop-in component that shares the
same DOM/CSS tokens as the hosted widget. Use it when you want lifecycle
control without juggling a global script.

```tsx
import { AiCsWidget } from "@ventora/ai-cs/react";

export function AppShell() {
  return (
    <>
      {/* ...rest of app... */}
      <AiCsWidget
        api={{
          baseUrl: "https://ventora-ai-cs-worker.example-account.workers.dev",
          signRequest: async ({ method, path, body }) => {
            const res = await fetch("/api/ai-cs/sign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ method, path, body }),
            });
            // React SDK contract: { timestamp, nonce, signature }.
            return res.json();
          },
        }}
        session={{
          appId: "lextract",
          userId: currentUser.id,
          currentPath: window.location.pathname,
        }}
      />
    </>
  );
}
```

For finer control, use the hook directly and render your own controls:

```tsx
import { useMemo, useState } from "react";
import { useAiCsWidget } from "@ventora/ai-cs/react";

export function SupportButton() {
  const [open, setOpen] = useState(false);
  const api = useMemo(() => ({
    baseUrl: "https://ventora-ai-cs-worker.example-account.workers.dev",
    signRequest,
  }), []);
  const session = useMemo(() => ({
    appId: "lextract",
    userId: currentUser.id,
    currentPath: window.location.pathname,
  }), [currentUser.id]);
  const widget = useAiCsWidget({
    api,
    session,
  });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Get help
      </button>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void widget.sendMessage(String(form.get("message") ?? ""));
            event.currentTarget.reset();
          }}
        >
          {widget.messages.map((message) => (
            <p key={message.id}>{message.content}</p>
          ))}
          <input name="message" aria-label="Message" />
          <button type="submit" disabled={widget.sending}>Send</button>
          <button type="button" onClick={() => setOpen(false)}>Close</button>
        </form>
      ) : null}
    </>
  );
}
```

### In-product verification checklist

Run the AI-CS hosted checklist. In addition:

13. Multiple `<AiCsWidget />` instances must not corrupt each other's focus
    trap; opening B inside A's tree should refcount inert siblings correctly
    when B closes.
14. `clearTurn()` from the hook resets the current streaming assistant turn
    without dropping the session.
15. Theme swap via `brand` prop re-renders without remount.

## Verification status (2026-05-18)

Browser-level Playwright verification was clean for both workers.

- AI-SDR: full functional, accessibility, responsive, resilience, and theming
  matrix passed.
- AI-CS: full matrix passed after two follow-up fixes: header control
  hit-targets bumped from 32px to 44px (WCAG 2.5.5), and `aria-busy`
  lifecycle added to the transcript element during streaming. A1-A6, R1-R3,
  RES1-RES3, and T1 all pass against the rebuilt `ai-cs.global.js`.

The in-product checklists above remain useful as a final smoke when embedding
into a specific consumer repo, but the platform-level verification gate is met.

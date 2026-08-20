# AI-CS Authenticated App Support Integration

This guide is the product-side contract for building AI customer support on top of the shared Ventora assistant protocol.

## Runtime Pieces

- `@ventora/ai-assistant-contracts`: shared assistant primitives for signed context payloads, HMAC verification, generic chat/session/escalation types, and SSE event validation.
- `@ventora/ai-cs-contracts`: AI-CS domain contracts for authenticated app support, navigation suggestions, workflow steps, and support escalation events.
- `@ventora/ai-cs`: browser-safe session, chat streaming, support escalation, and SSE parser helpers. It re-exports `@ventora/ai-cs-contracts`.
- `@ventora/ai-cs-worker`: private Cloudflare Worker runtime for AI-CS session, chat, context, and support escalation APIs. It is deployed separately from `@ventora/ai-sdr-worker`.
- `@ventora/ai-sdr-contracts`: AI-SDR remains sales-specific, but now layers shared protocol helpers from `@ventora/ai-assistant-contracts`.

AI-CS is scoped to authenticated product apps. Product servers remain the source of truth for what the assistant knows. Browser code should not receive context secrets and should not fetch the full support context directly.

## Authenticated App Context

Each product should expose a server-side AI-CS context endpoint that only responds after the product has authenticated the current user. The response body should match `AiCsAppContext`:

```ts
type AiCsAppContext = {
  assistantId: "ai-cs";
  appId: string;
  appName: string;
  authenticatedOnly: true;
  description?: string;
  currentPath?: string;
  sources?: Array<{ id: string; title: string; url: string; excerpt?: string }>;
  navigation?: Array<{ label: string; path: string; description?: string }>;
  workflow?: Array<{
    id: string;
    label: string;
    status: "completed" | "current" | "next";
    path?: string;
  }>;
};
```

The context should include only information the authenticated user is allowed to know in that app session. Do not include cross-tenant data, hidden admin details, secrets, raw credentials, billing processor tokens, or unrelated product marketing context.

## Signed Context Pattern

Use the shared HMAC helpers from `@ventora/ai-assistant-contracts` for the same signed context pattern used by AI-SDR:

```ts
import { buildHmacPayload, signHmacPayload, verifyHmacSignature } from "@ventora/ai-assistant-contracts";
```

The worker signs context requests, and the product signs context responses. Verification failures fail closed before model calls. Context endpoint URLs must be HTTPS.

## Client Assertion Pattern

Product servers must mint a short-lived signed assertion for every browser call to the AI-CS Worker. CORS is not an auth boundary; the Worker rejects session, chat, and escalation requests that do not include valid HMAC headers.

The browser request to the Worker must include:

```http
X-Ventora-Timestamp: <ISO timestamp>
X-Ventora-Nonce: <nonce>
X-Ventora-Signature: <64-char lowercase hex HMAC>
```

The product signs the exact Worker request body and path with `AI_CS_CLIENT_ASSERTION_SECRET`:

```ts
import { buildHmacPayload, signHmacPayload } from "@ventora/ai-assistant-contracts";

const timestamp = new Date().toISOString();
const nonce = crypto.randomUUID();
const body = {
  appId: "lextract",
  userId: currentUser.id,
  currentPath: location.pathname,
};
const payload = buildHmacPayload({
  timestamp,
  nonce,
  method: "POST",
  path: "/v1/sessions",
  body,
});

const headers = {
  "X-Ventora-Timestamp": timestamp,
  "X-Ventora-Nonce": nonce,
  "X-Ventora-Signature": signHmacPayload(payload, process.env.AI_CS_CLIENT_ASSERTION_SECRET),
};
```

For `/v1/chat` and `/v1/escalations`, sign the exact body being sent, including `sessionId`. The Worker also binds browser-created sessions to the original `Origin` header and rejects later chat or escalation calls from a different origin.

## Event Semantics

AI-CS supports generic assistant SSE events plus these domain events:

- `navigation.suggestion`: points the user to a route inside the authenticated app.
- `workflow.step`: identifies a completed, current, or next step in an app workflow.
- `support.escalation.requested`: records that the assistant needs a human support path.

AI-CS does not use AI-SDR sales events such as `plan.recommendation` or `trial.cta`.

## Browser Integration

Use `@ventora/ai-cs` from authenticated app surfaces that bundle shared packages:

```ts
import {
  createAiCsSession,
  sendAiCsChatMessage,
} from "@ventora/ai-cs";

const api = { baseUrl: "https://ventora-ai-cs-worker.example-account.workers.dev" };
const { sessionId } = await createAiCsSession(api, {
  appId: "lextract",
  userId: currentUser.id,
  currentPath: location.pathname,
}, {
  headers: await getAiCsAssertionHeaders("/v1/sessions", {
    appId: "lextract",
    userId: currentUser.id,
    currentPath: location.pathname,
  }),
});

await sendAiCsChatMessage(
  api,
  { sessionId, message: "Where do I update billing?", currentPath: location.pathname },
  {
    headers: await getAiCsAssertionHeaders("/v1/chat", {
      sessionId,
      message: "Where do I update billing?",
      currentPath: location.pathname,
    }),
    onEvent(event) {
      if (event.event === "navigation.suggestion") {
        renderRouteSuggestion(event.data.target);
      }
    },
  },
);
```

For a hosted script embed, load the pinned immutable Worker client and sign each
request through your product backend:

```html
<script src="https://ventora-ai-cs-worker.example-account.workers.dev/client/v0.3.1/ai-cs.global.js"></script>
<script>
  window.AiCs.init({
    baseUrl: "https://ventora-ai-cs-worker.example-account.workers.dev",
    clientAssertion: {
      body: {
        appId: "lextract",
        userId: currentUser.id,
        currentPath: location.pathname,
      },
    },
    signRequest: async ({ path, body }) => {
      const res = await fetch("/api/ai-cs/assertion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, body }),
      });
      if (!res.ok) throw new Error("AI-CS assertion failed");
      return await res.json();
    },
    brand: { id: "lextract" },
  });
</script>
```

## Capturing Escalations Server-Side (escalation-webhook receiver)

The Worker does **not** push an outbound webhook to the product. An escalation is
stored on the Worker session and acknowledged with `202 { escalationId, status:
"queued" }`; it is also surfaced to the browser as the `support.escalation.requested`
SSE event. To durably record the escalation (open a ticket, page on-call, write to
your support inbox), route the escalation request **through the product backend**
rather than calling the Worker directly from the browser. That product endpoint is
the "receiver": it persists the escalation first, then forwards to the Worker.

This reuses the same assertion-minting BFF the browser already calls, so no new auth
surface is introduced.

Browser → product BFF:

```ts
// Browser: when the user (or a support.escalation.requested event) requests a human,
// POST to your own backend, which owns the support record.
await fetch("/api/ai-cs/escalations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, reason, message, contact }),
});
```

Product backend receiver (Next.js App Router):

```ts
// app/api/ai-cs/escalations/route.ts
import { buildHmacPayload, signHmacPayload } from "@ventora/ai-assistant-contracts";

const WORKER = "https://ventora-ai-cs-worker.example-account.workers.dev";

export async function POST(req: Request) {
  const user = await requireAuthenticatedUser(req); // product's normal auth
  const { sessionId, reason, message, contact } = await req.json();

  // 1. Persist / open a support ticket FIRST: source of truth, independent of the Worker.
  await support.tickets.open({ userId: user.id, sessionId, reason, message, contact, source: "ai-cs" });
  // 2. Optionally notify on-call / support inbox here.

  // 3. Forward to the Worker so the session reflects the escalation (best-effort).
  const body = { sessionId, reason, message, contact };
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payload = buildHmacPayload({ timestamp, nonce, method: "POST", path: "/v1/escalations", body });
  const res = await fetch(`${WORKER}/v1/escalations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": req.headers.get("origin") ?? "",
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
      "X-Ventora-Signature": signHmacPayload(payload, process.env.AI_CS_CLIENT_ASSERTION_SECRET!),
    },
    body: JSON.stringify(body),
  });

  // The ticket is already open; treat a Worker non-202 as a soft warning, not a failure.
  return Response.json({ ok: true, workerStatus: res.status }, { status: 202 });
}
```

Key points:

- The product backend is the durable receiver; the Worker `202` is an acknowledgement, not a delivery guarantee.
- Persist/open the ticket before forwarding so a Worker outage never drops an escalation.
- The browser also receives `support.escalation.requested` over SSE. Use it for UI state (lock composer, show a receipt banner), not as the durable record.
- The browser never holds `AI_CS_CLIENT_ASSERTION_SECRET`; only the product backend signs. The Worker binds the session to its original `Origin`, so forward the same `Origin` header.

Copy-paste BFF route templates (session creation, chat proxy, escalation) live in
[integrations/bff-templates/](integrations/bff-templates/). Deployed Worker URLs are not
part of this published tree; point the templates at your own deployment.

## Readiness Checklist

- Product context endpoint requires the product's normal authenticated session.
- Product server mints per-request AI-CS client assertion headers; browser code never receives assertion secrets.
- Context response has `assistantId: "ai-cs"` and `authenticatedOnly: true`.
- Context includes only app/session-scoped knowledge the user can access.
- Requests and responses use shared HMAC helpers from `@ventora/ai-assistant-contracts`.
- Product imports `@ventora/ai-cs-contracts` for AI-CS event validation.
- Hosted embeds use `/client/v0.3.1/ai-cs.js` or `/client/v0.3.1/ai-cs.global.js`.
- Product renders navigation and workflow events as app actions, not marketing CTAs.

## Worker Deployment

Deploy AI-CS independently from AI-SDR:

```bash
pnpm --filter @ventora/ai-cs-worker run deploy
```

Set these Cloudflare secrets before enabling chat:

```bash
pnpm --filter @ventora/ai-cs-worker exec wrangler secret put OPENROUTER_API_KEY
pnpm --filter @ventora/ai-cs-worker exec wrangler secret put AI_CS_CLIENT_ASSERTION_SECRET
pnpm --filter @ventora/ai-cs-worker exec wrangler secret put AI_CS_CONTEXT_SECRET
pnpm --filter @ventora/ai-cs-worker exec wrangler secret put AI_CS_CONTEXT_ENDPOINTS
```

The Worker uses `AI_CS_*` bindings and secrets:

- `AI_CS_ALLOWED_ORIGINS`: comma-separated authenticated app origins. It is deny-by-default when unset and exact-match when set.
- `AI_CS_CLIENT_ASSERTION_SECRET`: HMAC secret product servers use to mint browser request assertions.
- `AI_CS_CONTEXT_SECRET`: HMAC secret shared with product context endpoints.
- `AI_CS_CONTEXT_ENDPOINTS`: JSON map of `appId` to signed HTTPS context endpoint URL, for example `{"lextract":"https://lextract.app/api/ai-cs/context"}`.
- `OPENROUTER_API_KEY`: model provider key for support responses.

Optional model routing overrides:

```bash
AI_CS_PRIMARY_MODEL=minimax/minimax-m3
AI_CS_PRIMARY_PROVIDERS=fireworks,together,morph
AI_CS_FALLBACK_MODEL=openai/gpt-5.4-nano
AI_CS_FALLBACK_PROVIDERS=openai,azure
```

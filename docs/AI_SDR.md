# AI-SDR Product Integration

This guide is the product-side contract for plugging a Ventora product into the shared AI-SDR runtime.

## Runtime Pieces

- `@ventora/ai-sdr-contracts`: shared protocol types, SSE event validators, stable JSON, and HMAC helpers.
- `@ventora/ai-sdr`: browser helpers and embeddable widget. It re-exports `@ventora/ai-sdr-contracts`.
- `@ventora/ai-sdr-worker`: private Cloudflare Worker runtime. It owns sessions, model routing, handoff state, and product context fetching.

Products remain the source of truth. Browser code never receives product context secrets and never fetches product context directly.

Products can integrate without npm by importing the browser helpers directly from the deployed Cloudflare Worker.

## Worker Configuration

Deploy the Worker from this repo:

```bash
pnpm --filter @ventora/ai-sdr-worker run deploy
```

Set these Cloudflare environment values before enabling chat in a product:

```bash
pnpm --filter @ventora/ai-sdr-worker exec wrangler secret put OPENROUTER_API_KEY
pnpm --filter @ventora/ai-sdr-worker exec wrangler secret put AI_SDR_CONTEXT_SECRET
pnpm --filter @ventora/ai-sdr-worker exec wrangler secret put AI_SDR_CONTEXT_ENDPOINTS
```

`AI_SDR_ALLOWED_ORIGINS` is deny-by-default when unset. Configure explicit product origins in `packages/ai-sdr-worker/wrangler.toml` or the Cloudflare dashboard before production rollout:

```toml
AI_SDR_ALLOWED_ORIGINS = "https://camaudit.io,https://www.camaudit.io,https://capveri.com,https://www.capveri.com,https://lextract.io,https://www.lextract.io"
```

Optional model routing overrides:

```bash
AI_SDR_PRIMARY_MODEL=minimax/minimax-m3
AI_SDR_PRIMARY_PROVIDERS=fireworks,together,morph
AI_SDR_FALLBACK_MODEL=openai/gpt-5.4-nano
AI_SDR_FALLBACK_PROVIDERS=openai,azure
AI_SDR_ESCALATION_MODEL=x-ai/grok-4.3
AI_SDR_ESCALATION_PROVIDERS=x-ai
AI_SDR_CONFIDENCE_THRESHOLD=0.72
```

The default OpenRouter model IDs were checked against OpenRouter pages on June 19, 2026:

- MiniMax M3: `minimax/minimax-m3`
- GPT-5.4 nano: `openai/gpt-5.4-nano`
- Grok 4.3: `x-ai/grok-4.3`

## Product Context Endpoint

Each product must expose a server-side context endpoint listed in `AI_SDR_CONTEXT_ENDPOINTS`, a JSON map from `productId` to endpoint URL. The legacy single `AI_SDR_CONTEXT_ENDPOINT` value remains supported only for one-product deployments. The Worker calls the selected endpoint as:

```http
GET /path?productId=<productId>
X-Ventora-Timestamp: <ISO timestamp>
X-Ventora-Nonce: <nonce>
X-Ventora-Signature: <64-char lowercase hex HMAC>
```

The product must verify the request signature using:

```ts
import { buildHmacPayload, verifyHmacSignature } from "@ventora/ai-sdr-contracts";

const body = { productId };
const payload = buildHmacPayload({
  timestamp,
  nonce,
  method: "GET",
  path: `/api/ai-sdr/context?productId=${encodeURIComponent(productId)}`,
  body,
});

const verification = verifyHmacSignature({
  payload,
  signature,
  secret: process.env.AI_SDR_CONTEXT_SECRET,
  timestamp,
});
```

The product response body must match `ProductContext`:

```ts
type ProductContext = {
  productId: string;
  name: string;
  description?: string;
  sources?: Array<{ id: string; title: string; url: string; excerpt?: string }>;
  plans?: Array<{
    id: string;
    name: string;
    price?: string;
    monthlyPrice?: string;
    annualPrice?: string;
    discount?: string;
    defaultCadence?: "month" | "year";
    trialDays?: number;
    ctaUrl?: string;
    features?: string[];
  }>;
};
```

Populate pricing from the product's own billing or pricing registry on every response. When a live offer exists, include it in `discount` exactly as it should be said, for example `50% off annual`. The Worker passes the signed context to the model as the single source of truth and emits `plan.recommendation.priceSummary` from these canonical plan fields.

The product must sign the response body with the same canonical payload shape:

```ts
import { buildHmacPayload, signHmacPayload } from "@ventora/ai-sdr-contracts";

const responsePayload = buildHmacPayload({
  timestamp,
  nonce,
  method: "GET",
  path: `/api/ai-sdr/context?productId=${encodeURIComponent(productId)}`,
  body: productContext,
});

const signature = signHmacPayload(responsePayload, process.env.AI_SDR_CONTEXT_SECRET);
```

Return:

```http
Content-Type: application/json
X-Ventora-Timestamp: <ISO timestamp>
X-Ventora-Nonce: <nonce>
X-Ventora-Signature: <64-char lowercase hex HMAC>
```

Invalid or missing signatures fail closed: `/v1/chat` returns `502` and the Worker does not call OpenRouter.

## Browser Integration

Use the Cloudflare-hosted ESM module:

```ts
import {
  createAiSdrSession,
  sendAiSdrChatMessage,
} from "https://ventora-ai-sdr-worker.example-account.workers.dev/client/v0.3.7/ai-sdr.js";
```

Or load the global build from a script tag:

```html
<script src="https://ventora-ai-sdr-worker.example-account.workers.dev/client/v0.3.7/ai-sdr.global.js"></script>
<script>
  const { createAiSdrWidget } = globalThis.VentoraAiSdr;
</script>
```

Versioned hosted files are served by Cloudflare with immutable caching. Unversioned aliases at `/client/ai-sdr.js` and `/client/ai-sdr.global.js` revalidate quickly so products can use them during early rollout. The hosted files contain only browser helpers. They do not include OpenRouter credentials, product context secrets, or product context fetching logic.

The npm package remains available for registry-based product builds after package publishing is configured:

```bash
pnpm add @ventora/ai-sdr
```

Create a session and stream chat events:

```ts
const api = { baseUrl: "https://ventora-ai-sdr-worker.example-account.workers.dev" };
const { sessionId } = await createAiSdrSession(api, {
  productId: "lextract",
  visitorId: "visitor_123",
  metadata: { entry: "pricing-page" },
});

await sendAiSdrChatMessage(
  api,
  { sessionId, message: "Which plan is best for my team?" },
  {
    onEvent(event) {
      if (event.event === "message.delta") {
        appendAssistantText(event.data.delta);
      }
      if (event.event === "source") {
        renderSource(event.data.source);
      }
    },
  },
);
```

Or mount the built-in widget:

```ts
const widget = createAiSdrWidget({
  target: document.querySelector("#ai-sdr")!,
  api: { baseUrl: "https://ventora-ai-sdr-worker.example-account.workers.dev" },
  session: { productId: "lextract" },
  callbacks: {
    onEvent(event) {
      console.log(event.event);
    },
    onError(error) {
      console.error(error);
    },
  },
});

await widget.open();
```

The widget emits unstyled semantic DOM with `data-ai-sdr-*` attributes so products can style it inside their own design systems.

## Public Worker API

`POST /v1/sessions`

```json
{ "productId": "lextract", "visitorId": "visitor_123", "metadata": { "entry": "pricing" } }
```

Returns `201`:

```json
{ "sessionId": "..." }
```

`POST /v1/chat`

```json
{ "sessionId": "...", "message": "Which plan should I use?" }
```

Returns `text/event-stream` with typed events from `AiSdrSseEvent`. Streams end with `message.done`.

`POST /v1/handoff`

```json
{
  "sessionId": "...",
  "reason": "demo",
  "message": "please contact me",
  "contact": { "email": "buyer@example.com" }
}
```

Returns `202`:

```json
{ "handoffId": "...", "status": "queued" }
```

Contact details are stored only when the user message asks to be contacted.

## Capturing Handoffs Server-Side (lead-handoff webhook)

The Worker does **not** push an outbound webhook to the product. A handoff is stored
on the Worker session and acknowledged with `202 { handoffId, status: "queued" }`.
That ack is the only signal the caller gets. To durably capture the lead in the
product's CRM/founder workflow, route the handoff request **through the product
backend** instead of calling the Worker directly from the browser. The product
endpoint is the "receiver": it persists the lead first, then forwards to the Worker.

This mirrors the assertion-minting BFF the browser already talks to, so no new auth
surface is introduced.

Browser → product BFF:

```ts
// Browser: when the widget emits a handoff intent, POST to your own backend,
// not to the Worker. Your backend owns the lead record.
await fetch("/api/ai-sdr/handoff", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, reason, message, contact }),
});
```

Product backend receiver (Next.js App Router):

```ts
// app/api/ai-sdr/handoff/route.ts
import { buildHmacPayload, signHmacPayload } from "@ventora/ai-assistant-contracts";

const WORKER = "https://ventora-ai-sdr-worker.example-account.workers.dev";

export async function POST(req: Request) {
  const { sessionId, reason, message, contact } = await req.json();

  // 1. Persist the lead FIRST: this is the source of truth, independent of the Worker.
  await db.leads.insert({ sessionId, reason, message, contact, source: "ai-sdr" });
  // 2. Optionally fan out to CRM / founder notification here (email, Slack, HubSpot…).

  // 3. Forward to the Worker so the session reflects the handoff (best-effort).
  const body = { sessionId, reason, message, contact };
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payload = buildHmacPayload({ timestamp, nonce, method: "POST", path: "/v1/handoff", body });
  const res = await fetch(`${WORKER}/v1/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
      "X-Ventora-Signature": signHmacPayload(payload, process.env.AI_SDR_CLIENT_ASSERTION_SECRET!),
    },
    body: JSON.stringify(body),
  });

  // The lead is already saved; treat a Worker non-202 as a soft warning, not a failure.
  return Response.json({ ok: true, workerStatus: res.status }, { status: 202 });
}
```

FastAPI equivalent. There is **no** Python assistant-contracts package, so Python
backends reimplement the signing primitive directly with `hashlib`/`hmac`. The
payload format must match `buildHmacPayload`/`signHmacPayload` exactly: a `.`-joined
string `timestamp.nonce.METHOD.path.sha256Hex(stableJson(body))`, then
HMAC-SHA256(secret, payload) as lowercase hex. `stableJson` is JSON with
recursively sorted keys and compact separators.

```python
# routes/ai_sdr_handoff.py
import os, json, uuid, hashlib, hmac
from datetime import datetime, timezone
import httpx
from fastapi import APIRouter, Request

router = APIRouter()
WORKER = "https://ventora-ai-sdr-worker.example-account.workers.dev"

def _stable_json(value) -> str:
    # Mirror TS stableJson: sorted keys, compact separators.
    return json.dumps(value, sort_keys=True, separators=(",", ":"))

def _build_hmac_payload(timestamp, nonce, method, path, body) -> str:
    body_hash = hashlib.sha256(_stable_json(body).encode()).hexdigest()
    return f"{timestamp}.{nonce}.{method.upper()}.{path}.{body_hash}"

def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

@router.post("/api/ai-sdr/handoff")
async def handoff(req: Request):
    body = await req.json()
    # 1. Persist the lead first (source of truth).
    await leads.insert(source="ai-sdr", **body)
    # 2. Forward to the Worker (best-effort).
    ts = datetime.now(timezone.utc).isoformat()
    nonce = str(uuid.uuid4())
    payload = _build_hmac_payload(ts, nonce, "POST", "/v1/handoff", body)
    sig = _sign(payload, os.environ["AI_SDR_CLIENT_ASSERTION_SECRET"])
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{WORKER}/v1/handoff",
            content=_stable_json(body),  # send the exact bytes that were signed
            headers={
                "content-type": "application/json",
                "X-Ventora-Timestamp": ts,
                "X-Ventora-Nonce": nonce,
                "X-Ventora-Signature": sig,
            },
        )
    return {"ok": True, "worker_status": res.status_code}
```

Key points:

- The product backend is the durable receiver; the Worker `202` is an acknowledgement, not a delivery guarantee.
- Persist before forwarding so a Worker outage never drops a lead.
- The browser never holds `AI_SDR_CLIENT_ASSERTION_SECRET`; only the product backend signs.

Copy-paste BFF route templates (session creation, chat proxy, handoff) live in
[integrations/bff-templates/](integrations/bff-templates/). Deployed Worker URLs are not
part of this published tree; point the templates at your own deployment.

## Readiness Checklist

- Product context endpoint verifies Worker request HMAC.
- Product context endpoint signs the response body.
- Worker has `OPENROUTER_API_KEY`, `AI_SDR_CONTEXT_SECRET`, and `AI_SDR_CONTEXT_ENDPOINTS` configured.
- `AI_SDR_ALLOWED_ORIGINS` includes every product app origin.
- Product imports `/client/v0.3.7/ai-sdr.js` or `/client/v0.3.7/ai-sdr.global.js` from the Worker.
- Product renders `source` and `plan.recommendation` events only from Worker SSE events.
- Product routes handoff receipts to its own CRM or founder-contact workflow.

When a product stops using the shared assistants, add its id to the
deny-list in the Workers and remove its origin and context endpoint-map
entry. The Workers reject sessions for denied ids with `403`, so a stale
embed fails closed rather than silently opening an unconfigured session.

// Reusable BFF route template — Next.js App Router.
//
// Mints HMAC client-assertion headers and proxies AI assistant calls to the deployed
// Worker. The assertion secret stays server-side; the browser only ever talks to these
// product routes. Defaults to AI-SDR; see the AI-CS notes inline.
//
// Place at e.g. app/api/ai-sdr/[...action]/route.ts, or split into per-action files.
//
// Required env:
//   AI_SDR_WORKER_URL              e.g. https://ventora-ai-sdr-worker.example-account.workers.dev
//   AI_SDR_CLIENT_ASSERTION_SECRET HMAC secret shared with the Worker
// For AI-CS, swap to AI_CS_WORKER_URL / AI_CS_CLIENT_ASSERTION_SECRET.

import { buildHmacPayload, signHmacPayload } from "@ventora/ai-assistant-contracts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const WORKER_URL = requireEnv("AI_SDR_WORKER_URL");
const ASSERTION_SECRET = requireEnv("AI_SDR_CLIENT_ASSERTION_SECRET");

type Json = Record<string, unknown>;

/**
 * Sign `body` for `path` and forward to the Worker. Returns the Worker's Response.
 * `origin` is only needed for AI-CS (the Worker binds sessions to their origin).
 */
async function proxyToWorker(path: string, body: Json, origin?: string): Promise<Response> {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payload = buildHmacPayload({ timestamp, nonce, method: "POST", path, body });
  const signature = signHmacPayload(payload, ASSERTION_SECRET);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Ventora-Timestamp": timestamp,
    "X-Ventora-Nonce": nonce,
    "X-Ventora-Signature": signature,
  };
  // AI-CS only: forward the original browser origin.
  if (origin) headers.Origin = origin;

  return fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** POST /api/ai-sdr/sessions — create a session. */
export async function createSession(req: Request): Promise<Response> {
  // Authenticate the product user first if this is an authenticated app (AI-CS):
  //   const user = await requireAuthenticatedUser(req)
  const incoming = (await req.json()) as Json;
  const body: Json = { ...incoming /*, userId: user.id (AI-CS) */ };
  const res = await proxyToWorker("/v1/sessions", body, req.headers.get("origin") ?? undefined);
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

/** POST /api/ai-sdr/chat — stream a chat turn. Pipe the SSE body straight through. */
export async function chat(req: Request): Promise<Response> {
  const body = (await req.json()) as Json;
  const res = await proxyToWorker("/v1/chat", body, req.headers.get("origin") ?? undefined);
  // Pass the text/event-stream through unbuffered.
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream" },
  });
}

/**
 * POST /api/ai-sdr/handoff — capture a lead, then forward to the Worker.
 * For AI-CS, change the path to "/v1/escalations" and open a support ticket instead.
 */
export async function handoff(req: Request): Promise<Response> {
  const body = (await req.json()) as Json;

  // 1. Persist the lead FIRST — durable source of truth, independent of the Worker.
  //    await db.leads.insert({ ...body, source: "ai-sdr" })
  // 2. Optionally notify CRM / founder / on-call here.

  // 3. Forward (best-effort). The lead is already saved.
  const res = await proxyToWorker("/v1/handoff", body, req.headers.get("origin") ?? undefined);
  return Response.json({ ok: true, workerStatus: res.status }, { status: 202 });
}

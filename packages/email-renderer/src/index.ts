import type { TemplateName } from "@ventora/email-templates";
import { verifyHmac } from "./hmac.js";

type Env = {
  RENDERER_HMAC_SECRET?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
};

type RenderRequest = {
  template: string;
  vars: Record<string, unknown>;
  timestamp?: string;
  nonce?: string;
  hmac?: string;
};

const RENDER_HMAC_WINDOW_MS = 5 * 60 * 1000;
// Best-effort isolate-local replay defense. Timestamp freshness remains the
// portable security boundary unless a shared Worker storage binding is added.
const consumedRenderSignatures = new Map<string, number>();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function allowsUnsignedRendering(env: Env): boolean {
  const mode = env.ENVIRONMENT ?? env.NODE_ENV;
  return mode === "local" || mode === "development" || mode === "test";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRenderRequest(value: unknown): RenderRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const { template, vars, timestamp, nonce, hmac } = value;
  if (
    typeof template !== "string" ||
    !isRecord(vars) ||
    (hmac !== undefined && typeof hmac !== "string")
  ) {
    return null;
  }
  const request: RenderRequest = { template, vars };
  if (typeof hmac === "string") {
    request.hmac = hmac;
  }
  if (typeof timestamp === "string") {
    request.timestamp = timestamp;
  }
  if (typeof nonce === "string") {
    request.nonce = nonce;
  }
  return request;
}

function renderHmacPayload(body: RenderRequest): string | null {
  if (!body.timestamp || !body.nonce) {
    return null;
  }
  return JSON.stringify({
    timestamp: body.timestamp,
    nonce: body.nonce,
    method: "POST",
    path: "/render",
    body: { template: body.template, vars: body.vars },
  });
}

function hasFreshTimestamp(timestamp: string): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Math.abs(Date.now() - parsed) <= RENDER_HMAC_WINDOW_MS;
}

function consumeRenderSignature(timestamp: string, nonce: string, hmac: string): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of consumedRenderSignatures) {
    if (expiresAt <= now) {
      consumedRenderSignatures.delete(key);
    }
  }
  const key = `${timestamp}:${nonce}:${hmac}`;
  if (consumedRenderSignatures.has(key)) {
    return false;
  }
  consumedRenderSignatures.set(key, now + RENDER_HMAC_WINDOW_MS);
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (new URL(request.url).pathname !== "/render") {
      return new Response("Not Found", { status: 404 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }
    const body = parseRenderRequest(rawBody);
    if (body === null) {
      return jsonResponse({ error: "Invalid render request" }, 400);
    }

    if (env.RENDERER_HMAC_SECRET) {
      const payload = renderHmacPayload(body);
      const valid =
        payload !== null &&
        body.timestamp !== undefined &&
        body.nonce !== undefined &&
        body.hmac !== undefined &&
        hasFreshTimestamp(body.timestamp) &&
        (await verifyHmac(payload, body.hmac, env.RENDERER_HMAC_SECRET)) &&
        consumeRenderSignature(body.timestamp, body.nonce, body.hmac);
      if (!valid) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    } else if (!allowsUnsignedRendering(env)) {
      return jsonResponse({ error: "Renderer HMAC secret is not configured" }, 500);
    }

    try {
      const { render } = await import("@ventora/email-templates");
      const result = await render(body.template as TemplateName, body.vars);
      return jsonResponse(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse({ error: message }, 422);
    }
  },
};

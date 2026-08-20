import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  type ProductContext,
  type StableJsonValue,
  buildHmacPayload,
  signHmacPayload,
} from "@ventora/ai-sdr-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, {
  AiSdrSession,
  DurableObjectSessionStore,
  MemorySessionStore,
  allowsLocalEndpoint,
  buildOpenRouterPayload,
  fetchSignedProductContext,
  handleChat,
  handleHandoff,
  handleSessionCreate,
  openRouterEndpoint,
  openRouterTimeoutMs,
  parseSse,
  selectRoute,
} from "../index.js";

const contextSecret = "context-secret";
const clientAssertionSecret = "client-assertion-secret";
const product: ProductContext = {
  productId: "prod_123",
  name: "Ventora Rooms",
  description: "Automated leasing follow-up for multifamily teams.",
  sources: [
    {
      id: "src_1",
      title: "Pricing",
      url: "https://example.com/pricing",
      excerpt: "Pro trial available.",
    },
  ],
  plans: [{ id: "pro", name: "Pro", price: "$199", features: ["AI follow-up", "CRM sync"] }],
};

const baseEnv = {
  AI_SDR_CONTEXT_SECRET: contextSecret,
  AI_SDR_CONTEXT_ENDPOINT: "https://product.example.com/context",
  OPENROUTER_API_KEY: "openrouter-key",
  OPENROUTER_ENDPOINT: "https://openrouter.ai/api/v1/chat/completions",
  AI_SDR_ALLOWED_ORIGINS: "https://product.example.com",
  AI_SDR_PRIMARY_MODEL: "minimax/minimax-m3",
  AI_SDR_PRIMARY_PROVIDERS: "",
  AI_SDR_FALLBACK_MODEL: "minimax/minimax-m3",
  AI_SDR_FALLBACK_PROVIDERS: "",
  AI_SDR_ESCALATION_MODEL: "minimax/minimax-m3",
  AI_SDR_ESCALATION_PROVIDERS: "",
  AI_SDR_CONFIDENCE_THRESHOLD: "0.72",
};

let clientNonceCounter = 0;

function jsonRequest(path: string, body: unknown, origin = "https://product.example.com"): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function signedJsonRequest(
  path: string,
  body: Record<string, unknown>,
  options: { origin?: string; timestamp?: string; nonce?: string } = {},
): Request {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const nonce = options.nonce ?? `client-nonce-${++clientNonceCounter}`;
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: "POST",
    path,
    body: body as StableJsonValue,
  });
  const signature = signHmacPayload(payload, clientAssertionSecret);
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin ?? "https://product.example.com",
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
      "X-Ventora-Signature": signature,
    },
    body: JSON.stringify(body),
  });
}

function signedContextResponse(
  body: ProductContext,
  path = "/context?productId=prod_123",
): Response {
  const timestamp = new Date().toISOString();
  const nonce = "nonce-1";
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: "GET",
    path,
    body: body as unknown as Record<string, never>,
  });
  const signature = signHmacPayload(payload, contextSecret);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
      "X-Ventora-Signature": signature,
    },
  });
}

describe("ai-sdr worker routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /health returns ok", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/health"), baseEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("handles browser CORS preflight and response headers for allowed product origins", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_ALLOWED_ORIGINS: "https://lextract.example.com,https://grantpipe.example.com",
    };
    const preflight = await worker.fetch(
      new Request("https://worker.example.com/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "https://lextract.example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
      env,
    );

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://lextract.example.com",
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("content-type");
    expect(preflight.headers.get("Vary")).toBe("Origin");

    const created = await worker.fetch(
      new Request("https://worker.example.com/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://lextract.example.com" },
        body: JSON.stringify({ productId: "prod_123" }),
      }),
      env,
    );
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("https://lextract.example.com");

    const blocked = await worker.fetch(
      new Request("https://worker.example.com/v1/sessions", {
        method: "OPTIONS",
        headers: { Origin: "https://unknown.example.com" },
      }),
      env,
    );
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows the production CapVeri app origin in worker config", () => {
    const wrangler = readFileSync("wrangler.toml", "utf8");
    const origins = wrangler.match(/^AI_SDR_ALLOWED_ORIGINS = "([^"]+)"/m)?.[1]?.split(",") ?? [];

    expect(origins).toContain("https://app.capveri.com");
  });

  it("excludes every retired GrantPipe origin from worker config", () => {
    const wrangler = readFileSync("wrangler.toml", "utf8");
    const origins = wrangler.match(/^AI_SDR_ALLOWED_ORIGINS = "([^"]+)"/m)?.[1]?.split(",") ?? [];

    expect(origins).not.toContain("https://grantpipe.app");
    expect(origins).not.toContain("https://www.grantpipe.app");
    expect(origins).not.toContain("https://grantpipe.com");
    expect(origins).not.toContain("https://www.grantpipe.com");
    expect(origins.some((origin) => origin.includes("grantpipe"))).toBe(false);
  });

  it.each([
    "https://grantpipe.app",
    "https://www.grantpipe.app",
    "https://grantpipe.com",
    "https://www.grantpipe.com",
  ])("rejects the retired GrantPipe origin %s", async (origin) => {
    const wrangler = readFileSync("wrangler.toml", "utf8");
    const allowedOrigins = wrangler.match(/^AI_SDR_ALLOWED_ORIGINS = "([^"]+)"/m)?.[1] ?? "";
    const response = await worker.fetch(
      jsonRequest("/v1/sessions", { productId: "grantpipe" }, origin),
      { ...baseEnv, ENVIRONMENT: "test", AI_SDR_ALLOWED_ORIGINS: allowedOrigins },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden origin" });
  });

  it("denies retired GrantPipe sessions submitted from an allowed sibling origin", async () => {
    const response = await worker.fetch(
      signedJsonRequest(
        "/v1/sessions",
        { productId: " GrAnTpIpE " },
        { origin: "https://www.capveri.com" },
      ),
      {
        ...baseEnv,
        ENVIRONMENT: "production",
        AI_SDR_ALLOWED_ORIGINS: "https://www.capveri.com",
        AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret,
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Product retired" });
  });

  it("rejects state-changing requests from missing or disallowed origins", async () => {
    const missingOrigin = await worker.fetch(
      new Request("https://worker.example.com/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: "prod_123" }),
      }),
      baseEnv,
    );
    expect(missingOrigin.status).toBe(403);

    const disallowedOrigin = await worker.fetch(
      jsonRequest("/v1/sessions", { productId: "prod_123" }, "https://evil.example.com"),
      baseEnv,
    );
    expect(disallowedOrigin.status).toBe(403);
  });

  it("returns a CORS-readable 403 body for disallowed origins so the browser can read it", async () => {
    const disallowedOrigin = await worker.fetch(
      jsonRequest("/v1/chat", { sessionId: "s1", message: "hi" }, "https://evil.example.com"),
      baseEnv,
    );
    expect(disallowedOrigin.status).toBe(403);
    // The 403 echoes the requesting origin (consistent with the allowed-origin
    // path) so the cross-origin browser can read the error body instead of
    // seeing an opaque CORS failure. No credentials are exposed.
    expect(disallowedOrigin.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://evil.example.com",
    );
    expect(await disallowedOrigin.json()).toEqual({ error: "Forbidden origin" });
  });

  it("fails closed for unsigned production requests when client assertions are not configured", async () => {
    const response = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
      ...baseEnv,
      ENVIRONMENT: "production",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid client assertion" });
  });

  it("fails closed for unsigned requests when runtime mode is unset", async () => {
    const response = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
      ...baseEnv,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid client assertion" });
  });

  it("allows unsigned requests only in explicit local, development, or test modes", async () => {
    for (const mode of ["local", "development", "test"] as const) {
      const response = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
        ...baseEnv,
        ENVIRONMENT: mode,
      });
      expect(response.status).toBe(201);
    }
  });

  it("rejects unsigned or replayed signed client assertions when configured", async () => {
    const env = { ...baseEnv, AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret };
    const unsigned = await worker.fetch(
      jsonRequest("/v1/sessions", { productId: "prod_123" }),
      env,
    );
    expect(unsigned.status).toBe(401);
    await expect(unsigned.json()).resolves.toEqual({ error: "Invalid client assertion" });

    const timestamp = new Date().toISOString();
    const nonce = "single-use-nonce";
    const first = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { timestamp, nonce }),
      env,
    );
    expect(first.status).toBe(201);

    const replay = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { timestamp, nonce }),
      env,
    );
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "Invalid client assertion" });

    const secondTimestamp = new Date(Date.now() + 1_000).toISOString();
    const secondNonce = "single-use-nonce-different-body";
    const firstBody = { productId: "prod_123", metadata: { intent: "first" } };
    const secondBody = { productId: "prod_123", metadata: { intent: "second" } };
    const firstDifferentBody = await worker.fetch(
      signedJsonRequest("/v1/sessions", firstBody, {
        timestamp: secondTimestamp,
        nonce: secondNonce,
      }),
      env,
    );
    const replayDifferentBody = await worker.fetch(
      signedJsonRequest("/v1/sessions", secondBody, {
        timestamp: secondTimestamp,
        nonce: secondNonce,
      }),
      env,
    );
    expect(firstDifferentBody.status).toBe(201);
    expect(replayDifferentBody.status).toBe(401);
    await expect(replayDifferentBody.json()).resolves.toEqual({
      error: "Invalid client assertion",
    });
  });

  it("accepts signed CapVeri SDR sessions from the canonical marketing origin", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_ALLOWED_ORIGINS: "https://www.capveri.com",
      AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret,
    };
    const response = await worker.fetch(
      signedJsonRequest(
        "/v1/sessions",
        { productId: "capveri" },
        { origin: "https://www.capveri.com" },
      ),
      env,
    );

    expect(response.status).toBe(201);
  });

  it("stores client assertion replays in the Durable Object binding when available", async () => {
    const session = {
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    };
    const durableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Client assertion replay" }), {
          status: 409,
        }),
      );
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: durableFetch })),
    } as unknown as DurableObjectNamespace;
    const env = {
      ...baseEnv,
      AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret,
      AI_SDR_SESSIONS: namespace,
    };

    const first = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { nonce: "durable-nonce-1" }),
      env,
    );
    const replay = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { nonce: "durable-nonce-2" }),
      env,
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(401);
    expect(namespace.idFromName).toHaveBeenCalledWith("__client_assertions__");
    expect(durableFetch).toHaveBeenCalledWith(
      "https://ai-sdr-session/consume-client-assertion",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("prunes expired in-memory client assertions before accepting a new assertion", async () => {
    vi.useFakeTimers();
    try {
      const env = { ...baseEnv, AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret };
      const firstNow = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(firstNow);
      const first = await worker.fetch(
        signedJsonRequest(
          "/v1/sessions",
          { productId: "prod_123" },
          { timestamp: firstNow.toISOString(), nonce: "expiring-nonce" },
        ),
        env,
      );
      expect(first.status).toBe(201);

      const later = new Date(firstNow.getTime() + 6 * 60 * 1000);
      vi.setSystemTime(later);
      const second = await worker.fetch(
        signedJsonRequest(
          "/v1/sessions",
          { productId: "prod_123" },
          { timestamp: later.toISOString(), nonce: "fresh-nonce" },
        ),
        env,
      );
      expect(second.status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit CORS headers when allowed origins are not configured", async () => {
    const { AI_SDR_ALLOWED_ORIGINS: _allowedOrigins, ...envWithoutAllowedOrigins } = baseEnv;
    const response = await worker.fetch(
      new Request("https://worker.example.com/health", {
        headers: { Origin: "https://product.example.com" },
      }),
      envWithoutAllowedOrigins,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("serves Cloudflare-hosted browser modules for npm-free product integration", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const currentVersionedModuleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.1/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const currentVersionedGlobalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.1/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );

    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    expect(moduleResponse.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://product.example.com",
    );
    const moduleScript = await moduleResponse.text();
    expect(moduleScript).toContain("export {");
    expect(moduleScript).toContain("createAiSdrWidget");
    expect(moduleScript).toContain("startNewChat");
    expect(moduleScript).toContain("aiSdrSessionStoreKey");
    expect(moduleScript).toContain("sendAiSdrChatMessage");
    expect(moduleScript).toContain('document.createElement("h2")');
    expect(moduleScript).toContain('transcript.setAttribute("aria-labelledby", widgetIds.heading)');
    expect(moduleScript).toContain('composer.setAttribute("aria-describedby", widgetIds.describe)');
    expect(moduleScript).toContain("try {\n      posthog?.capture(event, {");
    expect(moduleScript).toContain("} catch {\n");
    expect(moduleScript).toContain(
      'subtitle: typeof config.subtitle === "string" ? config.subtitle : undefined',
    );
    expect(moduleScript).not.toContain("OPENROUTER_API_KEY");
    expect(moduleScript).not.toContain("AI_SDR_CONTEXT_SECRET");

    expect(currentVersionedModuleResponse.status).toBe(200);
    expect(currentVersionedModuleResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await currentVersionedModuleResponse.text()).toBe(moduleScript);
    const importedModule = (await import(
      `data:text/javascript;base64,${Buffer.from(moduleScript).toString("base64")}`
    )) as {
      createAiSdrSession: (
        config: { baseUrl: string; fetch: typeof fetch },
        request: { productId: string },
      ) => Promise<{ sessionId: string }>;
      createAiSdrSseParser: () => {
        feed(chunk: string): Array<{ event: string; data: unknown }>;
      };
      createAiSdrWidget: (options: {
        api: { baseUrl: string; fetch: typeof fetch };
        session: { productId: string; visitorId?: string };
        target: unknown;
      }) => { startNewChat: () => Promise<void> };
    };
    await expect(
      importedModule.createAiSdrSession(
        {
          baseUrl: "https://worker.example.com",
          fetch: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ sessionId: "sess_hosted" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        },
        { productId: "prod_123" },
      ),
    ).resolves.toEqual({ sessionId: "sess_hosted" });
    expect(
      importedModule.createAiSdrSseParser().feed('event: heartbeat\ndata: {"timestamp":"now"}\n\n'),
    ).toEqual([{ event: "heartbeat", data: { timestamp: "now" } }]);
    expect(
      importedModule.createAiSdrWidget({
        api: { baseUrl: "https://worker.example.com", fetch: vi.fn<typeof fetch>() },
        session: { productId: "prod_123", visitorId: "visitor_1" },
        target: {},
      }).startNewChat,
    ).toEqual(expect.any(Function));

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Content-Type")).toContain("text/javascript");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.VentoraAiSdr");
    expect(globalScript).toContain("createAiSdrWidget");
    expect(globalScript).toContain("startNewChat");
    expect(globalScript).not.toContain("AI_SDR_CONTEXT_SECRET");
    expect(currentVersionedGlobalResponse.status).toBe(200);
    expect(currentVersionedGlobalResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await currentVersionedGlobalResponse.text()).toBe(globalScript);
    const sandbox = { globalThis: {} as Record<string, unknown> };
    vm.runInNewContext(globalScript, sandbox);
    expect(sandbox.globalThis.VentoraAiSdr).toMatchObject({
      createAiSdrWidget: expect.any(Function),
      sendAiSdrChatMessage: expect.any(Function),
    });
  });

  it("serves the v0.3.2 client (launcher-on-init fix) under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.2/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.2/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    // v0.3.2 carries the current client, including the launcher-on-init mount.
    expect(moduleScript).toContain("ensureRoot()");
    expect(moduleScript).toContain("startNewChat");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.AiSdr = { init: aiSdrInit }");
  });

  it("serves the v0.3.3 client (closed-panel non-interactive fix) under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.3/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.3/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    // v0.3.3 carries the eager launcher mount AND the closed-panel hardening so
    // the hidden panel can no longer overlay the launcher and swallow clicks.
    expect(moduleScript).toContain("ensureRoot()");
    expect(moduleScript).toContain('[data-ai-sdr-panel][data-state="open"]');
    expect(moduleScript).toContain("visibility:visible;pointer-events:auto;");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.AiSdr = { init: aiSdrInit }");
    expect(globalScript).toContain("visibility:visible;pointer-events:auto;");
  });

  it("serves the v0.3.4 client (session recovery fix) under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.4/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.4/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    // v0.3.4 carries the session-recovery logic for returning visitors with evicted sessions.
    expect(moduleScript).toContain("ensureRoot()");
    expect(moduleScript).toContain("clearStoredSessionId");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.AiSdr = { init: aiSdrInit }");
    expect(globalScript).toContain("clearStoredSessionId");
  });

  it("serves the v0.3.5 client (offline send guard) under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.5/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.5/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    // v0.3.5 carries the offline send guard plus the prior session-recovery logic.
    expect(moduleScript).toContain("showOfflineBanner");
    expect(moduleScript).toContain("clearStoredSessionId");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.AiSdr = { init: aiSdrInit }");
    expect(globalScript).toContain("showOfflineBanner");
  });

  it("serves the v0.3.6 client (mid-stream finalize) under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.6/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.6/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Content-Type")).toContain("text/javascript");
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    // v0.3.6 finalizes orphaned streaming bubbles when a send fails mid-stream.
    expect(moduleScript).toContain("finalizeStreamingMessages");
    expect(moduleScript).toContain("showOfflineBanner");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).toContain("globalThis.AiSdr = { init: aiSdrInit }");
    expect(globalScript).toContain("finalizeStreamingMessages");
  });

  it("serves the v0.3.7 client under a fresh immutable version path", async () => {
    const moduleResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.7/ai-sdr.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );
    const globalResponse = await worker.fetch(
      new Request("https://worker.example.com/client/v0.3.7/ai-sdr.global.js", {
        headers: { Origin: "https://product.example.com" },
      }),
      baseEnv,
    );

    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const moduleScript = await moduleResponse.text();
    expect(moduleScript).not.toContain("Talk to founder");
    expect(moduleScript).toContain("Need help?");

    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const globalScript = await globalResponse.text();
    expect(globalScript).not.toContain("Talk to founder");
    expect(globalScript).toContain("Need help?");
  });

  it("default fetch dispatches session creation and unknown routes", async () => {
    const created = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
      ...baseEnv,
      ENVIRONMENT: "test",
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as { sessionId: string }).toHaveProperty("sessionId");

    const missing = await worker.fetch(new Request("https://worker.example.com/missing"), baseEnv);
    expect(missing.status).toBe(404);
  });

  it("default fetch uses the Durable Object binding when available", async () => {
    const durableFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          session: {
            id: "sess_from_do",
            productId: "prod_123",
            metadata: {},
            transcript: [],
            handoff: { requested: false },
            createdAt: Date.now(),
            expiresAt: Date.now() + 10_000,
          },
        }),
      ),
    );
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: durableFetch })),
    } as unknown as DurableObjectNamespace;

    const created = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
      ...baseEnv,
      ENVIRONMENT: "test",
      AI_SDR_SESSIONS: namespace,
    });

    await expect(created.json()).resolves.toEqual({ sessionId: "sess_from_do" });
    expect(namespace.idFromName).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{24}$/));
    expect(durableFetch).toHaveBeenCalledWith(
      "https://ai-sdr-session/create",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("default fetch dispatches chat and handoff routes", async () => {
    const created = await worker.fetch(jsonRequest("/v1/sessions", { productId: "prod_123" }), {
      ...baseEnv,
      ENVIRONMENT: "test",
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const handoff = await worker.fetch(
      jsonRequest("/v1/handoff", { sessionId, message: "please contact me" }),
      { ...baseEnv, ENVIRONMENT: "test" },
    );
    expect(handoff.status).toBe(202);

    const chat = await worker.fetch(
      jsonRequest("/v1/chat", { sessionId, message: "continuous development forever" }),
      { ...baseEnv, ENVIRONMENT: "test" },
    );
    expect(parseSse(await chat.text())[0]?.event).toBe("message.delta");
  });

  it("rejects handoff from a different allowed origin than the session creator", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_ALLOWED_ORIGINS: "https://lextract.example.com,https://lextract.example.com",
    };
    const created = await worker.fetch(
      jsonRequest("/v1/sessions", { productId: "prod_123" }, "https://lextract.example.com"),
      env,
    );
    const { sessionId } = (await created.json()) as { sessionId: string };

    const response = await worker.fetch(
      jsonRequest(
        "/v1/handoff",
        { sessionId, message: "please contact me" },
        "https://grantpipe.example.com",
      ),
      env,
    );

    expect(response.status).toBe(403);
  });

  it("POST /v1/sessions creates a session with sanitized metadata", async () => {
    const store = new MemorySessionStore();
    const response = await handleSessionCreate(
      jsonRequest("/v1/sessions", {
        productId: "prod_123",
        visitorId: "visitor-1",
        metadata: { email: "person@example.com", note: "call 555-123-4567" },
      }),
      baseEnv,
      store,
      () => "sess_1",
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ sessionId: "sess_1" });
    expect(store.get("sess_1")?.metadata).toEqual({
      email: "[redacted-email]",
      note: "call [redacted-phone]",
    });
    expect(store.get("sess_1")?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("POST /v1/sessions rejects invalid JSON or missing product id", async () => {
    const store = new MemorySessionStore();
    expect(
      (
        await handleSessionCreate(
          new Request("https://worker.example.com/v1/sessions", { method: "POST", body: "{" }),
          baseEnv,
          store,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSessionCreate(
          jsonRequest("/v1/sessions", { visitorId: "visitor-1" }),
          baseEnv,
          store,
        )
      ).status,
    ).toBe(400);
  });

  it.each(["grantpipe", " GrAnTpIpE "])(
    "POST /v1/sessions denies the retired product id %j",
    async (productId) => {
      const store = new MemorySessionStore();
      const response = await handleSessionCreate(
        jsonRequest("/v1/sessions", { productId }),
        baseEnv,
        store,
        () => "retired_session",
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "Product retired" });
      expect(store.get("retired_session")).toBeUndefined();
    },
  );

  it("POST /v1/chat denies a normalized retired product session before external calls", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "retired_chat",
      { productId: " GrAnTpIpE ", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "retired_chat", message: "hello" }),
      baseEnv,
      store,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Product retired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get("retired_chat")?.transcript).toEqual([]);
  });

  it("POST /v1/handoff denies a normalized retired product session", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "retired_handoff",
      { productId: " GrAnTpIpE ", origin: "https://product.example.com" },
      86_400,
    );

    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "retired_handoff", message: "contact me" }),
      baseEnv,
      store,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Product retired" });
    expect(store.get("retired_handoff")?.handoff.requested).toBe(false);
  });

  it("POST /v1/chat fetches signed context, streams SSE deltas, and stores raw transcript content for the lead extractor", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "pro",
                name: "Pro",
                price: "$199",
                trialDays: 14,
                ctaUrl: "https://example.com/start",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Ventora fits your leasing workflow." } }],
              usage: { total_tokens: 42 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", {
        sessionId: "sess_1",
        message: "Email me at person@example.com about pricing",
      }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(parseSse(await response.text())).toEqual([
      { event: "source", data: { source: product.sources?.[0] } },
      {
        event: "plan.recommendation",
        data: {
          recommendation: {
            planId: "pro",
            reason: "Recommended from signed product plan context.",
            priceSummary: "$199",
            confidence: 0.65,
          },
        },
      },
      {
        event: "message.delta",
        data: { messageId: "msg_1", delta: "Ventora fits your leasing workflow." },
      },
      { event: "message.done", data: { messageId: "msg_1" } },
    ]);
    // The transcript stores RAW content (real email) because the lead extractor
    // reads it to capture the prospect's contact. Redaction happens only at the
    // telemetry/log boundaries, which never receive transcript content.
    expect(store.get("sess_1")?.transcript.at(0)?.content).toBe(
      "Email me at person@example.com about pricing",
    );
  });

  it("POST /v1/chat forwards streamed OpenRouter deltas as SSE chunks", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "pro",
                name: "Pro",
                price: "$199",
                trialDays: 14,
                ctaUrl: "https://example.com/start",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Streaming "}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_stream",
    );

    expect(response.body).not.toBeNull();
    const events = parseSse(await response.text()).filter(
      (event) => event.event === "message.delta",
    );
    expect(events).toEqual([
      { event: "message.delta", data: { messageId: "msg_stream", delta: "Streaming " } },
      { event: "message.delta", data: { messageId: "msg_stream", delta: "answer" } },
    ]);
    expect(store.get("sess_1")?.transcript.at(-1)?.content).toBe("Streaming answer");
  });

  it("POST /v1/chat handles split stream frames and ignores malformed stream payloads", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"split"}}]}\n\n'),
                );
                controller.enqueue(encoder.encode('data: {}\n\ndata: {"choices":[]}\n\n'));
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":" tail"}}]}'),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_split",
    );

    expect(
      parseSse(await response.text()).filter((event) => event.event === "message.delta"),
    ).toEqual([
      { event: "message.delta", data: { messageId: "msg_split", delta: "split" } },
      { event: "message.delta", data: { messageId: "msg_split", delta: " tail" } },
    ]);
  });

  it("POST /v1/chat skips a non-JSON stream frame without poisoning the rest of the stream", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"before"}}]}\n\n'),
                );
                // Non-JSON payload (e.g. a Cloudflare HTML error frame) that
                // would throw in JSON.parse and previously poisoned the stream.
                controller.enqueue(encoder.encode("data: <html>502</html>\n\n"));
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":" after"}}]}\n\n'),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_bad",
    );

    expect(
      parseSse(await response.text()).filter((event) => event.event === "message.delta"),
    ).toEqual([
      { event: "message.delta", data: { messageId: "msg_bad", delta: "before" } },
      { event: "message.delta", data: { messageId: "msg_bad", delta: " after" } },
    ]);
    expect(store.get("sess_1")?.transcript.at(-1)?.content).toBe("before after");
  });

  it("POST /v1/chat fails safely when product context signature is invalid", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(product), { status: 200 })),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing?" }),
      baseEnv,
      store,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Product context unavailable" });
  });

  it("POST /v1/chat returns validation and missing-session errors", async () => {
    const store = new MemorySessionStore();
    const invalid = await handleChat(
      new Request("https://worker.example.com/v1/chat", { method: "POST", body: "{" }),
      baseEnv,
      store,
    );
    expect(invalid.status).toBe(400);

    const missing = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "missing", message: "hi" }),
      baseEnv,
      store,
    );
    expect(missing.status).toBe(404);
  });

  it("emits source and plan.recommendation exactly once on a streamed turn", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [{ id: "pro", name: "Pro", price: "$199", trialDays: 14 }],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_once",
    );

    const events = parseSse(await response.text());
    expect(events.filter((event) => event.event === "source")).toHaveLength(1);
    expect(events.filter((event) => event.event === "plan.recommendation")).toHaveLength(1);
    expect(events.filter((event) => event.event === "message.done")).toHaveLength(1);
  });

  it("emits source and plan.recommendation exactly once on a non-streamed turn", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [{ id: "pro", name: "Pro", price: "$199", trialDays: 14 }],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Pricing details." } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_once_2",
    );

    const events = parseSse(await response.text());
    expect(events.filter((event) => event.event === "source")).toHaveLength(1);
    expect(events.filter((event) => event.event === "plan.recommendation")).toHaveLength(1);
  });

  it("never emits an empty planId when a signed plan omits its id", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            // A validly-signed context can omit a plan id (the HMAC validator only
            // enforces productId + name). The recommendation must not leak planId: "".
            plans: [{ name: "Pro", price: "$199", trialDays: 14 }],
          } as unknown as ProductContext),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Pricing details." } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_no_plan_id",
    );

    const events = parseSse(await response.text());
    const recommendation = events.find((event) => event.event === "plan.recommendation");
    expect(recommendation).toBeDefined();
    const data = recommendation?.data as { recommendation?: Record<string, unknown> };
    const planId = data.recommendation?.planId;
    expect(planId).not.toBe("");
    if (planId !== undefined) {
      expect(typeof planId).toBe("string");
      expect((planId as string).length).toBeGreaterThan(0);
    }
  });

  it("emits a terminal error and message.done when the stream fails mid-flight", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    let firstDeltaSent = false;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const encoder = new TextEncoder();
                if (!firstDeltaSent) {
                  firstDeltaSent = true;
                  controller.enqueue(
                    encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'),
                  );
                  return;
                }
                controller.error(new Error("upstream dropped"));
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_midfail",
    );

    const events = parseSse(await response.text());
    const errorEvent = events.find((event) => event.event === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: string }).code).toBe("stream_failed");
    expect(events.at(-1)?.event).toBe("message.done");
    // Partial assistant content was persisted rather than lost.
    expect(store.get("sess_1")?.transcript.at(-1)).toEqual({
      role: "assistant",
      content: "Partial",
    });
  });

  it("falls through to a graceful failure when the OpenRouter request times out", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        // Both primary and fallback OpenRouter calls hang until their abort
        // signal fires, simulating an unresponsive upstream.
        .mockImplementation((_input, init) => {
          return new Promise((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      { ...baseEnv, AI_SDR_OPENROUTER_TIMEOUT_MS: "5" },
      store,
      () => "msg_timeout",
    );

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    const errorEvent = events.find((event) => event.event === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { code: string }).code).toBe("model_unavailable");
    expect(events.some((event) => event.event === "message.delta")).toBe(true);
    expect(events.at(-1)?.event).toBe("message.done");
  });

  it("does not persist an orphan user message when context fetch fails", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    // First turn: context fetch 502s. The user message must NOT be persisted.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("upstream", { status: 502 })),
    );
    const failed = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "first" }),
      baseEnv,
      store,
      () => "msg_a",
    );
    expect(failed.status).toBe(502);
    expect(store.get("sess_1")?.transcript).toEqual([]);

    // Second turn succeeds: history is clean (no duplicated/orphan "first").
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "second" }),
      baseEnv,
      store,
      () => "msg_b",
    );
    const contents = store.get("sess_1")?.transcript.map((entry) => entry.content);
    expect(contents).toEqual(["second", "ok"]);
  });

  it("rejects chat when the session has no bound origin", async () => {
    const store = new MemorySessionStore();
    // Session created with no origin (e.g. a non-browser create with no Origin
    // header) must not be usable from any origin.
    await store.create("sess_noorigin", { productId: "prod_123" }, 86_400);
    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_noorigin", message: "hi" }),
      baseEnv,
      store,
      () => "msg_no",
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects handoff when the session has no bound origin", async () => {
    const store = new MemorySessionStore();
    await store.create("sess_noorigin2", { productId: "prod_123" }, 86_400);
    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_noorigin2", message: "hi" }),
      baseEnv,
      store,
      () => "handoff_no",
    );
    expect(response.status).toBe(401);
  });

  it("derives a sane default and override for the OpenRouter timeout", () => {
    expect(openRouterTimeoutMs(baseEnv)).toBe(30_000);
    expect(openRouterTimeoutMs({ ...baseEnv, AI_SDR_OPENROUTER_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(openRouterTimeoutMs({ ...baseEnv, AI_SDR_OPENROUTER_TIMEOUT_MS: "0" })).toBe(30_000);
    expect(openRouterTimeoutMs({ ...baseEnv, AI_SDR_OPENROUTER_TIMEOUT_MS: "nope" })).toBe(30_000);
  });

  it("falls back when primary OpenRouter routing fails", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toEqual({
      event: "message.delta",
      data: { messageId: "msg_1", delta: "Fallback answer" },
    });
    const fallbackBody = JSON.parse(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body as string,
    ) as { model: string };
    expect(fallbackBody.model).toBe("minimax/minimax-m3");
  });

  it("uses safe chat response when OpenRouter is unavailable", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(signedContextResponse(product)));

    const { OPENROUTER_API_KEY: _openRouterApiKey, ...envWithoutKey } = baseEnv;
    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      envWithoutKey,
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toMatchObject({
      data: { delta: "I could not generate a response right now." },
    });
  });

  it("uses safe chat response when OpenRouter returns invalid JSON", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(new Response("fallback unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(response.status).toBe(200);
    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toMatchObject({
      data: { delta: "I could not generate a response right now." },
    });
  });

  it("POST /v1/handoff captures contact only after user asks to share contact", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const blocked = await handleHandoff(
      jsonRequest("/v1/handoff", {
        sessionId: "sess_1",
        contact: { email: "person@example.com" },
        message: "pricing",
      }),
      baseEnv,
      store,
      () => "handoff_1",
    );
    expect(blocked.status).toBe(202);
    expect(store.get("sess_1")?.handoff.contact).toBeUndefined();

    const accepted = await handleHandoff(
      jsonRequest("/v1/handoff", {
        sessionId: "sess_1",
        contact: { email: "person@example.com" },
        message: "please contact me",
        reason: "demo",
      }),
      baseEnv,
      store,
      () => "handoff_2",
    );
    expect(accepted.status).toBe(202);
    expect(store.get("sess_1")?.handoff.contact).toEqual({ email: "person@example.com" });
  });

  it("POST /v1/handoff validates body and session", async () => {
    const store = new MemorySessionStore();
    expect(
      (await handleHandoff(jsonRequest("/v1/handoff", { reason: "demo" }), baseEnv, store)).status,
    ).toBe(400);
    expect(
      (await handleHandoff(jsonRequest("/v1/handoff", { sessionId: "missing" }), baseEnv, store))
        .status,
    ).toBe(404);
  });

  it("POST /v1/handoff handles omitted message and contact", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", contact: { email: "person@example.com" } }),
      baseEnv,
      store,
    );
    expect(response.status).toBe(202);
    expect(store.get("sess_1")?.handoff.message).toBe("");
    expect(store.get("sess_1")?.handoff.contact).toBeUndefined();
  });
});

describe("product context and model routing helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("signs product context requests and verifies response signatures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(signedContextResponse(product));
    const result = await fetchSignedProductContext("prod_123", baseEnv, fetchMock);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://product.example.com/context?productId=prod_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Ventora-Nonce": expect.any(String),
          "X-Ventora-Signature": expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("minimizes signed product context before prompts and returned event context", async () => {
    const unsafeProduct = {
      ...product,
      description: `Email sales@example.com. ${"A".repeat(700)}`,
      internalNotes: "do not leak this internal note",
      sources: [
        {
          id: "src_1",
          title: "Pricing",
          url: "https://example.com/pricing",
          excerpt: `Call 555-123-4567 for details. ${"B".repeat(700)}`,
          secretSourceField: "hidden source value",
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `extra_${index}`,
          title: `Extra ${index}`,
          url: `https://example.com/${index}`,
        })),
      ],
      plans: [
        {
          id: "pro",
          name: "Pro",
          price: "$199",
          monthlyPrice: "$199/mo",
          annualPrice: "$99/mo billed annually",
          discount: "50% off annual",
          defaultCadence: "year",
          trialDays: 14,
          ctaUrl: "https://app.example.com/trial",
          features: [
            "Email sales@example.com",
            ...Array.from({ length: 20 }, (_, i) => `Feature ${i}`),
          ],
          internalCost: "do not leak margin",
        },
        {
          id: "bad_cadence",
          name: "Bad cadence",
          price: "$499",
          defaultCadence: "annual",
        },
      ],
      meetingLinks: [
        {
          id: "bookIntroCall",
          label: "Book a 15-minute intro call",
          url: "https://cal.com/demo-team-capveri/15min",
          description: "Email sales@example.com for a quick intro",
          internalMeetingNote: "do not leak this meeting note",
        },
        ...Array.from({ length: 15 }, (_, index) => ({
          id: `extra_meeting_${index}`,
          label: `Extra meeting ${index}`,
          url: `https://cal.com/demo-team-capveri/extra-${index}`,
        })),
      ],
      secretToken: "do not leak this token",
    } as unknown as ProductContext & Record<string, unknown>;
    const fetchMock = vi.fn().mockResolvedValueOnce(signedContextResponse(unsafeProduct));
    const result = await fetchSignedProductContext("prod_123", baseEnv, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.product).toMatchObject({
      productId: "prod_123",
      name: "Ventora Rooms",
      description: expect.stringContaining("[redacted-email]"),
      sources: expect.arrayContaining([
        expect.objectContaining({
          id: "src_1",
          title: "Pricing",
          url: "https://example.com/pricing",
          excerpt: expect.stringContaining("[redacted-phone]"),
        }),
      ]),
      plans: expect.arrayContaining([
        expect.objectContaining({
          id: "pro",
          name: "Pro",
          price: "$199",
          monthlyPrice: "$199/mo",
          annualPrice: "$99/mo billed annually",
          discount: "50% off annual",
          defaultCadence: "year",
          trialDays: 14,
          ctaUrl: "https://app.example.com/trial",
        }),
      ]),
    });
    expect(result.product.sources).toHaveLength(8);
    expect(result.product.plans?.[0]?.features).toHaveLength(12);
    expect(result.product.plans?.[1]).toEqual({
      id: "bad_cadence",
      name: "Bad cadence",
      price: "$499",
    });
    expect(result.product.meetingLinks).toHaveLength(12);
    expect(result.product.meetingLinks?.[0]).toEqual({
      id: "bookIntroCall",
      label: "Book a 15-minute intro call",
      url: "https://cal.com/demo-team-capveri/15min",
      description: expect.stringContaining("[redacted-email]"),
    });
    expect(result.product).not.toHaveProperty("internalNotes");
    expect(result.product).not.toHaveProperty("secretToken");
    expect(result.product.sources?.[0]).not.toHaveProperty("secretSourceField");
    expect(result.product.plans?.[0]).not.toHaveProperty("internalCost");
    expect(result.product.meetingLinks?.[0]).not.toHaveProperty("internalMeetingNote");

    const payload = buildOpenRouterPayload("primary", baseEnv, result.product, "pricing?", []);
    const system = (payload.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";
    expect(system).not.toContain("internal note");
    expect(system).not.toContain("secretToken");
    expect(system).not.toContain("hidden source value");
    expect(system).not.toContain("do not leak margin");
    expect(system).not.toContain("sales@example.com");
    expect(system).toContain("[redacted-email]");
    expect(system).toContain("[redacted-phone]");
  });

  it("drops contract-invalid sources (missing id) instead of crashing the chat", async () => {
    // A signed context is authenticated, not schema-validated: a backend can
    // send a source missing the required id/title/url. Before the guard this
    // NPE'd truncateText and 500'd every /v1/chat.
    const malformed = {
      productId: "prod_123",
      name: "Ventora Rooms",
      sources: [
        { title: "No id source", url: "https://example.com/x", excerpt: "x" },
        { id: "src_ok", title: "Valid", url: "https://example.com/ok" },
      ],
    } as unknown as ProductContext;
    const fetchMock = vi.fn().mockResolvedValueOnce(signedContextResponse(malformed));

    const result = await fetchSignedProductContext("prod_123", baseEnv, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.product.sources).toEqual([
      expect.objectContaining({ id: "src_ok", title: "Valid", url: "https://example.com/ok" }),
    ]);
  });

  it("rejects signed product context for a different product", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse({ ...product, productId: "other" }));

    await expect(fetchSignedProductContext("prod_123", baseEnv, fetchMock)).resolves.toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });

  it("routes product context requests through a configured per-product endpoint map", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        signedContextResponse(product, "/api/ai-sdr/context?productId=prod_123"),
      );
    const { AI_SDR_CONTEXT_ENDPOINT: _endpoint, ...envWithoutLegacyEndpoint } = baseEnv;
    const result = await fetchSignedProductContext(
      "prod_123",
      {
        ...envWithoutLegacyEndpoint,
        AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
          prod_123: "https://prod-123.example.com/api/ai-sdr/context",
          other: "https://other.example.com/api/ai-sdr/context",
        }),
      },
      fetchMock,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://prod-123.example.com/api/ai-sdr/context?productId=prod_123",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails safely when a per-product endpoint map does not include the requested product", async () => {
    const { AI_SDR_CONTEXT_ENDPOINT: _endpoint, ...envWithoutLegacyEndpoint } = baseEnv;
    const env = {
      ...envWithoutLegacyEndpoint,
      AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
        prod_123: "https://prod-123.example.com/api/ai-sdr/context",
      }),
    };
    await expect(fetchSignedProductContext("missing", env, vi.fn())).resolves.toEqual({
      ok: false,
      reason: "missing_config",
    });
    await expect(fetchSignedProductContext("__proto__", env, vi.fn())).resolves.toEqual({
      ok: false,
      reason: "missing_config",
    });
  });

  it("fails closed when the endpoint map is malformed", async () => {
    const fetchMock = vi.fn();

    await expect(
      fetchSignedProductContext(
        "prod_123",
        {
          ...baseEnv,
          AI_SDR_CONTEXT_ENDPOINTS: "{",
        },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to a production endpoint for retired GrantPipe", async () => {
    const fetchMock = vi.fn();
    const result = await fetchSignedProductContext(
      "grantpipe",
      {
        ...baseEnv,
        ENVIRONMENT: "production",
        AI_SDR_CONTEXT_ENDPOINT: "https://grantpipe.example.com/context",
        AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
          camaudit: "https://camaudit.example.com/context",
        }),
      },
      fetchMock,
    );

    expect(result).toEqual({ ok: false, reason: "missing_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for non-object and invalid endpoint maps", async () => {
    const fetchMock = vi.fn();

    await expect(
      fetchSignedProductContext(
        "prod_123",
        { ...baseEnv, AI_SDR_CONTEXT_ENDPOINTS: "[]" },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        { ...baseEnv, AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({ prod_123: "" }) },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        { ...baseEnv, AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({ prod_123: "not-a-url" }) },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        {
          ...baseEnv,
          AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
            prod_123: "http://product.example.com/context",
          }),
        },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        { ...baseEnv, AI_SDR_CONTEXT_ENDPOINT: "http://product.example.com/context" },
        fetchMock,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails product context fetch safely for missing config, upstream errors, and invalid payloads", async () => {
    await expect(fetchSignedProductContext("prod_123", {}, vi.fn())).resolves.toEqual({
      ok: false,
      reason: "missing_config",
    });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        baseEnv,
        vi.fn().mockResolvedValueOnce(new Response("bad", { status: 500 })),
      ),
    ).resolves.toEqual({ ok: false, reason: "upstream_error" });
    await expect(
      fetchSignedProductContext(
        "prod_123",
        baseEnv,
        vi.fn().mockResolvedValueOnce(
          new Response(JSON.stringify({ productId: "prod_123" }), {
            status: 200,
            headers: {
              "X-Ventora-Timestamp": new Date().toISOString(),
              "X-Ventora-Nonce": "n",
              "X-Ventora-Signature": "0".repeat(64),
            },
          }),
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_context" });
  });

  it("fails product context fetch safely for invalid signatures", async () => {
    const timestamp = new Date().toISOString();
    const response = new Response(JSON.stringify(product), {
      status: 200,
      headers: {
        "X-Ventora-Timestamp": timestamp,
        "X-Ventora-Nonce": "n",
        "X-Ventora-Signature": "0".repeat(64),
      },
    });
    await expect(
      fetchSignedProductContext("prod_123", baseEnv, vi.fn().mockResolvedValueOnce(response)),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("builds primary, fallback, and escalation OpenRouter payloads from configurable env", () => {
    expect(buildOpenRouterPayload("primary", baseEnv, product, "pricing?", [])).toMatchObject({
      model: "minimax/minimax-m3",
    });
    expect(buildOpenRouterPayload("primary", baseEnv, product, "pricing?", [])).not.toHaveProperty(
      "provider",
    );
    expect(buildOpenRouterPayload("fallback", baseEnv, product, "pricing?", [])).toMatchObject({
      model: "minimax/minimax-m3",
      reasoning: { effort: "medium" },
    });
    expect(buildOpenRouterPayload("fallback", baseEnv, product, "pricing?", [])).not.toHaveProperty(
      "provider",
    );
    expect(buildOpenRouterPayload("escalation", baseEnv, product, "pricing?", [])).toMatchObject({
      model: "minimax/minimax-m3",
      reasoning: { effort: "medium" },
    });
    expect(
      buildOpenRouterPayload("escalation", baseEnv, product, "pricing?", []),
    ).not.toHaveProperty("provider");
  });

  it("instructs the model to use canonical pricing, avoid raw markdown tables, and sell from our side", () => {
    const payload = buildOpenRouterPayload(
      "primary",
      baseEnv,
      {
        ...product,
        plans: [
          {
            id: "pro",
            name: "Pro",
            monthlyPrice: "$199/mo",
            annualPrice: "$99/mo billed annually",
            discount: "50% off annual",
            defaultCadence: "year",
            ctaUrl: "https://app.example.com/trial",
          },
        ],
      },
      "Compare with Instrumentl. Do you have monthly?",
      [],
    );
    const system = (payload.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";

    expect(system).toContain("Use the signed product context as the single source of truth");
    expect(system).toContain("annual is the default");
    expect(system).toContain("monthly is available");
    expect(system).toContain("50% off annual");
    expect(system).toContain("Never output markdown tables");
    expect(system).toContain("In comparisons, put our product first");
    expect(system).toContain("Founder contact");
    // The handoff label carries no contact channel of its own: every channel the
    // model may offer has to come from the signed context, so a personal profile
    // URL can never be baked into the prompt.
    expect(system).toContain("only ones you may offer are those present in the signed context");
    expect(system).not.toMatch(/linkedin\.com|twitter\.com|x\.com\/|calendly\.com/i);
    expect(system).not.toContain("Founder Sales contact");
    // Policy: expert-on-product framing
    expect(system).toContain("what this product does");
    expect(system).toContain("problems it solves");
    // Policy: consultative qualification (elicit the lead profile, never interrogate)
    expect(system).toContain("Qualify by being genuinely curious, never by interrogating");
    expect(system).toContain("offer to have the founder follow up and ask for the best name");
    // Handoff on explicit ask OR clear buying intent
    expect(system).toContain("shows clear buying intent");
  });

  it("uses model routing defaults when env overrides are absent", () => {
    expect(buildOpenRouterPayload("primary", {}, product, "hello", [])).toMatchObject({
      model: "minimax/minimax-m3",
    });
    expect(buildOpenRouterPayload("primary", {}, product, "hello", [])).not.toHaveProperty(
      "provider",
    );
    expect(buildOpenRouterPayload("fallback", {}, product, "hello", [])).toMatchObject({
      model: "openai/gpt-5.4-nano",
    });
    expect(buildOpenRouterPayload("fallback", {}, product, "hello", [])).not.toHaveProperty(
      "provider",
    );
    expect(buildOpenRouterPayload("escalation", {}, product, "hello", [])).toMatchObject({
      model: "x-ai/grok-4.3",
    });
    expect(buildOpenRouterPayload("escalation", {}, product, "hello", [])).not.toHaveProperty(
      "provider",
    );
    expect(
      selectRoute(
        { primaryFailed: false, sourceRelevant: true, confidence: 0.8 },
        { AI_SDR_CONFIDENCE_THRESHOLD: "bad" },
      ).kind,
    ).toBe("primary");
  });

  it("selects fallback on primary failure and escalation for low confidence with relevant source context", () => {
    expect(
      selectRoute({ primaryFailed: true, sourceRelevant: false, confidence: 0.9 }, baseEnv).kind,
    ).toBe("fallback");
    expect(
      selectRoute({ primaryFailed: false, sourceRelevant: true, confidence: 0.5 }, baseEnv).kind,
    ).toBe("escalation");
    expect(
      selectRoute({ primaryFailed: false, sourceRelevant: true, confidence: 0.9 }, baseEnv).kind,
    ).toBe("primary");
  });

  it("defaults to documented per-route models with no provider key when env is empty", () => {
    const emptyEnv = {};
    const expectedModels: Record<"primary" | "fallback" | "escalation", string> = {
      primary: "minimax/minimax-m3",
      fallback: "openai/gpt-5.4-nano",
      escalation: "x-ai/grok-4.3",
    };
    for (const kind of ["primary", "fallback", "escalation"] as const) {
      const payload = buildOpenRouterPayload(kind, emptyEnv, product, "hi", []);
      expect(payload.model).toBe(expectedModels[kind]);
      expect(payload).not.toHaveProperty("provider");
    }
  });

  it("does not reuse the primary model for the fallback or escalation defaults", () => {
    const emptyEnv = {};
    const primary = buildOpenRouterPayload("primary", emptyEnv, product, "hi", []).model;
    const fallback = buildOpenRouterPayload("fallback", emptyEnv, product, "hi", []).model;
    const escalation = buildOpenRouterPayload("escalation", emptyEnv, product, "hi", []).model;
    expect(fallback).not.toBe(primary);
    expect(escalation).not.toBe(primary);
    expect(escalation).not.toBe(fallback);
  });

  it("omits provider key when providers is empty; includes it when non-empty", () => {
    const withProviders = { ...baseEnv, AI_SDR_PRIMARY_PROVIDERS: "fireworks,together" };
    const withEmpty = { ...baseEnv, AI_SDR_PRIMARY_PROVIDERS: "" };
    expect(buildOpenRouterPayload("primary", withProviders, product, "hi", [])).toHaveProperty(
      "provider",
      { order: ["fireworks", "together"] },
    );
    expect(buildOpenRouterPayload("primary", withEmpty, product, "hi", [])).not.toHaveProperty(
      "provider",
    );
  });

  it("keeps minimax as the primary default model", () => {
    const payload = buildOpenRouterPayload("primary", {}, product, "hi", []);
    expect(payload.model).toBe("minimax/minimax-m3");
    expect(typeof payload.model === "string" && payload.model).not.toMatch(/gpt|grok/i);
  });

  it("system prompt explains the product, qualifies consultatively, and handles handoff on intent", () => {
    const payload = buildOpenRouterPayload("primary", baseEnv, product, "hi", []);
    const system = (payload.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";
    expect(system).toContain("what this product does");
    expect(system).toContain("problems it solves");
    // Consultative qualification: learn pain, incumbent, authority, and timeline one ask at a time.
    expect(system).toContain("Ask at most one question at a time");
    expect(system).toContain("who else weighs in on the decision");
    expect(system).toContain("help them first, every time");
    // Handoff still offered, now also on clear buying intent.
    expect(system).toContain("shows clear buying intent");
    expect(system).toContain("Founder contact");
    expect(system).not.toMatch(/linkedin\.com|twitter\.com|x\.com\/|calendly\.com/i);
  });

  it("does not add retired GrantPipe qualification routing", () => {
    const grantPipeContext: ProductContext = {
      productId: "grantpipe",
      name: "GrantPipe",
      description: "A donor management and grant compliance platform for mid-sized nonprofits.",
      sources: [
        {
          id: "positioning",
          title: "GrantPipe positioning",
          url: "https://grantpipe.com",
          excerpt: "One system for donors, grants, restricted funds, and compliance reporting.",
        },
      ],
    };

    const payload = buildOpenRouterPayload("primary", baseEnv, grantPipeContext, "hi", []);
    const system = (payload.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";

    expect(system).not.toContain("For GrantPipe conversations");
    expect(system).not.toContain("Which team owns the next dollar-trail problem");
    expect(system).not.toContain("GrantPipe-specific discovery question");
    expect(system).toContain("Qualify by being genuinely curious");
    expect(system).toContain("Signed product context");
    expect(system).not.toContain("trusted by");
    expect(system).not.toContain("guaranteed savings");
  });

  it("parses partial SSE chunks defensively", () => {
    expect(parseSse('data: {"ok":true}\n\n')).toEqual([{ event: "", data: { ok: true } }]);
    expect(parseSse("event: heartbeat\n\n")).toEqual([{ event: "heartbeat", data: null }]);
  });

  it("uses fallback OpenRouter endpoint and handles malformed responses", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const { OPENROUTER_ENDPOINT: _openRouterEndpoint, ...envWithDefaultEndpoint } = baseEnv;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        signedContextResponse({
          ...product,
          sources: [{ id: "src_2", title: "Overview", url: "https://example.com" }],
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "overview" }),
      envWithDefaultEndpoint,
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toMatchObject({
      data: { delta: "I could not generate a response right now." },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("refuses to send the OpenRouter bearer token to non-OpenRouter endpoints", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(signedContextResponse(product));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "overview" }),
      {
        ...baseEnv,
        OPENROUTER_ENDPOINT: "https://collector.example.com/api/v1/chat/completions",
      },
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toMatchObject({
      data: { delta: "I could not generate a response right now." },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed OpenRouter endpoint configuration", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(signedContextResponse(product));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "overview" }),
      { ...baseEnv, OPENROUTER_ENDPOINT: "not a url" },
      store,
      () => "msg_1",
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles absent source and plan collections without CTA", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ productId: "prod_123", name: "No Plans" }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Neutral" } }] }), {
            status: 200,
          }),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hello" }),
      baseEnv,
      store,
      () => "msg_1",
    );
    expect(parseSse(await response.text()).some((event) => event.event === "trial.cta")).toBe(
      false,
    );
  });
});

describe("Durable Object storage", () => {
  it("DurableObjectSessionStore proxies create, get, append, and handoff operations", async () => {
    const session = {
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    };
    const durableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session })))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: durableFetch })),
    } as unknown as DurableObjectNamespace;
    const store = new DurableObjectSessionStore(namespace);

    await expect(
      store.create("sess_1", { productId: "prod_123", origin: "https://product.example.com" }, 60),
    ).resolves.toMatchObject({
      id: "sess_1",
    });
    await expect(store.get("sess_1")).resolves.toMatchObject({ id: "sess_1" });
    await store.appendMessage("sess_1", { role: "user", content: "hello" });
    await store.setHandoff("sess_1", { requested: true, handoffId: "handoff_1" });
    await expect(store.get("missing")).resolves.toBeUndefined();

    expect(durableFetch).toHaveBeenCalledTimes(5);
  });

  it("DurableObjectSessionStore rejects failed or malformed Durable Object responses", async () => {
    const durableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: "only_id" } })));
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: durableFetch })),
    } as unknown as DurableObjectNamespace;
    const store = new DurableObjectSessionStore(namespace);

    await expect(
      store.create("sess_1", { productId: "prod_123", origin: "https://product.example.com" }, 60),
    ).rejects.toThrow("Durable Object session operation failed");
    await expect(
      store.create("sess_1", { productId: "prod_123", origin: "https://product.example.com" }, 60),
    ).rejects.toThrow("Invalid Durable Object session response");
  });

  it("creates sessions in SQLite storage and schedules cleanup alarm", async () => {
    // scheduleNextAlarm reads MIN(expires_at) FROM sessions to pick the alarm
    // time; return a concrete expiry for that query so the alarm is scheduled.
    const exec = vi.fn((sql: string) => {
      if (sql.includes("MIN(expires_at)")) {
        return { one: () => null, toArray: () => [{ next: Date.now() + 60_000 }] };
      }
      return { one: () => null, toArray: () => [] };
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    const response = await durable.fetch(
      jsonRequest("/create", {
        sessionId: "sess_1",
        draft: {
          productId: "prod_123",
          visitorId: "visitor_1",
          origin: "https://product.example.com",
        },
        ttlSeconds: 60,
      }),
    );
    await durable.alarm();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: { visitorId: "visitor_1", origin: "https://product.example.com" },
    });
    expect(exec).toHaveBeenCalledWith(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    );
    expect(exec).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO sessions (id, payload, expires_at) VALUES (?, ?, ?)",
      "sess_1",
      expect.stringContaining('"productId":"prod_123"'),
      expect.any(Number),
    );
    expect(setAlarm).toHaveBeenCalledWith(expect.any(Number));
    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM sessions WHERE expires_at <= ?",
      expect.any(Number),
    );
  });

  it("reads, appends transcript, and sets handoff state from Durable Object operations", async () => {
    let payload = JSON.stringify({
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: 1,
      expiresAt: Date.now() + 10_000,
    });
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith("SELECT")) {
        const row = { payload, expires_at: Date.now() + 10_000 };
        return {
          one: () => row,
          toArray: () => [row],
        };
      }
      if (sql.startsWith("INSERT")) {
        payload = String(params[1]);
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    await durable.fetch(
      jsonRequest("/append-message", {
        sessionId: "sess_1",
        message: { role: "user", content: "email me at person@example.com" },
      }),
    );
    await durable.fetch(
      jsonRequest("/set-handoff", {
        sessionId: "sess_1",
        handoff: {
          requested: true,
          handoffId: "handoff_1",
          reason: "demo",
          message: "please call 555-123-4567",
          contact: { email: "person@example.com" },
        },
      }),
    );
    const response = await durable.fetch(
      new Request("https://do.example.com/get?sessionId=sess_1"),
    );

    expect(response.status).toBe(200);
    const stored = (await response.json()) as {
      session: {
        transcript: Array<{ content: string }>;
        handoff: { handoffId: string; message: string; contact: Record<string, string> };
      };
    };
    // Transcript stores raw content for the lead extractor; handoff.message is
    // still redacted because it is surfaced to the SDR-facing handoff payload.
    expect(stored.session.transcript[0]?.content).toBe("email me at person@example.com");
    expect(stored.session.handoff.handoffId).toBe("handoff_1");
    expect(stored.session.handoff.message).toBe("please call [redacted-phone]");
    expect(stored.session.handoff.contact).toEqual({ email: "person@example.com" });
  });

  it("handles invalid Durable Object requests and stale rows safely", async () => {
    const exec = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT")) {
        const staleRow = { payload: "{}", expires_at: Date.now() - 1 };
        return { one: () => staleRow, toArray: () => [staleRow] };
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    expect((await durable.fetch(jsonRequest("/create", { sessionId: "sess_1" }))).status).toBe(400);
    expect(
      (await durable.fetch(new Request("https://do.example.com/get?sessionId=sess_1"))).status,
    ).toBe(404);
    expect((await durable.fetch(jsonRequest("/append-message", {}))).status).toBe(400);
    expect(
      (await durable.fetch(jsonRequest("/append-message", { sessionId: "sess_1" }))).status,
    ).toBe(404);
  });

  it("consumes client assertions once in SQLite storage", async () => {
    const assertions = new Set<string>();
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith("SELECT key FROM client_assertions")) {
        const key = String(params[0]);
        const rows = assertions.has(key) ? [{ key }] : [];
        return {
          one: () => {
            if (rows.length !== 1) {
              throw new Error("Expected exactly one result from SQL query, but got no results.");
            }
            return rows[0];
          },
          toArray: () => rows,
        };
      }
      if (sql.startsWith("INSERT INTO client_assertions")) {
        assertions.add(String(params[0]));
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);
    const body = { key: "assertion-1", expiresAt: Date.now() + 60_000 };

    const first = await durable.fetch(jsonRequest("/consume-client-assertion", body));
    const replay = await durable.fetch(jsonRequest("/consume-client-assertion", body));
    const invalid = await durable.fetch(jsonRequest("/consume-client-assertion", {}));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(invalid.status).toBe(400);
    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM client_assertions WHERE expires_at <= ?",
      expect.any(Number),
    );
  });

  it("returns not found for unsupported Durable Object requests", async () => {
    const exec = vi.fn(() => ({
      one: () => {
        throw new Error("Expected exactly one result from SQL query, but got no results.");
      },
      toArray: () => [] as unknown[],
    }));
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    expect(
      (await durable.fetch(new Request("https://do.example.com/", { method: "GET" }))).status,
    ).toBe(404);
  });

  it("returns not found when updating a missing Durable Object session", async () => {
    const exec = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return {
          one: () => {
            throw new Error("Expected exactly one result from SQL query, but got no results.");
          },
          toArray: () => [] as unknown[],
        };
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, { AI_SDR_SESSION_TTL_SECONDS: "bad" });

    const response = await durable.fetch(
      jsonRequest("/append-message", {
        sessionId: "sess_1",
        message: { role: "user", content: "hello" },
      }),
    );

    expect(response.status).toBe(404);
  });

  it("consumeClientAssertion accepts the first use of an assertion key (zero rows must not throw)", async () => {
    const assertions = new Set<string>();
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith("SELECT key FROM client_assertions")) {
        const key = String(params[0]);
        const rows = assertions.has(key) ? [{ key }] : [];
        return {
          one: () => {
            if (rows.length !== 1) {
              throw new Error("Expected exactly one result from SQL query, but got no results.");
            }
            return rows[0];
          },
          toArray: () => rows,
        };
      }
      if (sql.startsWith("INSERT INTO client_assertions")) {
        assertions.add(String(params[0]));
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);
    const body = { key: "regression-first-use", expiresAt: Date.now() + 60_000 };

    const first = await durable.fetch(jsonRequest("/consume-client-assertion", body));

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true });
  });

  it("consumeClientAssertion returns 409 for a replayed assertion key", async () => {
    const assertions = new Set<string>();
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith("SELECT key FROM client_assertions")) {
        const key = String(params[0]);
        const rows = assertions.has(key) ? [{ key }] : [];
        return {
          one: () => {
            if (rows.length !== 1) {
              throw new Error("Expected exactly one result from SQL query, but got no results.");
            }
            return rows[0];
          },
          toArray: () => rows,
        };
      }
      if (sql.startsWith("INSERT INTO client_assertions")) {
        assertions.add(String(params[0]));
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);
    const body = { key: "regression-replay", expiresAt: Date.now() + 60_000 };

    await durable.fetch(jsonRequest("/consume-client-assertion", body));
    const replay = await durable.fetch(jsonRequest("/consume-client-assertion", body));

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: "Client assertion replay" });
  });

  it("readSession returns undefined for an unknown session id (zero rows must not throw)", async () => {
    const exec = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return {
          one: () => {
            throw new Error("Expected exactly one result from SQL query, but got no results.");
          },
          toArray: () => [] as unknown[],
        };
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    const response = await durable.fetch(
      new Request("https://do.example.com/get?sessionId=nonexistent-id"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  it("session create-then-get round-trip works end-to-end in SQLite storage", async () => {
    const sessions = new Map<string, { payload: string; expires_at: number }>();
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith("SELECT payload, expires_at FROM sessions")) {
        const id = String(params[0]);
        const row = sessions.get(id);
        const rows = row !== undefined ? [row] : [];
        return {
          one: () => {
            if (rows.length !== 1) {
              throw new Error("Expected exactly one result from SQL query, but got no results.");
            }
            return rows[0];
          },
          toArray: () => rows,
        };
      }
      if (sql.startsWith("INSERT OR REPLACE INTO sessions")) {
        sessions.set(String(params[0]), {
          payload: String(params[1]),
          expires_at: Number(params[2]),
        });
      }
      return {
        one: () => {
          throw new Error("Expected exactly one result from SQL query, but got no results.");
        },
        toArray: () => [] as unknown[],
      };
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, baseEnv);

    const createResponse = await durable.fetch(
      jsonRequest("/create", {
        sessionId: "sess_roundtrip",
        draft: { productId: "prod_123" },
        ttlSeconds: 3600,
      }),
    );
    expect(createResponse.status).toBe(200);

    const getResponse = await durable.fetch(
      new Request("https://do.example.com/get?sessionId=sess_roundtrip"),
    );
    expect(getResponse.status).toBe(200);
    const body = (await getResponse.json()) as { session: { id: string; productId: string } };
    expect(body.session.id).toBe("sess_roundtrip");
    expect(body.session.productId).toBe("prod_123");
  });

  it("POST /v1/sessions via worker routes through AiSdrSession DO + SQLite when client-assertion secret and namespace binding are provided", async () => {
    function makeFaithfulExec(): (
      sql: string,
      ...params: unknown[]
    ) => {
      one: () => unknown;
      toArray: () => unknown[];
    } {
      const assertions = new Map<string, number>();
      const sessions = new Map<string, { payload: string; expires_at: number }>();
      return (sql: string, ...params: unknown[]) => {
        if (sql.startsWith("SELECT key FROM client_assertions")) {
          const key = String(params[0]);
          const row = assertions.has(key) ? [{ key }] : [];
          return {
            one: () => {
              if (row.length !== 1) {
                throw new Error("Expected exactly one result from SQL query, but got no results.");
              }
              return row[0];
            },
            toArray: () => row as unknown[],
          };
        }
        if (sql.startsWith("INSERT INTO client_assertions")) {
          assertions.set(String(params[0]), Number(params[1]));
        }
        if (sql.startsWith("DELETE FROM client_assertions")) {
          const cutoff = Number(params[0]);
          for (const [k, exp] of assertions) {
            if (exp <= cutoff) assertions.delete(k);
          }
        }
        if (sql.startsWith("SELECT payload, expires_at FROM sessions")) {
          const id = String(params[0]);
          const row = sessions.get(id);
          const rows = row !== undefined ? [row] : [];
          return {
            one: () => {
              if (rows.length !== 1) {
                throw new Error("Expected exactly one result from SQL query, but got no results.");
              }
              return rows[0];
            },
            toArray: () => rows as unknown[],
          };
        }
        if (sql.startsWith("INSERT OR REPLACE INTO sessions")) {
          sessions.set(String(params[0]), {
            payload: String(params[1]),
            expires_at: Number(params[2]),
          });
        }
        return {
          one: () => {
            throw new Error("Expected exactly one result from SQL query, but got no results.");
          },
          toArray: () => [] as unknown[],
        };
      };
    }

    const instances = new Map<string, AiSdrSession>();
    const namespace = {
      idFromName: (name: string): { name: string } => ({ name }),
      get: (id: { name: string }): {
        fetch: (req: Request | string, init?: RequestInit) => Promise<Response>;
      } => {
        let instance = instances.get(id.name);
        if (!instance) {
          const exec = vi.fn(makeFaithfulExec());
          const state = {
            storage: { sql: { exec }, setAlarm: vi.fn().mockResolvedValue(undefined) },
          } as unknown as DurableObjectState;
          instance = new AiSdrSession(state, baseEnv);
          instances.set(id.name, instance);
        }
        const do_ = instance;
        return {
          fetch: (req: Request | string, init?: RequestInit) => {
            const request = typeof req === "string" ? new Request(req, init) : req;
            return do_.fetch(request);
          },
        };
      },
    } as unknown as DurableObjectNamespace;

    const env = {
      ...baseEnv,
      AI_SDR_CLIENT_ASSERTION_SECRET: clientAssertionSecret,
      AI_SDR_SESSIONS: namespace,
    };
    const timestamp = new Date().toISOString();
    const nonce = "regression-e2e-do-nonce";

    const response = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { timestamp, nonce }),
      env,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { sessionId: string };
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId).toHaveLength(24);

    // Replay of the same assertion must be rejected (exercises SQLite-backed replay guard)
    const replay = await worker.fetch(
      signedJsonRequest("/v1/sessions", { productId: "prod_123" }, { timestamp, nonce }),
      env,
    );
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "Invalid client assertion" });
  });
});

describe("multi-turn conversation memory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes no history messages on the first turn (just system + current user)", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_multi",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Welcome, how can I help?" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_multi", message: "Hello" }),
      baseEnv,
      store,
      () => "msg_a",
    );

    const openRouterCall = fetchMock.mock.calls[1];
    const body = JSON.parse((openRouterCall?.[1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(body.messages).toHaveLength(2);
  });

  it("feeds prior transcript turns to the model on subsequent messages", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_multi2",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Our Pro plan is $199/month." } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Yes, we offer a free trial." } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    // First turn
    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_multi2", message: "What is the pricing?" }),
      baseEnv,
      store,
      () => "msg_a",
    );

    // Second turn
    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_multi2", message: "Do you have a trial?" }),
      baseEnv,
      store,
      () => "msg_b",
    );

    // The second OpenRouter call (4th fetch call: context + model for turn 1, context + model for turn 2)
    const secondOpenRouterCall = fetchMock.mock.calls[3];
    const body = JSON.parse((secondOpenRouterCall?.[1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    // messages: [system, user(turn1), assistant(turn1), user(turn2)]
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "What is the pricing?" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "Our Pro plan is $199/month.",
    });
    expect(body.messages[3]).toEqual({ role: "user", content: "Do you have a trial?" });
    expect(body.messages).toHaveLength(4);
  });

  it("caps history to MAX_HISTORY_MESSAGES (20) most recent messages", async () => {
    // buildOpenRouterPayload is the function we test directly for capping
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i}`,
    }));

    const payload = buildOpenRouterPayload("primary", baseEnv, product, "final question", history);
    const messages = payload.messages as Array<{ role: string; content: string }>;

    // system + 20 history + current user = 22
    expect(messages).toHaveLength(22);
    expect(messages[0]?.role).toBe("system");
    // The first history message that should be included is index 5 (25-20=5)
    expect(messages[1]).toEqual({ role: "assistant", content: "message 5" });
    expect(messages[21]).toEqual({ role: "user", content: "final question" });
  });

  it("only emits role and content from history entries (no extra fields)", () => {
    const historyWithExtras = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];

    const payload = buildOpenRouterPayload(
      "primary",
      baseEnv,
      product,
      "follow up",
      historyWithExtras,
    );
    const messages = payload.messages as Array<{ role: string; content: string }>;

    expect(messages[1]).toStrictEqual({ role: "user", content: "hello" });
    expect(messages[2]).toStrictEqual({ role: "assistant", content: "hi there" });
  });

  it("passes the same history snapshot to both primary and fallback callOpenRouter calls", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_fallback_hist",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );

    // Pre-populate transcript with a prior turn
    await store.appendMessage("sess_fallback_hist", { role: "user", content: "prior question" });
    await store.appendMessage("sess_fallback_hist", {
      role: "assistant",
      content: "prior answer",
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(new Response("upstream error", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Fallback with history" } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_fallback_hist", message: "new question" }),
      baseEnv,
      store,
      () => "msg_f",
    );

    // Primary call (index 1) and fallback call (index 2) should both include history
    const primaryBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { messages: Array<{ role: string; content: string }> };
    const fallbackBody = JSON.parse(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body as string,
    ) as { messages: Array<{ role: string; content: string }> };

    // Both should have [system, prior-user, prior-assistant, current-user]
    expect(primaryBody.messages).toHaveLength(4);
    expect(primaryBody.messages[1]).toEqual({ role: "user", content: "prior question" });
    expect(primaryBody.messages[2]).toEqual({ role: "assistant", content: "prior answer" });
    expect(primaryBody.messages[3]).toEqual({ role: "user", content: "new question" });

    expect(fallbackBody.messages).toHaveLength(4);
    expect(fallbackBody.messages[1]).toEqual({ role: "user", content: "prior question" });
    expect(fallbackBody.messages[2]).toEqual({ role: "assistant", content: "prior answer" });
    expect(fallbackBody.messages[3]).toEqual({ role: "user", content: "new question" });
  });
});

describe("conversation policy helpers", () => {
  it("refuses continuous-development requests", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", {
        sessionId: "sess_1",
        message: "build a feature every day forever",
      }),
      baseEnv,
      store,
    );

    expect(parseSse(await response.text())[0]).toMatchObject({
      event: "message.delta",
      data: { delta: expect.stringContaining("can't commit to continuous development") },
    });
  });

  it("emits trial CTA only on fit or explicit intent", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "pro",
                name: "Pro",
                price: "$199",
                trialDays: 14,
                ctaUrl: "https://example.com/start",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Here is a neutral answer." } }] }),
          ),
        )
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "pro",
                name: "Pro",
                price: "$199",
                trialDays: 14,
                ctaUrl: "https://example.com/start",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "A trial is a good fit." } }] }),
          ),
        ),
    );

    const neutral = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is this?" }),
      baseEnv,
      store,
      () => "msg_1",
    );
    expect(parseSse(await neutral.text()).some((event) => event.event === "trial.cta")).toBe(false);

    const intent = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "I want to start a trial" }),
      baseEnv,
      store,
      () => "msg_2",
    );
    const intentEvents = parseSse(await intent.text());
    expect(intentEvents.some((event) => event.event === "trial.cta")).toBe(true);
  });

  it("does not emit trial CTA when signed plan context has no trial", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            sources: [{ id: "src_1", title: "Pricing", url: "https://example.com/pricing" }],
            plans: [{ id: "custom", name: "Custom", price: "Talk to sales" }],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Book a walkthrough." } }] }),
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "can I start a trial?" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(parseSse(await response.text()).some((event) => event.event === "trial.cta")).toBe(
      false,
    );
  });

  it("does not turn negative signed trial wording into a trial CTA", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "custom",
                name: "Custom",
                price: "No trial available; book a demo",
                trialDays: 30,
                ctaUrl: "https://example.com/book-demo",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Book a demo instead." } }] }),
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "can I start a trial?" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(parseSse(await response.text()).some((event) => event.event === "trial.cta")).toBe(
      false,
    );
  });

  it("uses the signed plan CTA URL for partner trial paths", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "camaudit", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse(
            {
              productId: "camaudit",
              name: "CAMAudit",
              plans: [
                {
                  id: "starter",
                  name: "Starter",
                  annualPrice: "$498/yr with LAUNCH80",
                  trialDays: 30,
                  ctaUrl: "https://www.camaudit.io/partners/white-label?offer=LAUNCH80",
                },
              ],
            },
            "/context?productId=camaudit",
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Good fit for a trial." } }] }),
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "can I start a trial?" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(parseSse(await response.text()).find((event) => event.event === "trial.cta")).toEqual({
      event: "trial.cta",
      data: {
        cta: {
          label: "Start partner setup",
          url: "https://www.camaudit.io/partners/white-label?offer=LAUNCH80",
        },
      },
    });
  });

  it("keeps CAMAudit trial CTA labels partner-safe when signed URL lacks partner wording", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "camaudit", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse(
            {
              productId: "camaudit",
              name: "CAMAudit",
              plans: [
                {
                  id: "starter",
                  name: "Starter",
                  annualPrice: "$498/yr with LAUNCH80",
                  trialDays: 30,
                  ctaUrl: "https://app.camaudit.io/checkout/starter",
                },
              ],
            },
            "/context?productId=camaudit",
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "A trial is a good fit." } }] }),
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "can I start a trial?" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(parseSse(await response.text()).find((event) => event.event === "trial.cta")).toEqual({
      event: "trial.cta",
      data: {
        cta: {
          label: "Start partner setup",
          url: "https://app.camaudit.io/checkout/starter",
        },
      },
    });
  });

  it("uses partner setup labels for signed partner CTA URLs on non-CAMAudit products", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "pro",
                name: "Pro",
                price: "$199",
                trialDays: 14,
                ctaUrl: "https://example.com/partners/start",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "A trial is a good fit." } }] }),
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "I want to start a trial" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(parseSse(await response.text()).find((event) => event.event === "trial.cta")).toEqual({
      event: "trial.cta",
      data: {
        cta: {
          label: "Start partner setup",
          url: "https://example.com/partners/start",
        },
      },
    });
  });

  it("does not invent a trial CTA URL when signed trial plan has no CTA URL", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "camaudit", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            productId: "camaudit",
            plans: [
              {
                id: "starter",
                name: "Starter",
                annualPrice: "$2,490/yr",
                trialDays: 30,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Start a trial." } }] })),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "Can we start a trial?" }),
      baseEnv,
      store,
      () => "msg_1",
    );

    const events = parseSse(await response.text());
    expect(events.some((event) => event.event === "trial.cta")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("/trial?productId=");
  });

  it("recommends the signed plan that best matches the prospect wording", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "starter",
                name: "Starter",
                annualPrice: "$2,490/yr",
                features: ["Pilot partner audits"],
              },
              {
                id: "growth",
                name: "Growth",
                annualPrice: "$13,490/yr",
                features: ["Steady client pipeline"],
              },
              {
                id: "scale",
                name: "Scale",
                annualPrice: "$79,990/yr",
                features: ["High-volume agencies", "Dedicated onboarding support"],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Use Scale." } }] })),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", {
        sessionId: "sess_1",
        message: "Which plan fits agencies doing high-volume work with onboarding?",
      }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "plan.recommendation"),
    ).toMatchObject({
      data: {
        recommendation: {
          planId: "scale",
          priceSummary: "Annual $79,990/yr",
        },
      },
    });
  });

  it.each([
    ["Which plan fits if we run 150 CAM audits?", "growth", "$13,490/yr"],
    ["Which plan fits if we run 1000 audits?", "scale", "$79,990/yr"],
  ])("uses audit-credit volume to recommend %s", async (message, expectedPlanId, expectedPrice) => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "camaudit", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse(
            {
              ...product,
              productId: "camaudit",
              plans: [
                {
                  id: "starter",
                  name: "Starter",
                  annualPrice: "$2,490/yr",
                  features: ["25 audit credits"],
                },
                {
                  id: "growth",
                  name: "Growth",
                  annualPrice: "$13,490/yr",
                  features: ["150 audit credits"],
                },
                {
                  id: "scale",
                  name: "Scale",
                  annualPrice: "$79,990/yr",
                  features: ["1,000 audit credits", "Dedicated onboarding"],
                },
              ],
            },
            "/context?productId=camaudit",
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Use this plan." } }] })),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", {
        sessionId: "sess_1",
        message,
      }),
      baseEnv,
      store,
      () => "msg_1",
    );

    expect(
      parseSse(await response.text()).find((event) => event.event === "plan.recommendation"),
    ).toMatchObject({
      data: {
        recommendation: {
          planId: expectedPlanId,
          priceSummary: `Annual ${expectedPrice}`,
        },
      },
    });
  });

  it("summarizes canonical monthly pricing and omits price summaries when context has no prices", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "annual",
                name: "Annual",
                annualPrice: "$99/mo billed annually",
                discount: "50% off annual",
                defaultCadence: "year",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Use Annual." } }] })),
        )
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [
              {
                id: "starter",
                name: "Starter",
                monthlyPrice: "$49/mo",
                defaultCadence: "month",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Use Starter." } }] })),
        )
        .mockResolvedValueOnce(
          signedContextResponse({
            ...product,
            plans: [{ id: "custom", name: "Custom" }],
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: "Use Custom." } }] })),
        ),
    );

    const annual = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_0",
    );
    expect(
      parseSse(await annual.text()).find((event) => event.event === "plan.recommendation"),
    ).toMatchObject({
      data: {
        recommendation: {
          planId: "annual",
          priceSummary: "Annual $99/mo billed annually; 50% off annual; annual default",
        },
      },
    });

    const monthly = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_1",
    );
    const monthlyRecommendation = parseSse(await monthly.text()).find(
      (event) => event.event === "plan.recommendation",
    );
    expect(monthlyRecommendation).toMatchObject({
      data: {
        recommendation: {
          planId: "starter",
          priceSummary: "Monthly $49/mo; monthly default",
        },
      },
    });

    const custom = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_2",
    );
    const customRecommendation = parseSse(await custom.text()).find(
      (event) => event.event === "plan.recommendation",
    );
    expect(customRecommendation).toMatchObject({
      data: { recommendation: { planId: "custom" } },
    });
    expect(
      (
        customRecommendation as {
          data?: { recommendation?: { priceSummary?: string } };
        }
      ).data?.recommendation?.priceSummary,
    ).toBeUndefined();
  });
});

describe("openRouterEndpoint (ai-sdr)", () => {
  it("returns the canonical openrouter.ai URL when no OPENROUTER_ENDPOINT is set", () => {
    const { OPENROUTER_ENDPOINT: _omit, ...envNoEndpoint } = baseEnv;
    expect(openRouterEndpoint(envNoEndpoint)).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("returns canonical URL when ENVIRONMENT is set (default endpoint unchanged)", () => {
    const { OPENROUTER_ENDPOINT: _omit, ...envNoEndpoint } = baseEnv;
    expect(openRouterEndpoint({ ...envNoEndpoint, ENVIRONMENT: "development" })).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("returns null when overridden to a non-openrouter https endpoint in any env", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "https://evil.example.com/api/v1/chat/completions",
      }),
    ).toBeNull();
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "https://evil.example.com/api/v1/chat/completions",
        ENVIRONMENT: "development",
      }),
    ).toBeNull();
    // baseEnv carries no ENVIRONMENT/NODE_ENV, so a plain spread already
    // simulates an unset mode (allowsLocalEndpoint -> false).
    const envNoMode = { ...baseEnv };
    expect(
      openRouterEndpoint({
        ...envNoMode,
        OPENROUTER_ENDPOINT: "https://evil.example.com/api/v1/chat/completions",
      }),
    ).toBeNull();
  });

  it("returns localhost URL when ENVIRONMENT='development'", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://localhost:8799/openrouter",
        ENVIRONMENT: "development",
      }),
    ).toBe("http://localhost:8799/openrouter");
  });

  it("returns localhost URL when ENVIRONMENT='local'", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://localhost:8799/openrouter",
        ENVIRONMENT: "local",
      }),
    ).toBe("http://localhost:8799/openrouter");
  });

  it("returns localhost URL when ENVIRONMENT='test'", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://localhost:8799/openrouter",
        ENVIRONMENT: "test",
      }),
    ).toBe("http://localhost:8799/openrouter");
  });

  it("returns null for localhost when ENVIRONMENT='production'", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://localhost:8799/openrouter",
        ENVIRONMENT: "production",
      }),
    ).toBeNull();
  });

  it("returns null for localhost when ENVIRONMENT and NODE_ENV are both absent", () => {
    // baseEnv carries no ENVIRONMENT/NODE_ENV, so a plain spread already
    // simulates an unset mode (allowsLocalEndpoint -> false).
    const envNoMode = { ...baseEnv };
    expect(
      openRouterEndpoint({
        ...envNoMode,
        OPENROUTER_ENDPOINT: "http://localhost:8799/openrouter",
      }),
    ).toBeNull();
  });

  it("strips search and hash from localhost URL when ENVIRONMENT='test'", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://localhost:8799/x?secret=1#h",
        ENVIRONMENT: "test",
      }),
    ).toBe("http://localhost:8799/x");
  });

  it("returns null for non-localhost http override even in dev envs", () => {
    expect(
      openRouterEndpoint({
        ...baseEnv,
        OPENROUTER_ENDPOINT: "http://10.0.0.5/api/v1/chat/completions",
        ENVIRONMENT: "development",
      }),
    ).toBeNull();
  });
});

describe("allowsLocalEndpoint (ai-sdr)", () => {
  it("returns true for 'local', 'development', and 'test' via ENVIRONMENT", () => {
    expect(allowsLocalEndpoint({ ENVIRONMENT: "local" })).toBe(true);
    expect(allowsLocalEndpoint({ ENVIRONMENT: "development" })).toBe(true);
    expect(allowsLocalEndpoint({ ENVIRONMENT: "test" })).toBe(true);
  });

  it("returns true for dev values via NODE_ENV when ENVIRONMENT is absent", () => {
    expect(allowsLocalEndpoint({ NODE_ENV: "development" })).toBe(true);
    expect(allowsLocalEndpoint({ NODE_ENV: "test" })).toBe(true);
  });

  it("returns false for 'production' and undefined", () => {
    expect(allowsLocalEndpoint({ ENVIRONMENT: "production" })).toBe(false);
    expect(allowsLocalEndpoint({})).toBe(false);
    expect(allowsLocalEndpoint({ NODE_ENV: "production" })).toBe(false);
  });

  it("ENVIRONMENT takes precedence over NODE_ENV", () => {
    expect(allowsLocalEndpoint({ ENVIRONMENT: "production", NODE_ENV: "development" })).toBe(false);
  });
});

describe("context endpoint localhost-in-dev allowance (ai-sdr)", () => {
  it("accepts https context endpoint in any env (unchanged behaviour)", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_CONTEXT_ENDPOINT: "https://ctx.example.com/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product, "/context?productId=prod_123"));
    const result = await fetchSignedProductContext("prod_123", env, fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts http://localhost context endpoint when ENVIRONMENT=development", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_CONTEXT_ENDPOINT: "http://localhost:8788/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "development",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product, "/context?productId=prod_123"));
    const result = await fetchSignedProductContext("prod_123", env, fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts http://localhost context endpoint when ENVIRONMENT=test", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_CONTEXT_ENDPOINT: "http://localhost:8788/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "test",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product, "/context?productId=prod_123"));
    const result = await fetchSignedProductContext("prod_123", env, fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects http://localhost context endpoint when ENVIRONMENT=production", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_CONTEXT_ENDPOINT: "http://localhost:8788/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "production",
    };
    const result = await fetchSignedProductContext("prod_123", env, vi.fn());
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("missing_config");
  });

  it("rejects http://localhost context endpoint when ENVIRONMENT and NODE_ENV are both undefined", async () => {
    const {
      ENVIRONMENT: _e,
      NODE_ENV: _n,
      ...envWithoutMode
    } = baseEnv as typeof baseEnv & {
      ENVIRONMENT?: string;
      NODE_ENV?: string;
    };
    const env = {
      ...envWithoutMode,
      AI_SDR_CONTEXT_ENDPOINT: "http://localhost:8788/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
    };
    const result = await fetchSignedProductContext("prod_123", env, vi.fn());
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("missing_config");
  });

  it("rejects http://10.0.0.5 (non-localhost http) even when ENVIRONMENT=development", async () => {
    const env = {
      ...baseEnv,
      AI_SDR_CONTEXT_ENDPOINT: "http://10.0.0.5/context",
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "development",
    };
    const result = await fetchSignedProductContext("prod_123", env, vi.fn());
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("missing_config");
  });

  it("endpoint map: accepts http://localhost entries when ENVIRONMENT=development", async () => {
    const { AI_SDR_CONTEXT_ENDPOINT: _endpoint, ...envWithoutSingle } = baseEnv;
    const env = {
      ...envWithoutSingle,
      AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
        prod_123: "http://localhost:8788/context",
      }),
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "development",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product, "/context?productId=prod_123"));
    const result = await fetchSignedProductContext("prod_123", env, fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("endpoint map: rejects http://localhost entries when ENVIRONMENT=production", async () => {
    const { AI_SDR_CONTEXT_ENDPOINT: _endpoint, ...envWithoutSingle } = baseEnv;
    const env = {
      ...envWithoutSingle,
      AI_SDR_CONTEXT_ENDPOINTS: JSON.stringify({
        prod_123: "http://localhost:8788/context",
      }),
      AI_SDR_CONTEXT_SECRET: contextSecret,
      ENVIRONMENT: "production",
    };
    const result = await fetchSignedProductContext("prod_123", env, vi.fn());
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("missing_config");
  });
});

describe("no automatic human handoff (regression lock)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("REGRESSION: normal successful chat (primary route) never sets handoff.requested", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse(product))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Here is how Ventora works." } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_rl_1", message: "hello, what does this do?" }),
      baseEnv,
      store,
      () => "msg_rl_1",
    );

    expect(response.status).toBe(200);
    const session = store.get("sess_rl_1");
    expect(session).toBeDefined();
    expect(session?.handoff.requested).toBe(false);
    expect(session?.handoff.handoffId).toBeUndefined();
  });

  it("REGRESSION: primary model failure + fallback still never sets handoff.requested", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_2",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse(product))
        .mockResolvedValueOnce(new Response("upstream error", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Fallback response." } }] }),
            { status: 200 },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_rl_2", message: "hello" }),
      baseEnv,
      store,
      () => "msg_rl_2",
    );

    expect(response.status).toBe(200);
    const session = store.get("sess_rl_2");
    expect(session).toBeDefined();
    expect(session?.handoff.requested).toBe(false);
    expect(session?.handoff.handoffId).toBeUndefined();
  });

  it("REGRESSION: escalation model route (low-confidence pricing query) never sets handoff.requested", async () => {
    // "pricing" triggers confidence=0.65 (< 0.72 threshold) and matches "Pricing" in source
    // title → selectRoute returns { kind: "escalation" }. Escalation is a MODEL route only.
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_3",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Escalation model answer." } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_rl_3", message: "pricing" }),
      baseEnv,
      store,
      () => "msg_rl_3",
    );

    expect(response.status).toBe(200);
    // Confirm the escalation route was actually taken by checking the model payload
    const openRouterCallBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { model: string; reasoning?: { effort: string } };
    expect(openRouterCallBody.model).toBe(baseEnv.AI_SDR_ESCALATION_MODEL);
    expect(openRouterCallBody.reasoning).toEqual({ effort: "medium" });

    const session = store.get("sess_rl_3");
    expect(session).toBeDefined();
    expect(session?.handoff.requested).toBe(false);
    expect(session?.handoff.handoffId).toBeUndefined();
  });

  it("REGRESSION: all model routes fail (safe fallback response) never sets handoff.requested", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_4",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse(product))
        .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
        .mockResolvedValueOnce(new Response("bad gateway", { status: 502 })),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_rl_4", message: "hello" }),
      baseEnv,
      store,
      () => "msg_rl_4",
    );

    expect(response.status).toBe(200);
    expect(
      parseSse(await response.text()).find((event) => event.event === "message.delta"),
    ).toMatchObject({ data: { delta: "I could not generate a response right now." } });
    const session = store.get("sess_rl_4");
    expect(session).toBeDefined();
    expect(session?.handoff.requested).toBe(false);
    expect(session?.handoff.handoffId).toBeUndefined();
  });

  it("REGRESSION: product context upstream failure (502) never sets handoff.requested", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_5",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("context error", { status: 500 })),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_rl_5", message: "hello" }),
      baseEnv,
      store,
    );

    expect(response.status).toBe(502);
    const session = store.get("sess_rl_5");
    expect(session).toBeDefined();
    expect(session?.handoff.requested).toBe(false);
    expect(session?.handoff.handoffId).toBeUndefined();
  });

  it("POSITIVE: explicit POST to /v1/handoff is the ONLY path that sets handoff.requested to true", async () => {
    // This positive case proves the above assertions are meaningful: handoff.requested CAN
    // become true, but only via an explicit user-initiated POST to /v1/handoff.
    const store = new MemorySessionStore();
    await store.create(
      "sess_rl_pos",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );

    const before = store.get("sess_rl_pos");
    expect(before?.handoff.requested).toBe(false);

    const handoffResponse = await handleHandoff(
      jsonRequest("/v1/handoff", {
        sessionId: "sess_rl_pos",
        message: "I want to speak to someone",
      }),
      baseEnv,
      store,
      () => "handoff_rl_pos",
    );

    expect(handoffResponse.status).toBe(202);
    const after = store.get("sess_rl_pos");
    expect(after?.handoff.requested).toBe(true);
    expect(after?.handoff.handoffId).toBe("handoff_rl_pos");
  });
});

describe("think-block stripping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // --- non-streaming (handleChat non-streaming path) ---

  it("non-streaming: strips a single <think>…</think> block from model response", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_think_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "<think>internal reasoning</think>Hello world" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_think_1", message: "hi" }),
      baseEnv,
      store,
      () => "msg_think_1",
    );

    const events = parseSse(await response.text());
    const delta = events.find((e) => e.event === "message.delta");
    expect(delta?.data).toEqual({ messageId: "msg_think_1", delta: "Hello world" });
    expect(store.get("sess_think_1")?.transcript.at(-1)?.content).toBe("Hello world");
  });

  it("non-streaming: strips multiple <think> blocks leaving only clean text", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_think_2",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "<think>step 1</think>Part A<think>step 2</think> Part B",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_think_2", message: "hi" }),
      baseEnv,
      store,
      () => "msg_think_2",
    );

    const events = parseSse(await response.text());
    const delta = events.find((e) => e.event === "message.delta");
    expect(delta?.data).toEqual({ messageId: "msg_think_2", delta: "Part A Part B" });
    expect(store.get("sess_think_2")?.transcript.at(-1)?.content).toBe("Part A Part B");
  });

  it("non-streaming: passes through content with no think block unchanged", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_think_3",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Clean response" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_think_3", message: "hi" }),
      baseEnv,
      store,
      () => "msg_think_3",
    );

    const events = parseSse(await response.text());
    const delta = events.find((e) => e.event === "message.delta");
    expect(delta?.data).toEqual({ messageId: "msg_think_3", delta: "Clean response" });
  });

  it("non-streaming: drops unterminated <think> block to end of string", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_think_4",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Before<think>incomplete reasoning" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_think_4", message: "hi" }),
      baseEnv,
      store,
      () => "msg_think_4",
    );

    const events = parseSse(await response.text());
    const delta = events.find((e) => e.event === "message.delta");
    expect(delta?.data).toEqual({ messageId: "msg_think_4", delta: "Before" });
    expect(store.get("sess_think_4")?.transcript.at(-1)?.content).toBe("Before");
  });

  it("non-streaming: content with only a think block emits empty-string delta (no visible text)", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_think_5",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "<think>only reasoning</think>" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_think_5", message: "hi" }),
      baseEnv,
      store,
      () => "msg_think_5",
    );

    const events = parseSse(await response.text());
    const delta = events.find((e) => e.event === "message.delta");
    // delta text should be empty string (stripped) — no raw <think> tags in output
    expect((delta?.data as { delta: string }).delta).not.toContain("<think>");
    expect((delta?.data as { delta: string }).delta).not.toContain("reasoning");
    expect(store.get("sess_think_5")?.transcript.at(-1)?.content).toBe("");
  });

  // --- streaming path ---

  it("streaming: strips <think>…</think> from a single-chunk stream", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_sthink_1",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"<think>reasoning</think>Hello world"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_sthink_1", message: "hi" }),
      baseEnv,
      store,
      () => "msg_sthink_1",
    );

    const allText = await response.text();
    expect(allText).not.toContain("<think>");
    expect(allText).not.toContain("reasoning");

    const deltas = parseSse(allText)
      .filter((e) => e.event === "message.delta")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Hello world");
    expect(store.get("sess_sthink_1")?.transcript.at(-1)?.content).toBe("Hello world");
  });

  it("streaming: strips <think>…</think> when tags are split across separate SSE frames", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_sthink_2",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                // "<think>" split: first chunk ends mid-tag
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n'),
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"nk>reasoning</think>Hello world"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_sthink_2", message: "hi" }),
      baseEnv,
      store,
      () => "msg_sthink_2",
    );

    const allText = await response.text();
    expect(allText).not.toContain("<think>");
    expect(allText).not.toContain("</think>");
    expect(allText).not.toContain("reasoning");

    const deltas = parseSse(allText)
      .filter((e) => e.event === "message.delta")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Hello world");
    expect(store.get("sess_sthink_2")?.transcript.at(-1)?.content).toBe("Hello world");
  });

  it("streaming: closing </think> tag split across frames is handled correctly", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_sthink_3",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"<think>reason</th"}}]}\n\n',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"ink>Clean"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_sthink_3", message: "hi" }),
      baseEnv,
      store,
      () => "msg_sthink_3",
    );

    const allText = await response.text();
    expect(allText).not.toContain("<think>");
    expect(allText).not.toContain("</think>");
    expect(allText).not.toContain("reason");

    const deltas = parseSse(allText)
      .filter((e) => e.event === "message.delta")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Clean");
    expect(store.get("sess_sthink_3")?.transcript.at(-1)?.content).toBe("Clean");
  });

  it("streaming: skips empty message.delta emissions when think block consumes entire chunk", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_sthink_4",
      { productId: "prod_123", origin: "https://product.example.com" },
      86_400,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(signedContextResponse({ ...product, plans: [], sources: [] }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                // First delta is all reasoning, second is the actual answer
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"<think>all reasoning here</think>"}}]}\n\n',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        ),
    );

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_sthink_4", message: "hi" }),
      baseEnv,
      store,
      () => "msg_sthink_4",
    );

    const allText = await response.text();
    const deltas = parseSse(allText).filter((e) => e.event === "message.delta");
    // There must be no delta with empty string from the think-only chunk
    for (const d of deltas) {
      expect((d.data as { delta: string }).delta).not.toBe("");
    }
    expect(deltas.map((e) => (e.data as { delta: string }).delta).join("")).toBe("Answer");
    expect(store.get("sess_sthink_4")?.transcript.at(-1)?.content).toBe("Answer");
  });

  // DEFECT 1: CORS headers missing on origin-check 403
  it("disallowed origin 403 on POST /v1/sessions carries CORS headers", async () => {
    const env = { ...baseEnv, AI_SDR_ALLOWED_ORIGINS: "https://product.example.com" };
    const response = await worker.fetch(
      new Request("https://worker.example.com/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({ productId: "prod_123" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBeNull();
  });

  it("disallowed origin 403 on POST /v1/chat carries CORS headers", async () => {
    const env = { ...baseEnv, AI_SDR_ALLOWED_ORIGINS: "https://product.example.com" };
    const response = await worker.fetch(
      new Request("https://worker.example.com/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({ sessionId: "s1", message: "hello" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBeNull();
  });

  it("disallowed origin 403 on POST /v1/handoff carries CORS headers", async () => {
    const env = { ...baseEnv, AI_SDR_ALLOWED_ORIGINS: "https://product.example.com" };
    const response = await worker.fetch(
      new Request("https://worker.example.com/v1/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({ sessionId: "s1" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBeNull();
  });

  // DEFECT 2: no message length cap on /v1/chat
  it("POST /v1/chat returns 400 when message exceeds 8192 characters", async () => {
    const store = new MemorySessionStore();
    const session = await store.create("sess_toolong", { productId: "prod_123" }, 86400);
    const longMessage = "a".repeat(8193);
    const response = await handleChat(
      new Request("https://worker.example.com/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, message: longMessage }),
      }),
      baseEnv,
      store,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Message too long" });
  });

  it("POST /v1/chat does not reject message at exactly 8192 characters due to length cap", async () => {
    const store = new MemorySessionStore();
    const session = await store.create("sess_exact", { productId: "prod_123" }, 86400);
    const exactMessage = "a".repeat(8192);
    // Stub fetch so context fetch returns a 500 (context unavailable) rather than throwing a
    // network error — we just need handleChat to reach past the length check without crashing.
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }));
    const response = await handleChat(
      new Request("https://worker.example.com/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, message: exactMessage }),
      }),
      baseEnv,
      store,
    );
    // Should NOT be rejected with the "Message too long" 400
    const body = (await response.json()) as { error?: string };
    expect(body.error).not.toBe("Message too long");
  });
});

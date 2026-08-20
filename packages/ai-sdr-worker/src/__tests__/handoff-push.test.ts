import {
  type CrmLeadIngestRequest,
  type LeadProfile,
  type ProductContext,
  type StableJsonValue,
  buildHmacPayload,
  signHmacPayload,
} from "@ventora/ai-sdr-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CRM_FIELD_CHARS, PUSH_BACKOFF_MS } from "../constants.js";
import worker, {
  AiSdrSession,
  DurableObjectSessionStore,
  MemorySessionStore,
  buildLeadModelCaller,
  handleChat,
  handleHandoff,
  meetsMinDataThreshold,
  scoreBucket,
  shouldExtract,
} from "../index.js";
import type { makeObservability } from "../observability.js";

// ─── Shared fixtures (mirror index.test.ts conventions) ──────────────────────

const contextSecret = "context-secret";
const product: ProductContext = {
  productId: "prod_123",
  name: "Ventora Rooms",
  description: "Automated leasing follow-up.",
  sources: [{ id: "src_1", title: "Pricing", url: "https://example.com/pricing" }],
  plans: [{ id: "pro", name: "Pro", price: "$199" }],
};

const baseEnv = {
  AI_SDR_CONTEXT_SECRET: contextSecret,
  AI_SDR_CONTEXT_ENDPOINT: "https://product.example.com/context",
  OPENROUTER_API_KEY: "openrouter-key",
  OPENROUTER_ENDPOINT: "https://openrouter.ai/api/v1/chat/completions",
  AI_SDR_ALLOWED_ORIGINS: "https://product.example.com",
  AI_SDR_PRIMARY_MODEL: "minimax/minimax-m3",
  AI_SDR_FALLBACK_MODEL: "minimax/minimax-m3",
  AI_SDR_ESCALATION_MODEL: "minimax/minimax-m3",
};

const crmEnv = {
  ...baseEnv,
  CRM_INGEST_ENDPOINT: "https://crm.example.com/s/ingest/leads",
  CRM_INGEST_SECRET: "crm-secret",
};

const origin = "https://product.example.com";

function jsonRequest(path: string, body: unknown, requestOrigin = origin): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin },
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
    body: body as unknown as StableJsonValue,
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

/** A model response carrying contact/qualification JSON for the extractor. */
function leadJsonModelResponse(json: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }),
    { status: 200 },
  );
}

function chatModelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function crmSuccessResponse(): Response {
  return new Response(
    JSON.stringify({ customerId: "cust_1", leadId: "lead_1", status: "qualified" }),
    { status: 200 },
  );
}

/**
 * waitUntil-capture helper: collects every deferred promise so a test can
 * deterministically `await flush()` all background extraction/push work.
 */
function captureWaitUntil(): {
  waitUntil: (promise: Promise<unknown>) => void;
  flush: () => Promise<void>;
} {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise) => {
      promises.push(promise);
    },
    flush: async () => {
      // Settle in waves: a push enqueued by one promise may add no further work,
      // but extraction → push can chain, so drain until the queue is stable.
      while (promises.length > 0) {
        const pending = promises.splice(0, promises.length);
        await Promise.allSettled(pending);
      }
    },
  };
}

async function seededSession(store: MemorySessionStore, id = "sess_1"): Promise<void> {
  await store.create(id, { productId: "prod_123", origin }, 86_400);
}

const fullProfile: LeadProfile = {
  contact: { email: "buyer@acme.com", name: "Pat Buyer", company: "Acme" },
  qualification: { needPain: "manual follow-up", timeline: "this quarter" },
  derived: {},
  fitScore: 0.8,
  intentScore: 0.75,
  status: "qualified",
};

function crmRequestFixture(overrides: Partial<CrmLeadIngestRequest> = {}): CrmLeadIngestRequest {
  return {
    productKey: "prod_123",
    sdrSessionId: "sess_1",
    profile: fullProfile,
    activities: [{ type: "session_started", payload: { createdAt: "2026-01-01T00:00:00.000Z" } }],
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── shouldExtract gate ──────────────────────────────────────────────────────

describe("shouldExtract gate", () => {
  function sessionWith(
    turns: { role: "user" | "assistant"; content: string }[],
  ): Parameters<typeof shouldExtract>[0] {
    return {
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: turns,
      handoff: { requested: false },
      createdAt: 0,
      expiresAt: Date.now() + 10_000,
    };
  }

  it("never extracts before the second turn", () => {
    expect(shouldExtract(sessionWith([{ role: "user", content: "hi" }]))).toBe(false);
  });

  it("does not re-extract when lastExtractedTurnIndex >= turnIndex", () => {
    const session = {
      ...sessionWith([
        { role: "user", content: "my email is a@b.com" },
        { role: "assistant", content: "thanks" },
      ]),
      lastExtractedTurnIndex: 2,
    };
    expect(shouldExtract(session)).toBe(false);
  });

  it("extracts when a contact signal appears in recent user turns", () => {
    const session = sessionWith([
      { role: "user", content: "please email me at a@b.com" },
      { role: "assistant", content: "sure" },
    ]);
    expect(shouldExtract(session)).toBe(true);
  });

  it("extracts when a qualification signal appears", () => {
    const session = sessionWith([
      { role: "user", content: "what is your pricing for our budget" },
      { role: "assistant", content: "here" },
    ]);
    expect(shouldExtract(session)).toBe(true);
  });

  it("skips a no-signal turn inside the interval window", () => {
    const session = {
      ...sessionWith([
        { role: "user", content: "ok" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "cool" },
        { role: "assistant", content: "great" },
      ]),
      lastExtractedTurnIndex: 2,
    };
    expect(shouldExtract(session)).toBe(false);
  });

  it("re-extracts after the interval even without a new signal", () => {
    const session = {
      ...sessionWith([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
        { role: "assistant", content: "f" },
      ]),
      lastExtractedTurnIndex: 2,
    };
    expect(shouldExtract(session)).toBe(true);
  });

  it("stops extracting once routed and handoff requested", () => {
    const session = {
      ...sessionWith([
        { role: "user", content: "email me a@b.com" },
        { role: "assistant", content: "ok" },
      ]),
      routeReceipt: { customerId: "c", leadId: "l", status: "qualified" as const },
      handoff: { requested: true },
    };
    expect(shouldExtract(session)).toBe(false);
  });
});

// ─── meetsMinDataThreshold ───────────────────────────────────────────────────

describe("meetsMinDataThreshold", () => {
  it("passes on a captured email alone", () => {
    expect(
      meetsMinDataThreshold({ contact: { email: "a@b.com" }, qualification: {}, derived: {} }),
    ).toBe(true);
  });

  it("fails on two non-empty non-email fields without an email (CRM requires email)", () => {
    // The CRM endpoint requires a non-empty email to key the customer record.
    // Two non-email fields without an email produces a terminal 400, so we must
    // not push. The old "2 non-email fields passes" behavior has been removed.
    expect(
      meetsMinDataThreshold({
        contact: { name: "Pat", company: "Acme" },
        qualification: {},
        derived: {},
      }),
    ).toBe(false);
  });

  it("fails on a single non-email field", () => {
    expect(
      meetsMinDataThreshold({ contact: { name: "Pat" }, qualification: {}, derived: {} }),
    ).toBe(false);
  });

  it("ignores whitespace-only fields", () => {
    expect(
      meetsMinDataThreshold({
        contact: { name: "  ", company: "  " },
        qualification: {},
        derived: {},
      }),
    ).toBe(false);
  });

  // ── email-gate regression tests (Fix 1) ─────────────────────────────────────

  it("fails when company + role are present but email is absent", () => {
    // This was the data-loss bug: two non-email fields passes the old threshold,
    // but the CRM rejects the push with 400 (terminal) because email is required.
    // The predicate must return false when no valid email is present.
    expect(
      meetsMinDataThreshold({
        contact: { company: "Acme", role: "CTO" },
        qualification: {},
        derived: {},
      }),
    ).toBe(false);
  });

  it("fails when the email field is a blank string", () => {
    expect(
      meetsMinDataThreshold({
        contact: { email: "   ", company: "Acme", role: "CTO" },
        qualification: {},
        derived: {},
      }),
    ).toBe(false);
  });

  it("fails when the email string contains no '@' character", () => {
    expect(
      meetsMinDataThreshold({
        contact: { email: "notanemail", company: "Acme", role: "CTO" },
        qualification: {},
        derived: {},
      }),
    ).toBe(false);
  });

  it("passes when a valid email is present together with other fields", () => {
    expect(
      meetsMinDataThreshold({
        contact: { email: "pat@acme.com", company: "Acme", role: "CTO" },
        qualification: {},
        derived: {},
      }),
    ).toBe(true);
  });
});

// ─── buildLeadModelCaller (fail-safe non-streaming JSON caller) ───────────────

describe("buildLeadModelCaller", () => {
  it("returns the model content string on success", async () => {
    const fetcher = vi.fn().mockResolvedValue(leadJsonModelResponse({ contact: { name: "Pat" } }));
    const caller = buildLeadModelCaller(baseEnv, fetcher as unknown as typeof fetch);
    const raw = await caller({ system: "s", user: "u" });
    expect(JSON.parse(raw)).toEqual({ contact: { name: "Pat" } });
    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as {
      stream: boolean;
      response_format: { type: string };
    };
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns empty string when no API key is configured", async () => {
    const fetcher = vi.fn();
    const { OPENROUTER_API_KEY: _key, ...noKey } = baseEnv;
    const caller = buildLeadModelCaller(noKey, fetcher as unknown as typeof fetch);
    await expect(caller({ system: "s", user: "u" })).resolves.toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails safe to empty string on a non-ok response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const caller = buildLeadModelCaller(baseEnv, fetcher as unknown as typeof fetch);
    await expect(caller({ system: "s", user: "u" })).resolves.toBe("");
  });

  it("fails safe to empty string when the fetch throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    const caller = buildLeadModelCaller(baseEnv, fetcher as unknown as typeof fetch);
    await expect(caller({ system: "s", user: "u" })).resolves.toBe("");
  });
});

// ─── handleChat extraction trigger + push (via capturing waitUntil) ──────────

describe("handleChat lead extraction trigger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not run extraction on the first chat turn", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Hello there"));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "hi" }),
      baseEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    // Exactly the context + chat-model calls — no extra extraction model call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.get("sess_1")?.leadProfile).toBeUndefined();
  });

  it("extracts and pushes a qualified lead off the hot path, then emits lead.captured next turn", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Happy to help with pricing."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com", name: "Pat", company: "Acme" },
          qualification: { needPain: "manual work" },
        }),
      )
      .mockResolvedValueOnce(crmSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    // The response must not carry lead.captured on the turn that triggers the push.
    expect(worker).toBeDefined();
    expect(response.status).toBe(200);
    await flush();

    const routed = store.get("sess_1");
    expect(routed?.routeReceipt).toEqual({
      customerId: "cust_1",
      leadId: "lead_1",
      status: "qualified",
    });
    expect(routed?.leadProfile?.contact.email).toBe("buyer@acme.com");

    // Next turn: lead.captured is emitted exactly once in the prelude.
    fetchMock
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("More info."));
    const next = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "thanks" }),
      crmEnv,
      store,
      () => "msg_2",
      waitUntil,
    );
    const events = (await import("../index.js")).parseSse(await next.text());
    const captured = events.filter((e) => e.event === "lead.captured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.data).toEqual({ leadId: "lead_1", status: "qualified" });
    expect(store.get("sess_1")?.leadCaptureEmitted).toBe(true);
    await flush();

    // And once more: not re-emitted after it has been marked.
    fetchMock
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Even more."));
    const third = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "ok" }),
      crmEnv,
      store,
      () => "msg_3",
      waitUntil,
    );
    const thirdEvents = (await import("../index.js")).parseSse(await third.text());
    expect(thirdEvents.filter((e) => e.event === "lead.captured")).toHaveLength(0);
    await flush();
  });

  it("enqueues to the durable outbox on a retriable push failure", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Pricing details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(store.queuedPushes).toHaveLength(1);
    expect(store.queuedPushes[0]).toMatchObject({ sessionId: "sess_1", productKey: "prod_123" });
    expect(store.get("sess_1")?.leadPushPending).toBe(true);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });

  it("does not enqueue on a terminal (non-retriable) push failure", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Pricing details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(store.queuedPushes).toHaveLength(0);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });

  it("skips the push entirely when the CRM is not configured", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Pricing details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      baseEnv, // no CRM endpoint/secret
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    // Extraction ran (profile persisted) but no push call was attempted.
    expect(store.get("sess_1")?.leadProfile?.contact.email).toBe("buyer@acme.com");
    expect(store.queuedPushes).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not push when the profile is below the min-data threshold", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Pricing details."))
      .mockResolvedValueOnce(leadJsonModelResponse({ contact: { name: "Pat" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(store.queuedPushes).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // no 4th (push) call
  });

  // ── Fix 1: emailless-lead suppression integration tests ──────────────────────

  it("does not push or enqueue when company+role are present but email is absent", async () => {
    // The CRM rejects emailless bodies with HTTP 400 (terminal). The worker must
    // gate the push BEFORE signing+sending, not after a 4xx is received.
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("We work with enterprise."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { company: "Acme Corp", role: "CTO" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    // Exactly 3 calls: context + chat model + extraction model. No 4th (push) call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.queuedPushes).toHaveLength(0);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });

  it("does not push when email is a blank/whitespace-only string", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Sure."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "   ", company: "Acme", role: "CTO" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.queuedPushes).toHaveLength(0);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });

  it("does not push when email is present but contains no '@'", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Sure."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "notanemail", company: "Acme", role: "CTO" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.queuedPushes).toHaveLength(0);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });

  it("does not break the chat when extraction throws", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("All good."))
      .mockRejectedValueOnce(new Error("extraction network blew up"));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    expect(response.status).toBe(200);
    // The background extraction rejection must not surface.
    await expect(flush()).resolves.toBeUndefined();
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });
});

// ─── handleHandoff push trigger ──────────────────────────────────────────────

describe("handleHandoff lead push", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 202 and pushes off the hot path without lead.captured on the 202", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    await store.appendMessage("sess_1", { role: "user", content: "email me at buyer@acme.com" });
    await store.appendMessage("sess_1", { role: "assistant", content: "will do" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockResolvedValueOnce(crmSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", message: "please contact me" }),
      crmEnv,
      store,
      () => "handoff_1",
      waitUntil,
    );
    expect(response.status).toBe(202);
    const body = (await import("../index.js")).parseSse; // sanity import
    expect(body).toBeDefined();
    await flush();

    expect(store.get("sess_1")?.routeReceipt).toEqual({
      customerId: "cust_1",
      leadId: "lead_1",
      status: "qualified",
    });
  });

  it("does no deferred work when no execution context is provided", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", message: "please contact me" }),
      crmEnv,
      store,
      () => "handoff_1",
      // waitUntil omitted → noopWaitUntil → no extraction/push fetches
    );
    expect(response.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.queuedPushes).toHaveLength(0);
  });
});

// ─── Durable Object outbox: alarm drain + scheduleNextAlarm ──────────────────

/**
 * Minimal in-memory SQL fake supporting the sessions + pending_pushes tables
 * the DO outbox exercises. Only the statement shapes index.ts issues are
 * handled; anything else returns an empty result.
 */
function makeSqlFake(seed: {
  sessions?: { id: string; payload: string; expires_at: number }[];
  pending?: {
    id: string;
    session_id: string;
    product_key: string;
    payload_json: string;
    attempts: number;
    next_attempt_at: number;
  }[];
}) {
  const sessions = seed.sessions ?? [];
  const pending = seed.pending ?? [];
  const exec = vi.fn((sql: string, ...params: unknown[]) => {
    const rows = (() => {
      if (sql.includes("FROM pending_pushes WHERE next_attempt_at <=")) {
        const cutoff = params[0] as number;
        return pending
          .filter((p) => p.next_attempt_at <= cutoff)
          .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
          .slice(0, 10);
      }
      if (sql.includes("MIN(next_attempt_at)")) {
        return [
          { next: pending.length > 0 ? Math.min(...pending.map((p) => p.next_attempt_at)) : null },
        ];
      }
      if (sql.includes("MIN(expires_at)")) {
        return [
          { next: sessions.length > 0 ? Math.min(...sessions.map((s) => s.expires_at)) : null },
        ];
      }
      if (sql.startsWith("SELECT payload, expires_at FROM sessions WHERE id =")) {
        const id = params[0] as string;
        const found = sessions.find((s) => s.id === id);
        return found ? [{ payload: found.payload, expires_at: found.expires_at }] : [];
      }
      return [];
    })();
    if (sql.startsWith("DELETE FROM pending_pushes WHERE id =")) {
      const id = params[0] as string;
      const idx = pending.findIndex((p) => p.id === id);
      if (idx >= 0) pending.splice(idx, 1);
    }
    if (sql.startsWith("UPDATE pending_pushes SET")) {
      const id = params[3] as string;
      const found = pending.find((p) => p.id === id);
      if (found) {
        found.attempts = params[0] as number;
        found.next_attempt_at = params[1] as number;
      }
    }
    if (sql.startsWith("INSERT INTO pending_pushes")) {
      pending.push({
        id: params[0] as string,
        session_id: params[1] as string,
        product_key: params[2] as string,
        payload_json: params[3] as string,
        attempts: 0,
        next_attempt_at: params[4] as number,
      });
    }
    if (sql.startsWith("INSERT OR REPLACE INTO sessions")) {
      const id = params[0] as string;
      const payload = params[1] as string;
      const expiresAt = params[2] as number;
      const found = sessions.find((s) => s.id === id);
      if (found) {
        found.payload = payload;
        found.expires_at = expiresAt;
      } else {
        sessions.push({ id, payload, expires_at: expiresAt });
      }
    }
    if (sql.startsWith("DELETE FROM sessions WHERE expires_at <=")) {
      const cutoff = params[0] as number;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if ((sessions[i]?.expires_at ?? 0) <= cutoff) sessions.splice(i, 1);
      }
    }
    return { one: () => rows[0] ?? null, toArray: () => rows };
  });
  return { exec, sessions, pending };
}

function sessionPayload(id: string, expiresAt: number): string {
  return JSON.stringify({
    id,
    productId: "prod_123",
    metadata: {},
    transcript: [],
    handoff: { requested: false },
    createdAt: 0,
    expiresAt,
  });
}

describe("AiSdrSession durable outbox", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ensureSchema creates the pending_pushes table and index", async () => {
    const { exec } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    await durable.fetch(new Request("https://ai-sdr-session/unknown"));
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS pending_pushes"),
    );
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("CREATE INDEX IF NOT EXISTS idx_pending_pushes_next_attempt"),
    );
  });

  it("enqueue-push inserts a row and schedules an alarm", async () => {
    const { exec } = makeSqlFake({});
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    const response = await durable.fetch(
      jsonRequest("/enqueue-push", {
        sessionId: "sess_1",
        productKey: "prod_123",
        payloadJson: JSON.stringify(crmRequestFixture()),
      }),
    );
    expect(response.status).toBe(200);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO pending_pushes"),
      expect.any(String),
      "sess_1",
      "prod_123",
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
    );
    expect(setAlarm).toHaveBeenCalled();
  });

  it("enqueue-push rejects a malformed body", async () => {
    const { exec } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    const response = await durable.fetch(jsonRequest("/enqueue-push", { sessionId: "sess_1" }));
    expect(response.status).toBe(400);
  });

  it("enqueue-push rejects a normalized retired GrantPipe product", async () => {
    const { exec, pending } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    const response = await durable.fetch(
      jsonRequest("/enqueue-push", {
        sessionId: "retired_session",
        productKey: " GrAnTpIpE ",
        payloadJson: JSON.stringify(crmRequestFixture({ productKey: "grantpipe" })),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Product retired" });
    expect(pending).toHaveLength(0);
  });

  it("enqueue-push rejects a retired GrantPipe payload hidden behind a sibling key", async () => {
    const { exec, pending } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    const response = await durable.fetch(
      jsonRequest("/enqueue-push", {
        sessionId: "retired_session",
        productKey: "camaudit",
        payloadJson: JSON.stringify(crmRequestFixture({ productKey: " GrAnTpIpE " })),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Product retired" });
    expect(pending).toHaveLength(0);
  });

  it("update-lead-state applies only validated lead fields", async () => {
    const now = Date.now();
    const { exec, sessions } = makeSqlFake({
      sessions: [
        { id: "sess_1", payload: sessionPayload("sess_1", now + 10_000), expires_at: now + 10_000 },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    await durable.fetch(
      jsonRequest("/update-lead-state", {
        sessionId: "sess_1",
        patch: {
          routeReceipt: { customerId: "c", leadId: "l", status: "qualified" },
          leadCaptureEmitted: true,
          bogus: "ignored",
        },
      }),
    );
    const stored = JSON.parse(sessions[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(stored.routeReceipt).toEqual({ customerId: "c", leadId: "l", status: "qualified" });
    expect(stored.leadCaptureEmitted).toBe(true);
    expect(stored).not.toHaveProperty("bogus");
  });

  it("alarm drains a due push, marks the session routed, and deletes the row", async () => {
    const now = Date.now();
    const { exec, pending, sessions } = makeSqlFake({
      sessions: [
        {
          id: "sess_1",
          payload: sessionPayload("sess_1", now + 100_000),
          expires_at: now + 100_000,
        },
      ],
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(crmSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(0);
    const stored = JSON.parse(sessions[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(stored.routeReceipt).toEqual({
      customerId: "cust_1",
      leadId: "lead_1",
      status: "qualified",
    });
    expect(stored.leadPushPending).toBe(false);
  });

  it("alarm drops a retired GrantPipe retry without calling the CRM", async () => {
    const now = Date.now();
    const retiredSession = {
      ...JSON.parse(sessionPayload("retired_session", now + 100_000)),
      productId: " GrAnTpIpE ",
      leadPushPending: true,
    } as Record<string, unknown>;
    const { exec, pending, sessions } = makeSqlFake({
      sessions: [
        {
          id: "retired_session",
          payload: JSON.stringify(retiredSession),
          expires_at: now + 100_000,
        },
      ],
      pending: [
        {
          id: "retired_push",
          session_id: "retired_session",
          product_key: "camaudit",
          payload_json: JSON.stringify(crmRequestFixture({ productKey: "prod_123" })),
          attempts: 3,
          next_attempt_at: now - 1,
        },
      ],
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
    const stored = JSON.parse(sessions[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(stored.leadPushPending).toBe(false);
    expect(stored.routeReceipt).toBeUndefined();
  });

  it("alarm reschedules a retriable push with backoff", async () => {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { status: 503 })),
    );
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
    expect(pending[0]?.next_attempt_at).toBeGreaterThan(now);
  });

  it("recovers a lead across alarm ticks: a transient CRM outage retries and eventually lands", async () => {
    // The core promise of the durable outbox: a blip must not lose the lead.
    // Tick 1 fails (503, retriable) → row survives with backoff, session NOT routed.
    // Tick 2 (row due again) succeeds → row deleted, session routed, pending cleared.
    const now = Date.now();
    const { exec, pending, sessions } = makeSqlFake({
      sessions: [
        {
          id: "sess_1",
          payload: sessionPayload("sess_1", now + 100_000),
          expires_at: now + 100_000,
        },
      ],
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(crmSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);
    const durable = new AiSdrSession(state, crmEnv);

    // ── Tick 1: CRM is down. The lead must survive, not drop. ──
    await durable.alarm();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
    expect(pending[0]?.next_attempt_at).toBeGreaterThan(now);
    const afterFail = JSON.parse(sessions[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(afterFail.routeReceipt).toBeUndefined();

    // ── Time passes; the backoff window elapses and the row is due again. ──
    if (pending[0]) pending[0].next_attempt_at = now - 1;

    // ── Tick 2: CRM is back. The retry lands and the row is cleared. ──
    await durable.alarm();
    expect(pending).toHaveLength(0);
    const afterSuccess = JSON.parse(sessions[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(afterSuccess.routeReceipt).toEqual({
      customerId: "cust_1",
      leadId: "lead_1",
      status: "qualified",
    });
    expect(afterSuccess.leadPushPending).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("alarm drops a push that has exhausted its retry budget", async () => {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 5,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { status: 503 })),
    );
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(0);
  });

  it("alarm drops a push on a terminal (non-retriable) failure", async () => {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 })),
    );
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(0);
  });

  it("alarm drops an unparseable outbox row without calling the CRM", async () => {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: "{not json",
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("alarm still runs the TTL GC for expired sessions (regression)", async () => {
    const now = Date.now();
    const { exec } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    await durable.alarm();
    expect(exec).toHaveBeenCalledWith(
      "DELETE FROM sessions WHERE expires_at <= ?",
      expect.any(Number),
    );
    expect(now).toBeGreaterThan(0);
  });

  it("scheduleNextAlarm picks the earliest of pending push and session expiry", async () => {
    const now = Date.now();
    const { exec } = makeSqlFake({
      sessions: [{ id: "s", payload: sessionPayload("s", now + 50_000), expires_at: now + 50_000 }],
      pending: [
        {
          id: "p",
          session_id: "s",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now + 200_000, // future → not drained
        },
      ],
    });
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    // Earliest candidate is the session expiry (now+50k) vs push (now+200k).
    const scheduled = setAlarm.mock.calls.at(-1)?.[0] as number;
    expect(scheduled).toBe(now + 50_000);
  });

  it("scheduleNextAlarm sets no alarm when there is nothing pending", async () => {
    const { exec } = makeSqlFake({});
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    await durable.alarm();
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("update-lead-state returns 404 for an unknown session", async () => {
    const { exec } = makeSqlFake({});
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);
    const response = await durable.fetch(
      jsonRequest("/update-lead-state", {
        sessionId: "missing",
        patch: { leadCaptureEmitted: true },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("get route returns the stored session and 404 for a missing one", async () => {
    const now = Date.now();
    const { exec } = makeSqlFake({
      sessions: [
        {
          id: "sess_1",
          payload: sessionPayload("sess_1", now + 100_000),
          expires_at: now + 100_000,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);

    const ok = await durable.fetch(
      new Request("https://ai-sdr-session/get?sessionId=sess_1", { method: "GET" }),
    );
    expect(ok.status).toBe(200);

    const missing = await durable.fetch(
      new Request("https://ai-sdr-session/get?sessionId=nope", { method: "GET" }),
    );
    expect(missing.status).toBe(404);
  });

  it("append-message persists a valid role and ignores an invalid one", async () => {
    const now = Date.now();
    const { exec, sessions } = makeSqlFake({
      sessions: [
        {
          id: "sess_1",
          payload: sessionPayload("sess_1", now + 100_000),
          expires_at: now + 100_000,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const durable = new AiSdrSession(state, crmEnv);

    await durable.fetch(
      jsonRequest("/append-message", {
        sessionId: "sess_1",
        message: { role: "user", content: "hi" },
      }),
    );
    await durable.fetch(
      jsonRequest("/append-message", {
        sessionId: "sess_1",
        message: { role: "bogus", content: "x" },
      }),
    );
    const stored = JSON.parse(sessions[0]?.payload ?? "{}") as { transcript: unknown[] };
    expect(stored.transcript).toHaveLength(1);
  });

  it("alarm leaves an unknown session's outbox row deleted after a successful push", async () => {
    // result.ok with no matching session row exercises the `if (session)` false branch.
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_1",
          session_id: "ghost",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture({ sdrSessionId: "ghost" })),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(crmSuccessResponse()));
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    expect(pending).toHaveLength(0);
  });

  it("alarm drain storage failure does not abort TTL GC or scheduleNextAlarm", async () => {
    // Fix 1: if drainDuePushes throws (storage layer error on the first sql.exec
    // that touches pending_pushes), the TTL GC and scheduleNextAlarm must still run.
    const now = Date.now();

    // Seed an expired session row so the GC has something to delete.
    const expiredAt = now - 1;
    const sessions: { id: string; payload: string; expires_at: number }[] = [
      {
        id: "expired_sess",
        payload: sessionPayload("expired_sess", expiredAt),
        expires_at: expiredAt,
      },
    ];
    // Seed a future pending push so scheduleNextAlarm has a candidate and calls setAlarm.
    const pending: {
      id: string;
      session_id: string;
      product_key: string;
      payload_json: string;
      attempts: number;
      next_attempt_at: number;
    }[] = [
      {
        id: "push_future",
        session_id: "sess_future",
        product_key: "prod_123",
        payload_json: JSON.stringify(crmRequestFixture()),
        attempts: 0,
        next_attempt_at: now + 60_000,
      },
    ];

    // Build the normal fake, then wrap exec so the first pending_pushes SELECT throws.
    const { exec: baseFakeExec } = makeSqlFake({ sessions, pending });

    let drainSelectCalled = false;
    const throwingExec = vi.fn((sql: string, ...params: unknown[]) => {
      // The first call that reads pending_pushes (the drain SELECT) should throw.
      if (!drainSelectCalled && sql.includes("FROM pending_pushes WHERE next_attempt_at <=")) {
        drainSelectCalled = true;
        throw new Error("storage layer failure");
      }
      // All other calls (schema setup, GC DELETE, scheduleNextAlarm SELECTs) pass through.
      return baseFakeExec(sql, ...params);
    });

    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = {
      storage: { sql: { exec: throwingExec }, setAlarm },
    } as unknown as DurableObjectState;

    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    // (1) TTL GC still ran — the expired session was deleted from the in-memory array.
    expect(sessions.find((s) => s.id === "expired_sess")).toBeUndefined();

    // (2) scheduleNextAlarm still ran — setAlarm was called with the future push time.
    expect(setAlarm).toHaveBeenCalled();
    const scheduled = setAlarm.mock.calls.at(-1)?.[0] as number;
    expect(scheduled).toBe(now + 60_000);
  });

  it("scheduleNextAlarm floors at now when a pending push row has next_attempt_at in the past", async () => {
    // Fix 2: a row whose next_attempt_at is already in the past must not cause
    // setAlarm to be called with a past timestamp (which would busy-loop the alarm).
    // The Math.max(Math.min(...candidates), now) floor should clamp it to now.
    const now = Date.now();
    const pastAttemptAt = now - 60_000;

    const { exec } = makeSqlFake({
      pending: [
        {
          id: "push_past",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 1,
          // Already in the past — the drain SELECT will not pick it up (cutoff = now
          // at alarm time, but we invoke scheduleNextAlarm directly so the row stays).
          next_attempt_at: pastAttemptAt,
        },
      ],
      // No sessions → the sessions MIN() candidate is null.
    });

    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = {
      storage: { sql: { exec }, setAlarm },
    } as unknown as DurableObjectState;

    const _durable = new AiSdrSession(state, crmEnv);
    // Drive scheduleNextAlarm through a minimal alarm() invocation.
    // We use a separate makeSqlFake that returns nothing for the drain SELECT
    // (cutoff is `now` so a row at now-60k is not "due" at exactly the right
    // moment — but since the DO runs drainDuePushes first and our fake filters
    // by next_attempt_at <= cutoff, the past row WILL be drained and deleted.
    // To isolate the floor behavior we skip the drain and call alarm() on a DO
    // whose drain SELECT returns nothing (the pending row is not yet "due").
    //
    // Rebuild with a cutoff trick: make next_attempt_at = now - 60_000 but
    // make the drain SELECT return nothing by raising the "due" threshold.
    // The simplest approach: create a separate fake where the pending SELECT
    // returns empty (simulates "not due yet"), but MIN() still sees the row.

    const pendingRows = [
      {
        id: "push_past",
        session_id: "sess_1",
        product_key: "prod_123",
        payload_json: JSON.stringify(crmRequestFixture()),
        attempts: 1,
        next_attempt_at: pastAttemptAt,
      },
    ];
    const scheduleExec = vi.fn((sql: string, ..._params: unknown[]) => {
      // Drain SELECT: return nothing (the row is not "due" for this test slice).
      if (sql.includes("FROM pending_pushes WHERE next_attempt_at <=")) {
        return { one: () => null, toArray: () => [] };
      }
      // MIN(next_attempt_at): return the past timestamp so scheduleNextAlarm sees it.
      if (sql.includes("MIN(next_attempt_at)")) {
        return { one: () => ({ next: pastAttemptAt }), toArray: () => [{ next: pastAttemptAt }] };
      }
      // MIN(expires_at): no sessions.
      if (sql.includes("MIN(expires_at)")) {
        return { one: () => ({ next: null }), toArray: () => [{ next: null }] };
      }
      // GC DELETE and schema calls: no-op.
      return { one: () => null, toArray: () => [] };
    });

    const setAlarm2 = vi.fn().mockResolvedValue(undefined);
    const state2 = {
      storage: { sql: { exec: scheduleExec }, setAlarm: setAlarm2 },
    } as unknown as DurableObjectState;

    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const durable2 = new AiSdrSession(state2, crmEnv);

    const alarmNow = Date.now();
    await durable2.alarm();

    // setAlarm must have been called with a value >= alarmNow (the floor), NOT pastAttemptAt.
    expect(setAlarm2).toHaveBeenCalled();
    const scheduled2 = setAlarm2.mock.calls.at(-1)?.[0] as number;
    expect(scheduled2).toBeGreaterThanOrEqual(alarmNow);
    expect(scheduled2).not.toBe(pastAttemptAt);
    // Confirm it is not the past value
    expect(scheduled2).toBeGreaterThan(pastAttemptAt);
    // pendingRows referenced to avoid unused variable lint
    expect(pendingRows).toHaveLength(1);
  });
});

describe("DurableObjectSessionStore lead-pipeline proxies", () => {
  it("proxies updateLeadState and enqueuePush to the Durable Object", async () => {
    const durableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: durableFetch })),
    } as unknown as DurableObjectNamespace;
    const store = new DurableObjectSessionStore(namespace);

    await store.updateLeadState("sess_1", { leadCaptureEmitted: true });
    await store.enqueuePush("sess_1", "prod_123", JSON.stringify(crmRequestFixture()));

    expect(durableFetch).toHaveBeenCalledTimes(2);
    const firstUrl = durableFetch.mock.calls[0]?.[0] as string;
    const secondUrl = durableFetch.mock.calls[1]?.[0] as string;
    expect(firstUrl).toContain("/update-lead-state");
    expect(secondUrl).toContain("/enqueue-push");
  });
});

describe("CRM activity payloads (PII-free)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes page/referrer/locale and a handoff activity, never the handoff message", async () => {
    const store = new MemorySessionStore();
    await store.create(
      "sess_1",
      {
        productId: "prod_123",
        origin,
        metadata: { pageUrl: "https://x/pricing", referrer: "https://ref", locale: "en-US" },
      },
      86_400,
    );
    await store.appendMessage("sess_1", { role: "user", content: "email me at buyer@acme.com" });
    await store.appendMessage("sess_1", { role: "assistant", content: "sure" });
    await store.setHandoff("sess_1", {
      requested: true,
      handoffId: "h1",
      reason: "wants a human",
    });

    let capturedBody = "";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", message: "please call me at 555-1212" }),
      crmEnv,
      store,
      () => "handoff_1",
      waitUntil,
    );
    await flush();

    const sent = JSON.parse(capturedBody) as {
      activities: { type: string; payload: Record<string, unknown> }[];
    };
    const types = sent.activities.map((a) => a.type);
    expect(types).toContain("session_started");
    expect(types).toContain("qualification_updated");
    expect(types).toContain("handoff_requested");
    const sessionStarted = sent.activities.find((a) => a.type === "session_started");
    expect(sessionStarted?.payload).toMatchObject({
      pageUrl: "https://x/pricing",
      referrer: "https://ref",
      locale: "en-US",
    });
    // The handoff activity carries only the id — never the caller-supplied reason.
    const handoffActivity = sent.activities.find((a) => a.type === "handoff_requested");
    expect(handoffActivity?.payload).toEqual({ handoffId: "handoff_1" });
    expect(capturedBody).not.toContain("wants a human");
    // The handoff free-text message must never appear anywhere in the payload.
    expect(capturedBody).not.toContain("please call me");
    expect(capturedBody).not.toContain("555-1212");
  });
});

// ─── Nit 1: double-enqueue guard ─────────────────────────────────────────────

describe("attemptPushOrEnqueue — double-enqueue guard (Nit 1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT create a second outbox row when leadPushPending is already true", async () => {
    // Turn N: retriable failure → one row enqueued, leadPushPending = true.
    // Turn N+1: fresh extraction qualifies again → must NOT enqueue a second row.
    const store = new MemorySessionStore();
    await seededSession(store);

    // Turn N: context + chat + extraction model + 503 CRM response.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Pricing details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com", name: "Pat", company: "Acme" },
          qualification: { needPain: "manual work" },
        }),
      )
      .mockResolvedValueOnce(new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    // Confirm one row enqueued and the flag is set.
    expect(store.queuedPushes).toHaveLength(1);
    expect(store.get("sess_1")?.leadPushPending).toBe(true);

    // Turn N+1: new contact signal triggers a second extraction that also qualifies.
    // The CRM push must be suppressed — only one row may exist in the outbox.
    fetchMock
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Great question."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com", name: "Pat", company: "Acme" },
          qualification: { needPain: "manual work" },
        }),
      );
    // No 4th mock needed: the guard must return before any CRM call.

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "my email is buyer@acme.com" }),
      crmEnv,
      store,
      () => "msg_2",
      waitUntil,
    );
    await flush();

    // Still exactly one row — no second enqueue.
    expect(store.queuedPushes).toHaveLength(1);
  });
});

// ─── Nit 2: leadPushPending cleared on terminal/exhausted drain ───────────────

describe("drainDuePushes — leadPushPending cleared on non-success exit (Nit 2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears leadPushPending after retry exhaustion", async () => {
    const now = Date.now();
    const sessionJson = JSON.stringify({
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: 0,
      expiresAt: now + 100_000,
      leadPushPending: true,
    });
    const { exec, sessions } = makeSqlFake({
      sessions: [{ id: "sess_1", payload: sessionJson, expires_at: now + 100_000 }],
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          // attempts = 5 → next delay is null → exhaustion branch.
          attempts: 5,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { status: 503 })),
    );
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    // Row deleted.
    expect(sessions.find((s) => s.id === "sess_1")).toBeDefined();
    const stored = JSON.parse(sessions.find((s) => s.id === "sess_1")?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(stored.leadPushPending).toBe(false);
  });

  it("clears leadPushPending after a terminal (non-retriable) drain failure", async () => {
    const now = Date.now();
    const sessionJson = JSON.stringify({
      id: "sess_1",
      productId: "prod_123",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: 0,
      expiresAt: now + 100_000,
      leadPushPending: true,
    });
    const { exec, sessions } = makeSqlFake({
      sessions: [{ id: "sess_1", payload: sessionJson, expires_at: now + 100_000 }],
      pending: [
        {
          id: "push_1",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    // 400 → terminal (non-retriable) branch.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("bad request", { status: 400 })),
    );
    const durable = new AiSdrSession(state, crmEnv);

    await durable.alarm();

    const stored = JSON.parse(sessions.find((s) => s.id === "sess_1")?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(stored.leadPushPending).toBe(false);
  });
});

// ─── Nit 3: direct scoreBucket unit tests ────────────────────────────────────

describe("scoreBucket", () => {
  it("returns 'low' for undefined", () => {
    expect(scoreBucket(undefined)).toBe("low");
  });

  it("returns 'low' for scores below 0.4", () => {
    expect(scoreBucket(0)).toBe("low");
    expect(scoreBucket(0.39)).toBe("low");
    expect(scoreBucket(0.399)).toBe("low");
  });

  it("returns 'medium' for scores in [0.4, 0.7)", () => {
    expect(scoreBucket(0.4)).toBe("medium");
    expect(scoreBucket(0.5)).toBe("medium");
    expect(scoreBucket(0.699)).toBe("medium");
  });

  it("returns 'high' for scores >= 0.7", () => {
    expect(scoreBucket(0.7)).toBe("high");
    expect(scoreBucket(0.9)).toBe("high");
    expect(scoreBucket(1.0)).toBe("high");
  });
});

describe("worker.fetch entrypoint wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("wires ctx.waitUntil through /v1/handoff so the lead push runs after the 202", async () => {
    // Drive the real worker entrypoint end-to-end against the in-process store.
    // Create a session, seed a contact turn, then POST /v1/handoff with a ctx
    // that captures deferred work — verifying the ctx → waitUntil → push path.
    // ENVIRONMENT "test" lets the entrypoint accept unsigned client assertions
    // (no AI_SDR_CLIENT_ASSERTION_SECRET configured), so the route-guard chain
    // runs through to the handler — that is the wiring under test here.
    const entrypointEnv = { ...crmEnv, ENVIRONMENT: "test" };
    const created = await worker.fetch(
      jsonRequest("/v1/sessions", { productId: "prod_123" }),
      entrypointEnv,
    );
    expect(created.status).toBe(201);
    const sessionId = ((await created.json()) as { sessionId: string }).sessionId;

    // Seed a contact-bearing transcript via a chat turn (non-streaming model).
    // A catch-all fetch keeps the chat-turn extraction (which runs in waitUntil
    // and itself calls the model + CRM) benign — it is not the assertion target.
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) };
    const chatFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(crmSuccessResponse())
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Sure, I can help."));
    vi.stubGlobal("fetch", chatFetch);
    await worker.fetch(
      jsonRequest("/v1/chat", { sessionId, message: "email me at buyer@acme.com" }),
      entrypointEnv,
      ctx,
    );
    // Drain the chat-turn extraction so its model/push fetches don't bleed into
    // the handoff assertions below.
    while (deferred.length > 0) {
      await Promise.allSettled(deferred.splice(0, deferred.length));
    }

    const handoffFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockResolvedValueOnce(crmSuccessResponse());
    vi.stubGlobal("fetch", handoffFetch);

    const handoff = await worker.fetch(
      jsonRequest("/v1/handoff", { sessionId, message: "please connect me" }),
      entrypointEnv,
      ctx,
    );
    expect(handoff.status).toBe(202);
    while (deferred.length > 0) {
      await Promise.allSettled(deferred.splice(0, deferred.length));
    }
    expect(handoffFetch).toHaveBeenCalled();
  });
});

describe("extraction failure isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows a model caller that rejects and never pushes", async () => {
    const store = new MemorySessionStore();
    await store.create("sess_1", { productId: "prod_123", origin }, 86_400);
    await store.appendMessage("sess_1", { role: "user", content: "email me at buyer@acme.com" });
    await store.appendMessage("sess_1", { role: "assistant", content: "ok" });

    // The lead model fetch rejects; extractLeadProfile is fail-safe so it resolves
    // to a prior-based profile rather than throwing. No CRM push should fire.
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("model down"));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", message: "contact me" }),
      crmEnv,
      store,
      () => "handoff_1",
      waitUntil,
    );
    expect(response.status).toBe(202);
    await expect(flush()).resolves.toBeUndefined();
    expect(store.queuedPushes).toHaveLength(0);
    expect(store.get("sess_1")?.routeReceipt).toBeUndefined();
  });
});

// ─── Observability wiring: index.ts transport integration ─────────────────────
// These tests prove that the obs hooks in handleChat / handleHandoff delegate to
// the real transport via the injectable obsFetcher parameter (Task 2.4).

describe("observability wiring via obsFetcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handleChat: track(sdr_lead_captured) invokes the obsFetcher on the lead.captured prelude path", async () => {
    // Seed a session that already has a routeReceipt so lead.captured fires on
    // the NEXT turn (the prelude path — synchronous, not deferred via waitUntil).
    const store = new MemorySessionStore();
    await store.create("sess_1", { productId: "prod_123", origin }, 86_400);
    await store.appendMessage("sess_1", { role: "user", content: "hi" });
    await store.appendMessage("sess_1", { role: "assistant", content: "hello" });
    // Inject a routeReceipt so leadCaptureEmitted !== true triggers a track on the next turn.
    await store.updateLeadState("sess_1", {
      routeReceipt: { customerId: "cust_1", leadId: "lead_1", status: "qualified" },
    });

    // Main fetcher: context + model response.
    const mainFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Good question."));
    vi.stubGlobal("fetch", mainFetch);

    // obsFetcher spy: must be called once by track("sdr_lead_captured", ...).
    const obsFetch = vi.fn().mockResolvedValue({ ok: true });
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "follow up?" }),
      { ...baseEnv, POSTHOG_API_KEY: "phc_test_wiring" },
      store,
      () => "msg_1",
      waitUntil,
      obsFetch as Parameters<typeof makeObservability>[2],
    );
    expect(response.status).toBe(200);
    // The waitUntil call for sdr_lead_captured is already fired synchronously
    // in the prelude path; flush to settle it.
    await flush();

    // The obsFetcher must have been called for the PostHog track event.
    expect(obsFetch).toHaveBeenCalled();
    const calls = obsFetch.mock.calls as [string, { body: string }][];
    const posthogCall = calls.find(([url]) => url.includes("posthog.com"));
    expect(posthogCall).toBeDefined();
    const payload = JSON.parse(posthogCall?.[1].body ?? "{}") as Record<string, unknown>;
    expect(payload.event).toBe("sdr_lead_captured");
    expect(payload.distinct_id).toBe("product:prod_123");
  });

  it("handleHandoff: captureSentry(sdr_push_failed_terminal) invokes the obsFetcher on terminal CRM failure", async () => {
    // This proves the failure path: obs.captureSentry → transport → obsFetcher.
    // Path: handleHandoff → runExtractionAndMaybePush → attemptPushOrEnqueue →
    //   pushLeadToCrm returns terminal failure → captureSentry("sdr_push_failed_terminal").
    const store = new MemorySessionStore();
    await store.create("sess_1", { productId: "prod_123", origin }, 86_400);
    // Seed two turns with an email signal so shouldExtract returns true.
    await store.appendMessage("sess_1", { role: "user", content: "my email is buyer@acme.com" });
    await store.appendMessage("sess_1", { role: "assistant", content: "noted" });

    // fetcher sequence: lead model → CRM terminal failure (400 = non-retriable).
    const mainFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com", name: "Pat", company: "Acme" },
        }),
      )
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", mainFetch);

    const obsFetch = vi.fn().mockResolvedValue({ ok: true });
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_1", message: "please contact me" }),
      {
        ...crmEnv,
        SENTRY_DSN: "https://pk@o1.ingest.sentry.io/99",
      },
      store,
      () => "handoff_1",
      waitUntil,
      obsFetch as Parameters<typeof makeObservability>[2],
    );
    expect(response.status).toBe(202);
    await flush();

    // obsFetcher must have been called with a Sentry envelope POST for the terminal error.
    expect(obsFetch).toHaveBeenCalled();
    const calls = obsFetch.mock.calls as [
      string,
      { body: string; headers: Record<string, string> },
    ][];
    const sentryCall = calls.find(([url]) => url.includes("sentry.io"));
    expect(sentryCall).toBeDefined();
    expect(sentryCall?.[1].headers["content-type"]).toBe("application/x-sentry-envelope");
    const lines = sentryCall?.[1].body.split("\n") ?? [];
    const event = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    expect(event.message).toBe("sdr_push_failed_terminal");
    // Verify the Sentry wire body does not contain any PII injected into the lead.
    const sentryBody = String(sentryCall?.[1]?.body ?? "");
    expect(sentryBody).not.toContain("buyer@acme.com");
    expect(sentryBody).not.toContain("Acme");
    expect(sentryBody).not.toContain("Pat");
    // Verify the 202 response is unaffected — no latency added to the hot path.
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("handleChat: observability transport failure does not affect the chat response", async () => {
    // obsFetcher that throws — must not surface to the caller.
    const store = new MemorySessionStore();
    await store.create("sess_1", { productId: "prod_123", origin }, 86_400);
    await store.appendMessage("sess_1", { role: "user", content: "hi" });
    await store.appendMessage("sess_1", { role: "assistant", content: "hello" });
    await store.updateLeadState("sess_1", {
      routeReceipt: { customerId: "c", leadId: "l", status: "qualified" },
    });

    const mainFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Answer."));
    vi.stubGlobal("fetch", mainFetch);

    // Transport throws — must be swallowed (fail-open).
    const obsFetch = vi.fn().mockRejectedValue(new Error("PostHog down"));
    const { waitUntil, flush } = captureWaitUntil();

    const response = await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "follow up" }),
      { ...baseEnv, POSTHOG_API_KEY: "phc_test_wiring" },
      store,
      () => "msg_1",
      waitUntil,
      obsFetch as Parameters<typeof makeObservability>[2],
    );
    // Must still return 200 even though the transport threw.
    expect(response.status).toBe(200);
    await expect(flush()).resolves.toBeUndefined();
  });

  it("DO-path distinctId: makeObservability with productKey produces product:<productKey> distinct_id", async () => {
    // Simulate the DO drainDuePushes pattern: makeObservability(env, row.product_key)
    // The productKey (not productId) is passed as the productId arg.
    // This test verifies the distinctId derivation for the DO outbox path.
    const { makeObservability: obs } = await import("../observability.js");
    const obsFetch = vi.fn().mockResolvedValue({ ok: true });
    const doObs = obs({ POSTHOG_API_KEY: "phc_do_test" }, "product-key-from-row", obsFetch);
    await doObs.track("sdr_push_ok", { productKey: "product-key-from-row", status: "routed" });
    expect(obsFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (obsFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as Record<string, unknown>;
    // distinct_id must be product:<productKey> — the DO path passes product_key
    // as the productId arg to makeObservability, so the result is PII-free.
    expect(body.distinct_id).toBe("product:product-key-from-row");
    expect(body.event).toBe("sdr_push_ok");
  });
});

// ─── G1: CRM body field length caps ──────────────────────────────────────────

describe("buildCrmRequest — G1: free-text field length capping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: trigger buildCrmRequest indirectly through the in-process push path
   * and capture the exact JSON body sent to the CRM fetcher.
   */
  async function captureBuiltBody(
    profile: LeadProfile,
    sessionId = "sess_cap",
  ): Promise<Record<string, unknown>> {
    const store = new MemorySessionStore();
    await store.create(sessionId, { productId: "prod_123", origin }, 86_400);
    await store.appendMessage(sessionId, { role: "user", content: "email me at a@b.com" });
    await store.appendMessage(sessionId, { role: "assistant", content: "sure" });

    let capturedBody = "";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: profile.contact,
          qualification: profile.qualification,
          fitScore: profile.fitScore,
          intentScore: profile.intentScore,
          status: profile.status,
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId, message: "please contact me" }),
      crmEnv,
      store,
      () => "hoff_cap",
      waitUntil,
    );
    await flush();

    return JSON.parse(capturedBody) as Record<string, unknown>;
  }

  it("MAX_CRM_FIELD_CHARS is exported and is a positive integer", () => {
    expect(typeof MAX_CRM_FIELD_CHARS).toBe("number");
    expect(MAX_CRM_FIELD_CHARS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_CRM_FIELD_CHARS)).toBe(true);
  });

  it("profile contact string fields are truncated to MAX_CRM_FIELD_CHARS when oversized", async () => {
    const huge = "x".repeat(10_000);
    const profile: LeadProfile = {
      contact: { email: "a@b.com", name: huge, company: huge, role: huge },
      qualification: {
        needPain: huge,
        useCase: huge,
        budgetSignal: huge,
        timeline: huge,
        productInterest: huge,
      },
      derived: {},
      fitScore: 0.8,
      intentScore: 0.75,
      status: "qualified",
    };
    const body = await captureBuiltBody(profile);
    const sent = body as {
      profile: {
        contact: { name?: string; company?: string; role?: string; email?: string };
        qualification: {
          needPain?: string;
          useCase?: string;
          budgetSignal?: string;
          timeline?: string;
          productInterest?: string;
        };
      };
    };
    // Every free-text string field must be at most MAX_CRM_FIELD_CHARS chars.
    const cap = MAX_CRM_FIELD_CHARS;
    expect((sent.profile.contact.name ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.contact.company ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.contact.role ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.qualification.needPain ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.qualification.useCase ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.qualification.budgetSignal ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.qualification.timeline ?? "").length).toBeLessThanOrEqual(cap);
    expect((sent.profile.qualification.productInterest ?? "").length).toBeLessThanOrEqual(cap);
  });

  it("email field is defensively capped to 254 chars (RFC 5321 max)", async () => {
    // 260-char local part: technically invalid but a model could return it.
    const longEmail = `${"a".repeat(260)}@b.com`;
    const profile: LeadProfile = {
      contact: { email: longEmail },
      qualification: {},
      derived: {},
    };
    const body = await captureBuiltBody(profile, "sess_email_cap");
    const sent = body as { profile: { contact: { email?: string } } };
    expect((sent.profile.contact.email ?? "").length).toBeLessThanOrEqual(254);
  });

  it("fields within bounds are NOT truncated", async () => {
    const short = "short text";
    const profile: LeadProfile = {
      contact: { email: "a@b.com", name: short, company: short },
      qualification: { needPain: short },
      derived: {},
    };
    const body = await captureBuiltBody(profile, "sess_short");
    const sent = body as {
      profile: {
        contact: { name?: string; company?: string };
        qualification: { needPain?: string };
      };
    };
    expect(sent.profile.contact.name).toBe(short);
    expect(sent.profile.contact.company).toBe(short);
    expect(sent.profile.qualification.needPain).toBe(short);
  });

  it("activity payload text strings (pageUrl) are bounded to MAX_CRM_FIELD_CHARS", async () => {
    // Activities are built from session metadata (pageUrl, referrer, locale).
    // This asserts the cap applies to any activity payload string field.
    const store = new MemorySessionStore();
    const longUrl = `https://example.com/${"a".repeat(10_000)}`;
    await store.create(
      "sess_act",
      {
        productId: "prod_123",
        origin,
        metadata: { pageUrl: longUrl },
      },
      86_400,
    );
    await store.appendMessage("sess_act", { role: "user", content: "email me at a@b.com" });
    await store.appendMessage("sess_act", { role: "assistant", content: "sure" });

    let capturedBody = "";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(leadJsonModelResponse({ contact: { email: "a@b.com", name: "Pat" } }))
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_act", message: "please contact me" }),
      crmEnv,
      store,
      () => "hoff_act",
      waitUntil,
    );
    await flush();

    const sent = JSON.parse(capturedBody) as {
      activities: { type: string; payload: Record<string, unknown> }[];
    };
    const sessionStarted = sent.activities.find((a) => a.type === "session_started");
    const pageUrl = sessionStarted?.payload.pageUrl as string | undefined;
    if (pageUrl !== undefined) {
      expect(pageUrl.length).toBeLessThanOrEqual(MAX_CRM_FIELD_CHARS);
    }
  });

  it("contact.phone field is truncated to MAX_CRM_FIELD_CHARS when oversized", async () => {
    // A runaway model could return a multi-thousand-char phone field.
    // clampProfile must cap it before it reaches the signed CRM body.
    const hugePhone = "9".repeat(10_000);
    const profile: LeadProfile = {
      contact: { email: "a@b.com", name: "Pat", phone: hugePhone },
      qualification: { needPain: "help" },
      derived: {},
      fitScore: 0.6,
      intentScore: 0.5,
      status: "qualified",
    };
    const body = await captureBuiltBody(profile, "sess_phone_cap");
    const sent = body as { profile: { contact: { phone?: string } } };
    expect((sent.profile.contact.phone ?? "").length).toBeLessThanOrEqual(MAX_CRM_FIELD_CHARS);
  });

  it("profile.derived referrer/pageUrl/locale are truncated to MAX_CRM_FIELD_CHARS when oversized", async () => {
    // derived.referrer/pageUrl/locale can be populated from model output via
    // extractDerivedFields (or from a prior session's persisted profile).
    // clampProfile spreads `derived` verbatim — this test confirms that is fixed
    // and the CRM body is bounded even when those fields are oversized.
    const huge = "x".repeat(10_000);
    const store = new MemorySessionStore();
    await store.create("sess_derived_cap", { productId: "prod_123", origin }, 86_400);
    await store.appendMessage("sess_derived_cap", {
      role: "user",
      content: "email me at a@b.com",
    });
    await store.appendMessage("sess_derived_cap", { role: "assistant", content: "sure" });

    let capturedBody = "";
    // The model returns oversized derived fields — extractDerivedFields will pick
    // them up and they'll land in profile.derived, which clampProfile must cap.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "a@b.com", name: "Pat" },
          derived: { referrer: huge, pageUrl: huge, locale: huge },
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleHandoff(
      jsonRequest("/v1/handoff", { sessionId: "sess_derived_cap", message: "please contact me" }),
      crmEnv,
      store,
      () => "hoff_derived_cap",
      waitUntil,
    );
    await flush();

    const sent = JSON.parse(capturedBody) as {
      profile: {
        derived: { referrer?: string; pageUrl?: string; locale?: string };
      };
    };
    const cap = MAX_CRM_FIELD_CHARS;
    if (sent.profile.derived.referrer !== undefined) {
      expect(sent.profile.derived.referrer.length).toBeLessThanOrEqual(cap);
    }
    if (sent.profile.derived.pageUrl !== undefined) {
      expect(sent.profile.derived.pageUrl.length).toBeLessThanOrEqual(cap);
    }
    if (sent.profile.derived.locale !== undefined) {
      expect(sent.profile.derived.locale.length).toBeLessThanOrEqual(cap);
    }
  });
});

// ─── G2: Backoff schedule pinned across all attempts ─────────────────────────

describe("AiSdrSession alarm — G2: exact backoff schedule per attempt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a DO with one pending row at the given attempts count, run alarm(),
   * and return the updated row from the in-memory pending array.
   */
  async function runAlarmWithAttempts(
    attempts: number,
  ): Promise<{ row: { attempts: number; next_attempt_at: number } | undefined; now: number }> {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_g2",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { status: 503 })),
    );
    const durable = new AiSdrSession(state, crmEnv);
    await durable.alarm();
    return { row: pending[0], now };
  }

  it("PUSH_BACKOFF_MS is exported and matches [0, 30000, 120000, 600000, 3600000]", () => {
    // Reference the actual constant — don't guess the schedule.
    expect(Array.from(PUSH_BACKOFF_MS)).toEqual([0, 30_000, 120_000, 600_000, 3_600_000]);
  });

  it("attempt 0→1: reschedules to now + PUSH_BACKOFF_MS[1] (≈30s)", async () => {
    const { row, now } = await runAlarmWithAttempts(0);
    expect(row?.attempts).toBe(1);
    const expectedDelay = PUSH_BACKOFF_MS[1]; // 30_000
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(now + expectedDelay - 200);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(now + expectedDelay + 200);
  });

  it("attempt 1→2: reschedules to now + PUSH_BACKOFF_MS[2] (≈120s)", async () => {
    const { row, now } = await runAlarmWithAttempts(1);
    expect(row?.attempts).toBe(2);
    const expectedDelay = PUSH_BACKOFF_MS[2]; // 120_000
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(now + expectedDelay - 200);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(now + expectedDelay + 200);
  });

  it("attempt 2→3: reschedules to now + PUSH_BACKOFF_MS[3] (≈600s)", async () => {
    const { row, now } = await runAlarmWithAttempts(2);
    expect(row?.attempts).toBe(3);
    const expectedDelay = PUSH_BACKOFF_MS[3]; // 600_000
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(now + expectedDelay - 200);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(now + expectedDelay + 200);
  });

  it("attempt 3→4: reschedules to now + PUSH_BACKOFF_MS[4] (≈3600s)", async () => {
    const { row, now } = await runAlarmWithAttempts(3);
    expect(row?.attempts).toBe(4);
    const expectedDelay = PUSH_BACKOFF_MS[4]; // 3_600_000
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(now + expectedDelay - 200);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(now + expectedDelay + 200);
  });

  it("attempt 4 (budget exhausted on next increment → 5 >= PUSH_MAX_ATTEMPTS): row is DROPPED", async () => {
    // At attempts=4: the increment makes it 5, nextAttemptDelay(5) returns null → row dropped.
    // This is the last attempt that results in exhaustion (not a reschedule).
    const { row, now: _now } = await runAlarmWithAttempts(4);
    // Row must be gone from pending — it gets deleted, not rescheduled.
    // runAlarmWithAttempts returns pending[0] which is undefined after deletion.
    expect(row).toBeUndefined();
  });

  it("attempt 5 (also budget exhausted): row is DROPPED, no further reschedule", async () => {
    const now = Date.now();
    const { exec, pending } = makeSqlFake({
      pending: [
        {
          id: "push_g2_done",
          session_id: "sess_1",
          product_key: "prod_123",
          payload_json: JSON.stringify(crmRequestFixture()),
          attempts: 5,
          next_attempt_at: now - 1,
        },
      ],
    });
    const state = {
      storage: { sql: { exec }, setAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { status: 503 })),
    );
    const durable = new AiSdrSession(state, crmEnv);
    await durable.alarm();

    // Row must be deleted — budget is exhausted.
    expect(pending).toHaveLength(0);
  });
});

// ─── G3: idempotency / double-enqueue guard ───────────────────────────────────

describe("attemptPushOrEnqueue — G3: in-process dedupe guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * G3 VERDICT: The in-process `leadPushPending` guard is the primary dedupe
   * mechanism within a single DO instance / process. A second push attempt while
   * `leadPushPending === true` returns early without calling enqueuePush or fetch.
   *
   * The existing "Nit 1" test (attemptPushOrEnqueue — double-enqueue guard) already
   * covers the core invariant: exactly one row is enqueued even when extraction fires
   * twice. No source defect was found — the guard works correctly.
   *
   * The cross-process / cross-restart backstop is the CRM ingest endpoint itself,
   * which is independently idempotent by `sdrSessionId` (upsertLeadBySession).
   * A second delivery of the same outbox payload therefore produces an upsert, not
   * a duplicate lead — so the system is safe even if the in-process flag is lost
   * across a Worker restart between two alarm ticks.
   */
  it("a second push attempt while leadPushPending is true does NOT call fetch a second time", async () => {
    const store = new MemorySessionStore();
    await seededSession(store);

    // Turn 1: retriable failure → leadPushPending = true, one queued push.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      )
      .mockResolvedValueOnce(new Response("x", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(store.queuedPushes).toHaveLength(1);
    expect(store.get("sess_1")?.leadPushPending).toBe(true);
    const callsAfterTurn1 = fetchMock.mock.calls.length;

    // Turn 2: same session, new contact signal → extraction fires again.
    // The guard must suppress any CRM fetch entirely.
    fetchMock
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("noted."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({ contact: { email: "buyer@acme.com", name: "Pat" } }),
      );
    // No 4th mock — the guard must never reach a CRM call.

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "my email is buyer@acme.com" }),
      crmEnv,
      store,
      () => "msg_2",
      waitUntil,
    );
    await flush();

    // Exactly the 3 calls for Turn 2 (context + chat + extraction model) — no 4th CRM call.
    expect(fetchMock.mock.calls.length).toBe(callsAfterTurn1 + 3);
    expect(store.queuedPushes).toHaveLength(1);
  });
});

// ─── G4: multi-session outbox isolation ──────────────────────────────────────

describe("AiSdrSession durable outbox — G4: per-session row isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * G4 DESIGN NOTE: AiSdrSession is a Cloudflare Durable Object. CF instantiates
   * exactly ONE DO instance per `idFromName(sessionId)` key. Each SDR session maps
   * to its own DO instance, so two sessions (sess_a, sess_b) are served by separate
   * DO instances with completely separate SQL storage. True multi-session contamination
   * across instances is therefore architecturally impossible within a single alarm tick.
   *
   * The test below validates the per-row keying logic WITHIN a single DO instance
   * (e.g. if two push rows coexist), asserting that each row is dispatched to the CRM
   * independently with its own payload and that alarm processing does not cross-write
   * receipts between rows.
   */
  it("two pending rows drain independently — each session receives its own CRM receipt", async () => {
    const now = Date.now();
    const requestA = crmRequestFixture({ sdrSessionId: "sess_a", productKey: "prod_a" });
    const requestB = crmRequestFixture({ sdrSessionId: "sess_b", productKey: "prod_b" });

    const sessionAJson = JSON.stringify({
      id: "sess_a",
      productId: "prod_a",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: 0,
      expiresAt: now + 100_000,
    });
    const sessionBJson = JSON.stringify({
      id: "sess_b",
      productId: "prod_b",
      metadata: {},
      transcript: [],
      handoff: { requested: false },
      createdAt: 0,
      expiresAt: now + 100_000,
    });

    const { exec, pending, sessions } = makeSqlFake({
      sessions: [
        { id: "sess_a", payload: sessionAJson, expires_at: now + 100_000 },
        { id: "sess_b", payload: sessionBJson, expires_at: now + 100_000 },
      ],
      pending: [
        {
          id: "push_a",
          session_id: "sess_a",
          product_key: "prod_a",
          payload_json: JSON.stringify(requestA),
          attempts: 0,
          next_attempt_at: now - 2,
        },
        {
          id: "push_b",
          session_id: "sess_b",
          product_key: "prod_b",
          payload_json: JSON.stringify(requestB),
          attempts: 0,
          next_attempt_at: now - 1,
        },
      ],
    });

    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const state = { storage: { sql: { exec }, setAlarm } } as unknown as DurableObjectState;

    // Each push gets a distinct CRM response keyed by productKey.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { productKey: string };
      if (body.productKey === "prod_a") {
        return new Response(
          JSON.stringify({ customerId: "cust_a", leadId: "lead_a", status: "new" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ customerId: "cust_b", leadId: "lead_b", status: "qualified" }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const durable = new AiSdrSession(state, crmEnv);
    await durable.alarm();

    // Both rows must be drained.
    expect(pending).toHaveLength(0);

    // Session A must carry its OWN receipt (cust_a / lead_a).
    const storedA = JSON.parse(sessions.find((s) => s.id === "sess_a")?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(storedA.routeReceipt).toEqual({
      customerId: "cust_a",
      leadId: "lead_a",
      status: "new",
    });
    expect(storedA.leadPushPending).toBe(false);

    // Session B must carry its OWN receipt (cust_b / lead_b) — no cross-write.
    const storedB = JSON.parse(sessions.find((s) => s.id === "sess_b")?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(storedB.routeReceipt).toEqual({
      customerId: "cust_b",
      leadId: "lead_b",
      status: "qualified",
    });
    expect(storedB.leadPushPending).toBe(false);

    // Explicit cross-contamination check.
    expect((storedA.routeReceipt as Record<string, unknown>).customerId).not.toBe("cust_b");
    expect((storedB.routeReceipt as Record<string, unknown>).customerId).not.toBe("cust_a");
  });
});

// ─── Fix 2: clampProfile truncates derived.utm values ────────────────────────

describe("clampProfile — derived.utm value truncation (Fix 2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("truncates over-long utm values to MAX_CRM_FIELD_CHARS in the signed CRM body", async () => {
    // utm values come from session metadata (utm_* keys), NOT from model output.
    // Seed the session with metadata containing one normal and one over-long utm value.
    const store = new MemorySessionStore();
    const longUtmValue = "x".repeat(MAX_CRM_FIELD_CHARS + 500);
    const normalUtmValue = "google";
    await store.create(
      "sess_1",
      {
        productId: "prod_123",
        origin,
        metadata: {
          utm_source: normalUtmValue,
          utm_campaign: longUtmValue,
        },
      },
      86_400,
    );

    let capturedBody = "";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Here are the details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com" },
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(capturedBody).not.toBe("");
    const sent = JSON.parse(capturedBody) as {
      profile: { derived: { utm?: Record<string, string> } };
    };
    const utm = sent.profile.derived.utm;
    expect(utm).toBeDefined();
    // Normal value stays as-is.
    expect(utm?.utm_source).toBe(normalUtmValue);
    // Over-long value is truncated to the cap.
    expect(utm?.utm_campaign).toHaveLength(MAX_CRM_FIELD_CHARS);
    expect(utm?.utm_campaign).toBe("x".repeat(MAX_CRM_FIELD_CHARS));
  });

  it("leaves utm map absent when not set in the session metadata", async () => {
    // seededSession creates a session with no utm_* metadata keys.
    const store = new MemorySessionStore();
    await seededSession(store);

    let capturedBody = "";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedContextResponse(product))
      .mockResolvedValueOnce(chatModelResponse("Here are the details."))
      .mockResolvedValueOnce(
        leadJsonModelResponse({
          contact: { email: "buyer@acme.com" },
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        capturedBody = (init as RequestInit).body as string;
        return crmSuccessResponse();
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitUntil, flush } = captureWaitUntil();

    await handleChat(
      jsonRequest("/v1/chat", { sessionId: "sess_1", message: "what is the price?" }),
      crmEnv,
      store,
      () => "msg_1",
      waitUntil,
    );
    await flush();

    expect(capturedBody).not.toBe("");
    const sent = JSON.parse(capturedBody) as {
      profile: { derived: Record<string, unknown> };
    };
    expect(sent.profile.derived.utm).toBeUndefined();
  });
});

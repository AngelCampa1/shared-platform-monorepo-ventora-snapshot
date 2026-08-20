import type {
  AiAssistantContextSource,
  AiAssistantMessage,
  AiAssistantSseEvent,
  HmacVerificationResult as SharedHmacVerificationResult,
  StableJsonValue as SharedStableJsonValue,
} from "@ventora/ai-assistant-contracts";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type AiSdrSseEvent,
  type ChatMessage,
  type ChatRequest,
  type ContactInfo,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type HandoffReceipt,
  type HandoffRequest,
  type HmacHeaders,
  type HmacVerificationResult,
  type PlanRecommendation,
  type ProductContext,
  type ProductPlan,
  type ProductSource,
  type RouteReceipt,
  type StableJsonValue,
  type TrialCta,
  buildHmacPayload,
  isAiSdrSseEvent,
  isHandoffRequest,
  parseSseEventName,
  sha256Hex,
  signHmacPayload,
  stableJson,
  verifyHmacSignature,
} from "./index.js";

describe("stableJson", () => {
  test("sorts object keys recursively for stable output", () => {
    expect(stableJson({ zebra: 1, alpha: { beta: 2, apple: 3 } })).toBe(
      '{"alpha":{"apple":3,"beta":2},"zebra":1}',
    );
  });

  test("preserves arrays and nulls", () => {
    expect(stableJson({ value: [null, { b: false, a: true }, "text"] })).toBe(
      '{"value":[null,{"a":true,"b":false},"text"]}',
    );
  });
});

describe("HMAC helpers", () => {
  test("hashes values with sha256 hex", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("builds canonical payload with stable body hash", () => {
    const body = { z: 1, a: [null, { b: "two", a: "one" }] } satisfies StableJsonValue;
    const bodyHash = sha256Hex(stableJson(body));

    expect(
      buildHmacPayload({
        timestamp: "2026-05-13T16:00:00.000Z",
        nonce: "nonce-1",
        method: "post",
        path: "/sessions",
        body,
      }),
    ).toBe(`2026-05-13T16:00:00.000Z.nonce-1.POST./sessions.${bodyHash}`);
  });

  test("signs and verifies a valid lowercase hex signature", () => {
    const payload = "2026-05-13T16:00:00.000Z.nonce.POST./chat.hash";
    const secret = "shared-secret";
    const timestamp = Date.parse("2026-05-13T16:00:00.000Z");
    const signature = signHmacPayload(payload, secret);

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifyHmacSignature({
        payload,
        signature,
        secret,
        timestamp,
        nowMs: timestamp + 1_000,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects invalid, malformed, and skewed signatures", () => {
    const payload = "payload";
    const secret = "shared-secret";
    const timestamp = Date.parse("2026-05-13T16:00:00.000Z");

    expect(
      verifyHmacSignature({
        payload,
        signature: "not-hex",
        secret,
        timestamp,
        nowMs: timestamp,
      }),
    ).toEqual({ ok: false, reason: "malformed_signature" });

    expect(
      verifyHmacSignature({
        payload,
        signature: `${"0".repeat(63)}1`,
        secret,
        timestamp,
        nowMs: timestamp,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    expect(
      verifyHmacSignature({
        payload,
        signature: signHmacPayload(payload, secret),
        secret,
        timestamp,
        nowMs: timestamp + 300_001,
      }),
    ).toEqual({ ok: false, reason: "timestamp_skew" });
  });
});

describe("SSE event contracts", () => {
  test("parses only supported event names", () => {
    expect(parseSseEventName("session.created")).toBe("session.created");
    expect(parseSseEventName("unknown")).toBeNull();
    expect(parseSseEventName(123)).toBeNull();
  });

  test("validates each AI-SDR SSE event variant", () => {
    const events: AiSdrSseEvent[] = [
      { event: "session.created", data: { sessionId: "sess_1" } },
      { event: "message.delta", data: { messageId: "msg_1", delta: "hello" } },
      {
        event: "source",
        data: { source: { id: "src_1", title: "Docs", url: "https://example.com" } },
      },
      {
        event: "plan.recommendation",
        data: { recommendation: { planId: "pro", reason: "Best fit", confidence: 0.82 } },
      },
      {
        event: "trial.cta",
        data: { cta: { label: "Start trial", url: "https://example.com/trial" } },
      },
      { event: "handoff.requested", data: { handoffId: "handoff_1", reason: "needs_sales" } },
      { event: "message.done", data: { messageId: "msg_1" } },
      { event: "error", data: { code: "bad_request", message: "Invalid request" } },
      { event: "heartbeat", data: { timestamp: "2026-05-13T16:00:00.000Z" } },
    ];

    for (const event of events) {
      expect(isAiSdrSseEvent(event)).toBe(true);
    }
  });

  test("rejects malformed SSE events", () => {
    expect(isAiSdrSseEvent({ event: "message.delta", data: { messageId: "msg_1" } })).toBe(false);
    expect(
      isAiSdrSseEvent({ event: "source", data: { source: { id: "src_1", title: "Docs" } } }),
    ).toBe(false);
    expect(isAiSdrSseEvent({ event: "cta", data: { cta: { label: "Open", url: "/open" } } })).toBe(
      false,
    );
    expect(
      isAiSdrSseEvent({ event: "escalation.requested", data: { escalationId: "esc_1" } }),
    ).toBe(false);
    expect(isAiSdrSseEvent({ event: "unknown", data: {} })).toBe(false);
    expect(isAiSdrSseEvent(null)).toBe(false);
  });
});

describe("isHandoffRequest", () => {
  test("accepts a minimal and a fully-populated request", () => {
    expect(isHandoffRequest({ sessionId: "sess_1" })).toBe(true);
    expect(
      isHandoffRequest({
        sessionId: "sess_1",
        reason: "needs_sales",
        message: "Please follow up",
        contact: { name: "Ada", email: "ada@example.com" },
      }),
    ).toBe(true);
  });

  test("rejects missing or non-string sessionId", () => {
    expect(isHandoffRequest({})).toBe(false);
    expect(isHandoffRequest({ sessionId: 1 })).toBe(false);
  });

  test("rejects non-string optional reason or message", () => {
    expect(isHandoffRequest({ sessionId: "s", reason: 1 })).toBe(false);
    expect(isHandoffRequest({ sessionId: "s", message: {} })).toBe(false);
  });

  test("rejects an invalid contact", () => {
    expect(isHandoffRequest({ sessionId: "s", contact: { email: 1 } })).toBe(false);
    expect(isHandoffRequest({ sessionId: "s", contact: "ada" })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isHandoffRequest(null)).toBe(false);
    expect(isHandoffRequest([])).toBe(false);
    expect(isHandoffRequest("handoff")).toBe(false);
  });
});

describe("exported protocol types", () => {
  test("layers SDR contracts on the shared assistant contracts", () => {
    expectTypeOf<ProductSource>().toMatchTypeOf<AiAssistantContextSource>();
    expectTypeOf<ChatMessage>().toEqualTypeOf<AiAssistantMessage>();
    expectTypeOf<StableJsonValue>().toEqualTypeOf<SharedStableJsonValue>();
    expectTypeOf<HmacVerificationResult>().toEqualTypeOf<SharedHmacVerificationResult>();
    expectTypeOf<Extract<AiSdrSseEvent, { event: "message.delta" }>>().toMatchTypeOf<
      Extract<AiAssistantSseEvent, { event: "message.delta" }>
    >();
  });

  test("exports expected public contract types", () => {
    expectTypeOf<ProductContext>().toMatchTypeOf<{
      productId: string;
      name: string;
      description?: string;
      sources?: ProductSource[];
      plans?: ProductPlan[];
    }>();
    expectTypeOf<ProductPlan>().toMatchTypeOf<{
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
    }>();
    expectTypeOf<PlanRecommendation>().toMatchTypeOf<{
      planId: string;
      reason: string;
      confidence?: number;
      priceSummary?: string;
    }>();
    expectTypeOf<ChatMessage>().toMatchTypeOf<{
      role: "user" | "assistant" | "system";
      content: string;
    }>();
    expectTypeOf<CreateSessionRequest>().toMatchTypeOf<{ productId: string; visitorId?: string }>();
    expectTypeOf<CreateSessionResponse>().toMatchTypeOf<{ sessionId: string }>();
    expectTypeOf<ChatRequest>().toMatchTypeOf<{ sessionId: string; message: string }>();
    expectTypeOf<HandoffRequest>().toMatchTypeOf<{
      sessionId: string;
      reason?: string;
      contact?: ContactInfo;
    }>();
    expectTypeOf<HandoffReceipt>().toMatchTypeOf<{ handoffId: string; status: string }>();
    expectTypeOf<RouteReceipt>().toMatchTypeOf<{ routeId: string; destination: string }>();
    expectTypeOf<PlanRecommendation>().toMatchTypeOf<{ planId: string; reason: string }>();
    expectTypeOf<TrialCta>().toMatchTypeOf<{ label: string; url: string }>();
    expectTypeOf<HmacHeaders>().toMatchTypeOf<{
      timestamp: string;
      nonce: string;
      signature: string;
    }>();
    expectTypeOf<HmacVerificationResult>().toMatchTypeOf<{ ok: boolean }>();
  });
});

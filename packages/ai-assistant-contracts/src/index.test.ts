import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type AiAssistantContext,
  type AiAssistantContextSource,
  type AiAssistantCta,
  type AiAssistantEscalationReceipt,
  type AiAssistantEscalationRequest,
  type AiAssistantMessage,
  type AiAssistantRouteReceipt,
  type AiAssistantSessionRequest,
  type AiAssistantSessionResponse,
  type AiAssistantSseEvent,
  type AiAssistantSseEventName,
  type HmacHeaders,
  type HmacVerificationResult,
  type StableJsonValue,
  buildHmacPayload,
  createAssistantSseEventValidator,
  isAiAssistantSseEvent,
  parseAiAssistantSseEventName,
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

describe("assistant SSE event contracts", () => {
  test("parses only generic assistant event names", () => {
    expect(parseAiAssistantSseEventName("session.created")).toBe("session.created");
    expect(parseAiAssistantSseEventName("message.delta")).toBe("message.delta");
    expect(parseAiAssistantSseEventName("source")).toBe("source");
    expect(parseAiAssistantSseEventName("plan.recommendation")).toBeNull();
    expect(parseAiAssistantSseEventName(123)).toBeNull();
  });

  test("validates every generic assistant event variant", () => {
    const events: AiAssistantSseEvent[] = [
      { event: "session.created", data: { sessionId: "sess_1" } },
      { event: "message.delta", data: { messageId: "msg_1", delta: "hello" } },
      {
        event: "source",
        data: { source: { id: "src_1", title: "Docs", url: "https://example.com" } },
      },
      { event: "cta", data: { cta: { label: "Open settings", url: "/settings" } } },
      { event: "escalation.requested", data: { escalationId: "esc_1", reason: "needs_human" } },
      { event: "message.done", data: { messageId: "msg_1" } },
      { event: "error", data: { code: "bad_request", message: "Invalid request" } },
      { event: "heartbeat", data: { timestamp: "2026-05-13T16:00:00.000Z" } },
    ];

    for (const event of events) {
      expect(isAiAssistantSseEvent(event)).toBe(true);
    }
  });

  test("rejects malformed generic assistant events", () => {
    expect(isAiAssistantSseEvent({ event: "message.delta", data: { messageId: "msg_1" } })).toBe(
      false,
    );
    expect(
      isAiAssistantSseEvent({
        event: "source",
        data: { source: { id: "src_1", title: "Docs" } },
      }),
    ).toBe(false);
    expect(isAiAssistantSseEvent({ event: "unknown", data: {} })).toBe(false);
    expect(isAiAssistantSseEvent(null)).toBe(false);
  });

  test("creates domain validators with additional typed events", () => {
    type SalesEvent =
      | AiAssistantSseEvent
      | {
          event: "plan.recommendation";
          data: { recommendation: { planId: string; reason: string } };
        };
    const isSalesEvent = createAssistantSseEventValidator<SalesEvent>({
      "plan.recommendation": (data) =>
        typeof data.recommendation === "object" &&
        data.recommendation !== null &&
        "planId" in data.recommendation &&
        "reason" in data.recommendation,
    });

    expect(
      isSalesEvent({
        event: "plan.recommendation",
        data: { recommendation: { planId: "pro", reason: "Best fit" } },
      }),
    ).toBe(true);
    expect(isSalesEvent({ event: "plan.recommendation", data: { recommendation: {} } })).toBe(
      false,
    );
    expect(isSalesEvent({ event: "message.done", data: { messageId: "msg_1" } })).toBe(true);
  });

  test("creates domain validators that restrict inherited shared event names", () => {
    const isSupportEvent = createAssistantSseEventValidator<AiAssistantSseEvent>(
      {},
      { sharedEventNames: ["session.created", "message.done"] },
    );

    expect(isSupportEvent({ event: "session.created", data: { sessionId: "sess_1" } })).toBe(true);
    expect(isSupportEvent({ event: "message.done", data: { messageId: "msg_1" } })).toBe(true);
    expect(isSupportEvent({ event: "escalation.requested", data: { escalationId: "esc_1" } })).toBe(
      false,
    );
  });
});

describe("exported protocol types", () => {
  test("exports expected shared assistant types", () => {
    expectTypeOf<AiAssistantContext>().toMatchTypeOf<{
      assistantId: string;
      appId: string;
      appName: string;
      description?: string;
      authenticatedOnly?: boolean;
      sources?: AiAssistantContextSource[];
    }>();
    expectTypeOf<AiAssistantMessage>().toMatchTypeOf<{
      role: "user" | "assistant" | "system";
      content: string;
    }>();
    expectTypeOf<AiAssistantSessionRequest>().toMatchTypeOf<{
      appId: string;
      userId?: string;
      metadata?: Record<string, string>;
    }>();
    expectTypeOf<AiAssistantSessionResponse>().toMatchTypeOf<{ sessionId: string }>();
    expectTypeOf<AiAssistantEscalationRequest>().toMatchTypeOf<{
      sessionId: string;
      reason?: string;
      contact?: Record<string, string>;
    }>();
    expectTypeOf<AiAssistantEscalationReceipt>().toMatchTypeOf<{
      escalationId: string;
      status: string;
    }>();
    expectTypeOf<AiAssistantRouteReceipt>().toMatchTypeOf<{
      routeId: string;
      destination: string;
    }>();
    expectTypeOf<AiAssistantCta>().toMatchTypeOf<{ label: string; url: string }>();
    expectTypeOf<AiAssistantSseEventName>().toEqualTypeOf<AiAssistantSseEvent["event"]>();
    expectTypeOf<HmacHeaders>().toMatchTypeOf<{
      timestamp: string;
      nonce: string;
      signature: string;
    }>();
    expectTypeOf<HmacVerificationResult>().toMatchTypeOf<{ ok: boolean }>();
  });
});

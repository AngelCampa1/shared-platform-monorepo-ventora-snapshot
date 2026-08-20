import type {
  AiAssistantContext,
  AiAssistantContextSource,
  AiAssistantMessage,
  AiAssistantSseEvent,
  StableJsonValue,
} from "@ventora/ai-assistant-contracts";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type AiCsAppContext,
  type AiCsChatRequest,
  type AiCsEscalationReceipt,
  type AiCsNavigationTarget,
  type AiCsSessionRequest,
  type AiCsSseEvent,
  isAiCsSseEvent,
  parseAiCsSseEventName,
  stableJson,
} from "./index.js";

describe("AI-CS event contracts", () => {
  test("parses only shared and AI-CS event names", () => {
    expect(parseAiCsSseEventName("session.created")).toBe("session.created");
    expect(parseAiCsSseEventName("navigation.suggestion")).toBe("navigation.suggestion");
    expect(parseAiCsSseEventName("workflow.step")).toBe("workflow.step");
    expect(parseAiCsSseEventName("support.escalation.requested")).toBe(
      "support.escalation.requested",
    );
    expect(parseAiCsSseEventName("escalation.requested")).toBeNull();
    expect(parseAiCsSseEventName("trial.cta")).toBeNull();
    expect(parseAiCsSseEventName(null)).toBeNull();
  });

  test("validates generic assistant events and AI-CS-specific events", () => {
    const events: AiCsSseEvent[] = [
      { event: "session.created", data: { sessionId: "sess_1" } },
      { event: "message.delta", data: { messageId: "msg_1", delta: "hello" } },
      {
        event: "navigation.suggestion",
        data: { target: { label: "Billing", path: "/settings/billing" } },
      },
      {
        event: "workflow.step",
        data: { step: { id: "invite", label: "Invite teammate", status: "next" } },
      },
      {
        event: "support.escalation.requested",
        data: { escalationId: "esc_1", reason: "account_issue" },
      },
      { event: "message.done", data: { messageId: "msg_1" } },
    ];

    for (const event of events) {
      expect(isAiCsSseEvent(event)).toBe(true);
    }
  });

  test("rejects malformed AI-CS-specific events", () => {
    expect(
      isAiCsSseEvent({
        event: "navigation.suggestion",
        data: { target: { label: "Billing" } },
      }),
    ).toBe(false);
    expect(
      isAiCsSseEvent({
        event: "workflow.step",
        data: { step: { id: "invite", label: "Invite teammate", status: "unknown" } },
      }),
    ).toBe(false);
    expect(isAiCsSseEvent({ event: "support.escalation.requested", data: {} })).toBe(false);
    expect(isAiCsSseEvent({ event: "escalation.requested", data: { escalationId: "esc_1" } })).toBe(
      false,
    );
  });
});

describe("AI-CS exported types", () => {
  test("uses shared assistant primitives for authenticated app support", () => {
    expectTypeOf<AiCsAppContext>().toMatchTypeOf<AiAssistantContext>();
    expectTypeOf<AiCsAppContext>().toMatchTypeOf<{
      assistantId: "ai-cs";
      appId: string;
      appName: string;
      authenticatedOnly: true;
      currentPath?: string;
      sources?: AiAssistantContextSource[];
      navigation?: AiCsNavigationTarget[];
    }>();
    expectTypeOf<AiCsSessionRequest>().toMatchTypeOf<{
      appId: string;
      userId: string;
      currentPath?: string;
      metadata?: Record<string, string>;
    }>();
    expectTypeOf<AiCsChatRequest>().toMatchTypeOf<{
      sessionId: string;
      message: string;
      appId: string;
      userId: string;
      history?: AiAssistantMessage[];
      currentPath?: string;
    }>();
    expectTypeOf<AiCsEscalationReceipt>().toMatchTypeOf<{
      escalationId: string;
      status: string;
    }>();
    expectTypeOf<Extract<AiCsSseEvent, { event: "message.delta" }>>().toMatchTypeOf<
      Extract<AiAssistantSseEvent, { event: "message.delta" }>
    >();
  });

  test("re-exports shared stable JSON helpers", () => {
    const value = { appId: "lextract", nested: { b: 1, a: 2 } } satisfies StableJsonValue;
    expect(stableJson(value)).toBe('{"appId":"lextract","nested":{"a":2,"b":1}}');
  });
});

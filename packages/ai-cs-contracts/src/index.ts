export type {
  AiAssistantContextSource,
  AiAssistantCta,
  AiAssistantMessage,
  HmacHeaders,
  HmacVerificationResult,
  StableJsonValue,
} from "@ventora/ai-assistant-contracts";
export {
  buildHmacPayload,
  sha256Hex,
  signHmacPayload,
  stableJson,
  verifyHmacSignature,
} from "@ventora/ai-assistant-contracts";

import { createAssistantSseEventValidator } from "@ventora/ai-assistant-contracts";
import type { AiAssistantContextSource, AiAssistantMessage } from "@ventora/ai-assistant-contracts";

export interface AiCsNavigationTarget {
  label: string;
  path: string;
  description?: string;
}

export interface AiCsWorkflowStep {
  id: string;
  label: string;
  status: "completed" | "current" | "next";
  path?: string;
}

export interface MeetingLink {
  id: string;
  label: string;
  url: string;
  description?: string;
}

/**
 * A product or domain concept the assistant may need to explain in plain words
 * before a beginner can act on it (e.g. "gross-up", "general ledger", "pro-rata").
 */
export interface AiCsConcept {
  /** The term as a user would say or read it. */
  term: string;
  /** A plain-language definition a first-time user can understand. */
  plainDefinition: string;
  /** Why the user should care / what it affects in the product. */
  whyItMatters?: string;
  /** In-app path where the concept is configured or shown, if any. */
  path?: string;
}

/** One numbered step inside a how-to, naming the exact screen and button. */
export interface AiCsHowtoStep {
  /** 1-based step number. */
  n: number;
  /** Plain-language instruction for this step. */
  instruction: string;
  /** The screen/page name this step happens on. */
  screen?: string;
  /** The exact button or control label the user clicks. */
  button?: string;
  /** The in-app path for this step, if navigation is involved. */
  path?: string;
}

/** A complete, ordered "how do I X" walkthrough grounded in the real UI. */
export interface AiCsHowto {
  id: string;
  /** What the user accomplishes, e.g. "Run a reconciliation". */
  goal: string;
  /** What must already be true/done first, in plain words. */
  prerequisites?: string[];
  steps: AiCsHowtoStep[];
}

/** A frequently-asked question with a short, grounded answer. */
export interface AiCsFaq {
  question: string;
  answer: string;
  /** Relevant in-app path, if the answer points to a screen. */
  path?: string;
}

export interface AiCsAppContext {
  assistantId: "ai-cs";
  appId: string;
  appName: string;
  authenticatedOnly: true;
  description?: string;
  currentPath?: string;
  sources?: AiAssistantContextSource[];
  navigation?: AiCsNavigationTarget[];
  workflow?: AiCsWorkflowStep[];
  meetingLinks?: MeetingLink[];
  /** Plain-language definitions of domain/product terms (teaching layer). */
  concepts?: AiCsConcept[];
  /** Step-by-step walkthroughs of core tasks (teaching layer). */
  howtos?: AiCsHowto[];
  /** Frequently-asked questions with grounded answers (teaching layer). */
  faqs?: AiCsFaq[];
}

export interface AiCsSessionRequest {
  appId: string;
  userId: string;
  currentPath?: string;
  metadata?: Record<string, string>;
}

export interface AiCsSessionResponse {
  sessionId: string;
}

export interface AiCsChatRequest {
  sessionId: string;
  message: string;
  /**
   * The app and user the session belongs to. The worker re-checks these
   * against the looked-up session on every chat send (defense in depth: the
   * session id alone is the capability, but a single shared client-assertion
   * secret means the body must also prove which app/user it speaks for). The
   * widget sources both from its session request — they are required on the
   * wire, so omitting them is a compile error, not a silent 401 in production.
   */
  appId: string;
  userId: string;
  history?: AiAssistantMessage[];
  currentPath?: string;
}

export interface AiCsEscalationRequest {
  sessionId: string;
  /** See {@link AiCsChatRequest.appId} — the worker enforces the same ownership check on escalations. */
  appId: string;
  userId: string;
  reason?: string;
  message?: string;
  contact?: Record<string, string>;
}

export interface AiCsEscalationReceipt {
  escalationId: string;
  status: string;
}

export type AiCsSseEvent =
  | { event: "session.created"; data: { sessionId: string } }
  | { event: "message.delta"; data: { messageId: string; delta: string } }
  | { event: "source"; data: { source: AiAssistantContextSource } }
  | { event: "cta"; data: { cta: { label: string; url: string } } }
  | { event: "navigation.suggestion"; data: { target: AiCsNavigationTarget } }
  | { event: "workflow.step"; data: { step: AiCsWorkflowStep } }
  | { event: "support.escalation.requested"; data: { escalationId: string; reason?: string } }
  | { event: "message.done"; data: { messageId: string } }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "heartbeat"; data: { timestamp: string } };

export type AiCsSseEventName = AiCsSseEvent["event"];

const aiCsSpecificEventNames = new Set<
  Exclude<
    AiCsSseEventName,
    "session.created" | "message.delta" | "source" | "cta" | "message.done" | "error" | "heartbeat"
  >
>(["navigation.suggestion", "workflow.step", "support.escalation.requested"]);

const isSharedOrAiCsSseEvent = createAssistantSseEventValidator<AiCsSseEvent>(
  {
    "navigation.suggestion": (data) => isAiCsNavigationTarget(data.target),
    "workflow.step": (data) => isAiCsWorkflowStep(data.step),
    "support.escalation.requested": (data) =>
      isString(data.escalationId) && isOptionalString(data.reason),
  },
  {
    sharedEventNames: [
      "session.created",
      "message.delta",
      "source",
      "cta",
      "message.done",
      "error",
      "heartbeat",
    ],
  },
);

export function parseAiCsSseEventName(value: unknown): AiCsSseEventName | null {
  if (typeof value !== "string") {
    return null;
  }
  if (
    value === "session.created" ||
    value === "message.delta" ||
    value === "source" ||
    value === "cta" ||
    value === "message.done" ||
    value === "error" ||
    value === "heartbeat" ||
    aiCsSpecificEventNames.has(
      value as Exclude<
        AiCsSseEventName,
        | "session.created"
        | "message.delta"
        | "source"
        | "cta"
        | "message.done"
        | "error"
        | "heartbeat"
      >,
    )
  ) {
    return value as AiCsSseEventName;
  }
  return null;
}

export function isAiCsSseEvent(value: unknown): value is AiCsSseEvent {
  return isSharedOrAiCsSseEvent(value);
}

function isAiCsNavigationTarget(value: unknown): value is AiCsNavigationTarget {
  return (
    isRecord(value) &&
    isString(value.label) &&
    isString(value.path) &&
    isOptionalString(value.description)
  );
}

function isAiCsWorkflowStep(value: unknown): value is AiCsWorkflowStep {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    isWorkflowStepStatus(value.status) &&
    isOptionalString(value.path)
  );
}

function isWorkflowStepStatus(value: unknown): value is AiCsWorkflowStep["status"] {
  return value === "completed" || value === "current" || value === "next";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

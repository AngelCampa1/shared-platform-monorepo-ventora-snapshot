export type {
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

import {
  type AiAssistantContextSource,
  type AiAssistantMessage,
  createAssistantSseEventValidator,
} from "@ventora/ai-assistant-contracts";

export interface ProductSource extends AiAssistantContextSource {}

export interface ProductPlan {
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
}

export interface MeetingLink {
  id: string;
  label: string;
  url: string;
  description?: string;
}

export interface ProductContext {
  productId: string;
  name: string;
  description?: string;
  sources?: ProductSource[];
  plans?: ProductPlan[];
  meetingLinks?: MeetingLink[];
}

export type ChatMessage = AiAssistantMessage;

export interface CreateSessionRequest {
  productId: string;
  visitorId?: string;
  metadata?: Record<string, string>;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  history?: ChatMessage[];
}

export interface ContactInfo {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  phone?: string;
}

export interface LeadQualification {
  needPain?: string;
  authority?: string;
  budgetSignal?: string;
  timeline?: string;
  useCase?: string;
  productInterest?: string;
}

export interface LeadDerived {
  emailDomain?: string;
  utm?: Record<string, string>;
  referrer?: string;
  pageUrl?: string;
  locale?: string;
}

export type LeadStatus =
  | "new"
  | "qualifying"
  | "qualified"
  | "handoff_requested"
  | "accepted"
  | "disqualified";

export interface LeadProfile {
  contact: ContactInfo;
  qualification: LeadQualification;
  derived: LeadDerived;
  fitScore?: number;
  intentScore?: number;
  status?: LeadStatus;
}

export type LeadActivityType =
  | "session_started"
  | "qualification_updated"
  | "message_summary"
  | "handoff_requested"
  | "note";

export interface LeadActivityInput {
  type: LeadActivityType;
  payload?: Record<string, unknown>;
}

export interface CrmLeadIngestRequest {
  productKey: string;
  sdrSessionId: string;
  profile: LeadProfile;
  activities: LeadActivityInput[];
  occurredAt: string;
}

export interface CrmLeadIngestResponse {
  customerId: string;
  leadId: string;
  status: LeadStatus;
}

export interface HandoffRequest {
  sessionId: string;
  reason?: string;
  message?: string;
  contact?: ContactInfo;
}

export interface HandoffReceipt {
  handoffId: string;
  status: string;
}

export interface RouteReceipt {
  routeId: string;
  destination: string;
}

export interface PlanRecommendation {
  planId: string;
  reason: string;
  confidence?: number;
  priceSummary?: string;
}

export interface TrialCta {
  label: string;
  url: string;
}

export type AiSdrSseEvent =
  | { event: "session.created"; data: { sessionId: string } }
  | { event: "message.delta"; data: { messageId: string; delta: string } }
  | { event: "source"; data: { source: ProductSource } }
  | { event: "plan.recommendation"; data: { recommendation: PlanRecommendation } }
  | { event: "trial.cta"; data: { cta: TrialCta } }
  | { event: "handoff.requested"; data: { handoffId: string; reason?: string } }
  | { event: "lead.captured"; data: { leadId: string; status: string } }
  | { event: "message.done"; data: { messageId: string } }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "heartbeat"; data: { timestamp: string } };

export type AiSdrSseEventName = AiSdrSseEvent["event"];

const sdrSpecificEventNames = new Set<
  Exclude<
    AiSdrSseEventName,
    "session.created" | "message.delta" | "source" | "message.done" | "error" | "heartbeat"
  >
>(["plan.recommendation", "trial.cta", "handoff.requested", "lead.captured"]);

const isSdrSseEvent = createAssistantSseEventValidator<AiSdrSseEvent>(
  {
    "plan.recommendation": (data) => isPlanRecommendation(data.recommendation),
    "trial.cta": (data) => isTrialCta(data.cta),
    "handoff.requested": (data) => isString(data.handoffId) && isOptionalString(data.reason),
    "lead.captured": (data) => isString(data.leadId) && isString(data.status),
  },
  {
    sharedEventNames: [
      "session.created",
      "message.delta",
      "source",
      "message.done",
      "error",
      "heartbeat",
    ],
  },
);

export function parseSseEventName(value: unknown): AiSdrSseEventName | null {
  if (typeof value !== "string") {
    return null;
  }
  if (
    value === "session.created" ||
    value === "message.delta" ||
    value === "source" ||
    value === "message.done" ||
    value === "error" ||
    value === "heartbeat" ||
    sdrSpecificEventNames.has(
      value as Exclude<
        AiSdrSseEventName,
        "session.created" | "message.delta" | "source" | "message.done" | "error" | "heartbeat"
      >,
    )
  ) {
    return value as AiSdrSseEventName;
  }
  return null;
}

export function isAiSdrSseEvent(value: unknown): value is AiSdrSseEvent {
  return isSdrSseEvent(value);
}

export function isHandoffRequest(value: unknown): value is HandoffRequest {
  return (
    isRecord(value) &&
    isString(value.sessionId) &&
    isOptionalString(value.reason) &&
    isOptionalString(value.message) &&
    (value.contact === undefined || isContactInfo(value.contact))
  );
}

const leadActivityTypes = new Set<LeadActivityType>([
  "session_started",
  "qualification_updated",
  "message_summary",
  "handoff_requested",
  "note",
]);

export function isLeadActivityInput(value: unknown): value is LeadActivityInput {
  return (
    isRecord(value) &&
    isString(value.type) &&
    leadActivityTypes.has(value.type as LeadActivityType) &&
    (value.payload === undefined || isRecord(value.payload))
  );
}

export function isCrmLeadIngestRequest(value: unknown): value is CrmLeadIngestRequest {
  return (
    isRecord(value) &&
    isString(value.productKey) &&
    isString(value.sdrSessionId) &&
    isLeadProfile(value.profile) &&
    Array.isArray(value.activities) &&
    value.activities.every((activity) => isLeadActivityInput(activity)) &&
    isString(value.occurredAt)
  );
}

export function isCrmLeadIngestResponse(value: unknown): value is CrmLeadIngestResponse {
  return (
    isRecord(value) &&
    isString(value.customerId) &&
    isString(value.leadId) &&
    isLeadStatus(value.status)
  );
}

const leadStatuses = new Set<LeadStatus>([
  "new",
  "qualifying",
  "qualified",
  "handoff_requested",
  "accepted",
  "disqualified",
]);

export function isLeadStatus(value: unknown): value is LeadStatus {
  return isString(value) && leadStatuses.has(value as LeadStatus);
}

export function isContactInfo(value: unknown): value is ContactInfo {
  return (
    isRecord(value) &&
    isOptionalString(value.name) &&
    isOptionalString(value.email) &&
    isOptionalString(value.company) &&
    isOptionalString(value.role) &&
    isOptionalString(value.phone)
  );
}

export function isLeadQualification(value: unknown): value is LeadQualification {
  return (
    isRecord(value) &&
    isOptionalString(value.needPain) &&
    isOptionalString(value.authority) &&
    isOptionalString(value.budgetSignal) &&
    isOptionalString(value.timeline) &&
    isOptionalString(value.useCase) &&
    isOptionalString(value.productInterest)
  );
}

export function isLeadDerived(value: unknown): value is LeadDerived {
  return (
    isRecord(value) &&
    isOptionalString(value.emailDomain) &&
    (value.utm === undefined || isStringRecord(value.utm)) &&
    isOptionalString(value.referrer) &&
    isOptionalString(value.pageUrl) &&
    isOptionalString(value.locale)
  );
}

export function isLeadProfile(value: unknown): value is LeadProfile {
  return (
    isRecord(value) &&
    isContactInfo(value.contact) &&
    isLeadQualification(value.qualification) &&
    isLeadDerived(value.derived) &&
    isOptionalNumber(value.fitScore) &&
    isOptionalNumber(value.intentScore) &&
    (value.status === undefined || isLeadStatus(value.status))
  );
}

function isPlanRecommendation(value: unknown): value is PlanRecommendation {
  return (
    isRecord(value) &&
    isString(value.planId) &&
    isString(value.reason) &&
    (value.confidence === undefined || typeof value.confidence === "number") &&
    isOptionalString(value.priceSummary)
  );
}

function isTrialCta(value: unknown): value is TrialCta {
  return isRecord(value) && isString(value.label) && isString(value.url);
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

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

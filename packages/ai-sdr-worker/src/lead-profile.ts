/**
 * lead-profile.ts
 *
 * Qualification extractor, scoring heuristic, and status derivation for the
 * AI-SDR lead pipeline. All logic is deterministic and pure except for
 * `extractLeadProfile`, which calls the injected `modelCaller` for structured
 * JSON extraction.
 *
 * Privacy contract: NO PII is logged or emitted to telemetry anywhere in this
 * module (no email, phone, name, or message content in any log or thrown error).
 * Message content IS sent to the extraction model by design — that is the whole
 * point of extraction, and is the same boundary the chat model already crosses.
 */

import type {
  ChatMessage,
  ContactInfo,
  LeadDerived,
  LeadProfile,
  LeadQualification,
  LeadStatus,
} from "@ventora/ai-sdr-contracts";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Injected model caller — the only external boundary in this module.
 * Accepts a { system, user } prompt pair and resolves to the raw string
 * the model produced (expected to be JSON, but callers must be defensive).
 */
export type LeadModelCaller = (prompt: { system: string; user: string }) => Promise<string>;

// ─── extractLeadProfile ──────────────────────────────────────────────────────

export interface ExtractLeadProfileArgs {
  /** Conversation transcript so far. */
  transcript: ChatMessage[];
  /** Previously known LeadProfile from the session, or null on first call. */
  prior: LeadProfile | null;
  /** Product id retained for caller compatibility; extraction is product-neutral. */
  productId?: string;
  /** Session-level context available without a model call. */
  deriveCtx: {
    metadata?: Record<string, string>;
    pageUrl?: string;
    referrer?: string;
    locale?: string;
  };
  /** Injected model caller — mocked in tests, real in production. */
  modelCaller: LeadModelCaller;
}

/**
 * Calls the model to extract structured contact + qualification fields from
 * the transcript, then:
 *   1. Merges new non-empty signals over prior (never drops known prior fields).
 *   2. Derives emailDomain, utm, pageUrl, referrer, and locale locally.
 *   3. Computes fitScore + intentScore via scoreLead().
 *   4. Sets status via deriveStatus().
 *
 * FAIL-SAFE: If the model returns malformed / invalid JSON the function falls
 * back to the prior (or an empty profile) without throwing.
 */
export async function extractLeadProfile(args: ExtractLeadProfileArgs): Promise<LeadProfile> {
  const { transcript, prior, deriveCtx, modelCaller } = args;

  // Build the prior base (empty defaults if null)
  const basePrior: LeadProfile = prior ?? {
    contact: {},
    qualification: {},
    derived: {},
  };

  // Build prompts and call the model — defensive, never throws
  const system = buildSystemPrompt();
  const user = buildUserPrompt(transcript, basePrior);

  let modelContact: ContactInfo = {};
  let modelQualification: LeadQualification = {};
  let modelDerived: LeadDerived = {};

  try {
    const raw = await modelCaller({ system, user });
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      if (isRecord(parsed.contact)) {
        modelContact = extractContactFields(parsed.contact);
      }
      if (isRecord(parsed.qualification)) {
        modelQualification = extractQualificationFields(parsed.qualification);
      }
      if (isRecord(parsed.derived)) {
        modelDerived = extractDerivedFields(parsed.derived);
      }
    }
  } catch {
    // Malformed JSON or model error — fall back to prior, no throw, no PII in error
  }

  // Merge: new non-empty values overwrite; absent/null keeps prior
  const contact: ContactInfo = mergeContact(basePrior.contact, modelContact);
  const qualification: LeadQualification = mergeQualification(
    basePrior.qualification,
    modelQualification,
  );
  const derived: LeadDerived = mergeDerived(basePrior.derived, modelDerived);

  // Local derivations (always re-derived, never from model output)
  const emailDomain = deriveEmailDomain(contact.email);
  if (emailDomain !== undefined) {
    derived.emailDomain = emailDomain;
  }

  // Extract utm_* keys from metadata
  const utm = extractUtm(deriveCtx.metadata);
  if (utm !== undefined) {
    derived.utm = utm;
  }

  // Map deriveCtx fields
  if (deriveCtx.pageUrl !== undefined) {
    derived.pageUrl = deriveCtx.pageUrl;
  }
  if (deriveCtx.referrer !== undefined) {
    derived.referrer = deriveCtx.referrer;
  }
  if (deriveCtx.locale !== undefined) {
    derived.locale = deriveCtx.locale;
  }

  const partial: LeadProfile = { contact, qualification, derived };

  // I2: Compute scores once and pass into status derivation — avoids scoreLead
  // being called twice (once here and again inside deriveStatus).
  const { fitScore, intentScore } = scoreLead(partial);
  const status = deriveStatusFromScores(partial, fitScore, intentScore);

  return { contact, qualification, derived, fitScore, intentScore, status };
}

// ─── scoreLead ───────────────────────────────────────────────────────────────

/**
 * Scoring weights — documented here as the single source of truth.
 *
 * fitScore (firmographic + qualification signals):
 *   contact.company        +0.10
 *   contact.role           +0.10
 *   qualification.needPain +0.20
 *   qualification.useCase  +0.15
 *   qualification.productInterest +0.15
 *   qualification.budgetSignal    +0.15
 *   qualification.authority       +0.15
 *   Total max = 1.00 → clamped to [0,1]
 *
 * intentScore (buying-intent + contact-capture signals):
 *   contact.email present  +0.25
 *   contact.phone present  +0.15
 *   qualification.timeline present +0.25
 *   qualification.budgetSignal present +0.25
 *   both email AND phone   +0.10  (bonus, can push past 1.00 before clamp)
 *   Total with bonus max = 1.00 → clamped to [0,1]
 */
export function scoreLead(profile: LeadProfile): { fitScore: number; intentScore: number } {
  const { contact, qualification } = profile;

  // fitScore
  let fit = 0;
  if (isNonEmpty(contact.company)) fit += 0.1;
  if (isNonEmpty(contact.role)) fit += 0.1;
  if (isNonEmpty(qualification.needPain)) fit += 0.2;
  if (isNonEmpty(qualification.useCase)) fit += 0.15;
  if (isNonEmpty(qualification.productInterest)) fit += 0.15;
  if (isNonEmpty(qualification.budgetSignal)) fit += 0.15;
  if (isNonEmpty(qualification.authority)) fit += 0.15;

  // intentScore
  const hasEmail = isNonEmpty(contact.email);
  const hasPhone = isNonEmpty(contact.phone);
  let intent = 0;
  if (hasEmail) intent += 0.25;
  if (hasPhone) intent += 0.15;
  if (isNonEmpty(qualification.timeline)) intent += 0.25;
  if (isNonEmpty(qualification.budgetSignal)) intent += 0.25;
  if (hasEmail && hasPhone) intent += 0.1; // bonus

  return {
    fitScore: clamp(fit),
    intentScore: clamp(intent),
  };
}

// ─── deriveStatus ────────────────────────────────────────────────────────────

/**
 * Core threshold logic for status derivation — takes pre-computed scores to
 * avoid calling scoreLead more than once per pipeline run (I2).
 *
 * "new"        — no contact info AND no qualification fields at all.
 * "qualified"  — fitScore >= 0.5 AND intentScore >= 0.4.
 * "qualifying" — everything in between (some signals, but not enough to qualify).
 *
 * Note: "handoff_requested", "accepted", and "disqualified" are lifecycle
 * transitions set by the caller (session/handoff logic), never derived here.
 */
export function deriveStatusFromScores(
  profile: LeadProfile,
  fitScore: number,
  intentScore: number,
): LeadStatus {
  // Check for any data at all
  const hasAnyContact = hasAnyContactInfo(profile.contact);
  const hasAnyQual = hasAnyQualification(profile.qualification);

  if (!hasAnyContact && !hasAnyQual) {
    return "new";
  }

  if (fitScore >= 0.5 && intentScore >= 0.4) {
    return "qualified";
  }

  return "qualifying";
}

/**
 * Thin public wrapper that computes scores then calls deriveStatusFromScores.
 * Callers that already have scores should call deriveStatusFromScores directly
 * to avoid computing scoreLead twice.
 */
export function deriveStatus(profile: LeadProfile): LeadStatus {
  const { fitScore, intentScore } = scoreLead(profile);
  return deriveStatusFromScores(profile, fitScore, intentScore);
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const basePrompt = `You are a qualification data extractor for an AI sales assistant. Your only job is to extract structured lead information from a conversation transcript.

Return ONLY a valid JSON object with this exact shape (all fields optional):
{
  "contact": {
    "name": string | null,
    "email": string | null,
    "company": string | null,
    "role": string | null,
    "phone": string | null
  },
  "qualification": {
    "needPain": string | null,
    "authority": string | null,
    "budgetSignal": string | null,
    "timeline": string | null,
    "useCase": string | null,
    "productInterest": string | null
  },
  "derived": {}
}

Rules:
- Only include information explicitly stated or strongly implied by the prospect.
- Return null for fields not present in the conversation.
- Do not fabricate or infer beyond what is said.
- Return valid JSON only — no prose, no markdown, no explanation.`;
  return basePrompt;
}

/**
 * Per-message cap for the extraction prompt. Inbound messages are already
 * bounded to 8KB by the chat route, but a long multi-turn transcript could
 * still inflate the extractor prompt; cap each line defensively. The extractor
 * only needs enough text to recognize contact + qualification signals.
 */
const MAX_PROMPT_MESSAGE_CHARS = 2000;

function buildUserPrompt(transcript: ChatMessage[], prior: LeadProfile): string {
  // The model MUST see the actual conversation text — extracting structured
  // contact/qualification fields is impossible from a placeholder. This prompt
  // is sent only to the extraction model (the same boundary the chat model
  // already crosses with full transcript content); it is never logged, and the
  // module's privacy contract governs logs/telemetry, not this model call.
  const lines = transcript
    .map((m) => {
      const speaker = m.role === "user" ? "Prospect" : "Assistant";
      const content =
        m.content.length > MAX_PROMPT_MESSAGE_CHARS
          ? `${m.content.slice(0, MAX_PROMPT_MESSAGE_CHARS)}…`
          : m.content;
      return `${speaker}: ${content}`;
    })
    .join("\n");

  // Include prior field keys (not values) so the model knows what's already captured.
  // We never include actual contact values in the prompt (PII protection).
  const capturedFields: string[] = [];
  if (prior.contact.name) capturedFields.push("name");
  if (prior.contact.email) capturedFields.push("email");
  if (prior.contact.company) capturedFields.push("company");
  if (prior.contact.role) capturedFields.push("role");
  if (prior.contact.phone) capturedFields.push("phone");

  const capturedNote =
    capturedFields.length > 0
      ? `\nAlready captured contact fields: ${capturedFields.join(", ")}. Only overwrite if the prospect explicitly corrects them.`
      : "";

  return `Extract lead qualification data from this conversation.${capturedNote}

Conversation (${transcript.length} messages):
${lines || "(no messages yet)"}

Return the JSON extraction:`;
}

// ─── Merge helpers ───────────────────────────────────────────────────────────

/** Merge two ContactInfo objects. Non-empty new values overwrite; absent keeps prior. */
function mergeContact(prior: ContactInfo, next: ContactInfo): ContactInfo {
  const result: ContactInfo = {};
  const name = pickValue(prior.name, next.name);
  if (name !== undefined) result.name = name;
  const email = pickValue(prior.email, next.email);
  if (email !== undefined) result.email = email;
  const company = pickValue(prior.company, next.company);
  if (company !== undefined) result.company = company;
  const role = pickValue(prior.role, next.role);
  if (role !== undefined) result.role = role;
  const phone = pickValue(prior.phone, next.phone);
  if (phone !== undefined) result.phone = phone;
  return result;
}

/** Merge two LeadQualification objects. Non-empty new values overwrite; absent keeps prior. */
function mergeQualification(prior: LeadQualification, next: LeadQualification): LeadQualification {
  const result: LeadQualification = {};
  const needPain = pickValue(prior.needPain, next.needPain);
  if (needPain !== undefined) result.needPain = needPain;
  const authority = pickValue(prior.authority, next.authority);
  if (authority !== undefined) result.authority = authority;
  const budgetSignal = pickValue(prior.budgetSignal, next.budgetSignal);
  if (budgetSignal !== undefined) result.budgetSignal = budgetSignal;
  const timeline = pickValue(prior.timeline, next.timeline);
  if (timeline !== undefined) result.timeline = timeline;
  const useCase = pickValue(prior.useCase, next.useCase);
  if (useCase !== undefined) result.useCase = useCase;
  const productInterest = pickValue(prior.productInterest, next.productInterest);
  if (productInterest !== undefined) result.productInterest = productInterest;
  return result;
}

/** Merge two LeadDerived objects. Non-empty new values overwrite; absent keeps prior. */
function mergeDerived(prior: LeadDerived, next: LeadDerived): LeadDerived {
  const result: LeadDerived = {};
  // emailDomain is derived locally and never comes from model output (M7);
  // merge it from prior only — the post-merge local derivation step overwrites
  // this with the authoritative value when an email is present.
  const emailDomain = pickValue(prior.emailDomain, next.emailDomain);
  if (emailDomain !== undefined) result.emailDomain = emailDomain;
  // M1: utm is authoritative from deriveCtx (extracted by extractUtm); the
  // whole-object replace semantics are intentional — the new utm snapshot from
  // the session replaces the prior one. However, an empty object ({}) from
  // model output must not wipe a real prior utm, so we treat an empty next.utm
  // as absent. (extractDerivedFields never sets utm on the model output at all,
  // so this guard is a defensive belt-and-suspenders against future drift.)
  const nextUtmHasKeys = next.utm !== undefined && Object.keys(next.utm).length > 0;
  const utm = nextUtmHasKeys ? next.utm : prior.utm;
  if (utm !== undefined) result.utm = utm;
  const referrer = pickValue(prior.referrer, next.referrer);
  if (referrer !== undefined) result.referrer = referrer;
  const pageUrl = pickValue(prior.pageUrl, next.pageUrl);
  if (pageUrl !== undefined) result.pageUrl = pageUrl;
  const locale = pickValue(prior.locale, next.locale);
  if (locale !== undefined) result.locale = locale;
  return result;
}

/**
 * Returns `next` if it is a non-empty string, otherwise returns `prior`
 * (which may itself be undefined).
 */
function pickValue(prior: string | undefined, next: string | undefined): string | undefined {
  if (isNonEmpty(next)) return next;
  return prior;
}

// ─── Field extractors (unknown → typed) ─────────────────────────────────────

/** Extract only valid string fields from an unknown record into ContactInfo. */
function extractContactFields(raw: Record<string, unknown>): ContactInfo {
  const result: ContactInfo = {};
  const name = stringOrUndefined(raw.name);
  if (name !== undefined) result.name = name;
  const email = stringOrUndefined(raw.email);
  if (email !== undefined) result.email = email;
  const company = stringOrUndefined(raw.company);
  if (company !== undefined) result.company = company;
  const role = stringOrUndefined(raw.role);
  if (role !== undefined) result.role = role;
  const phone = stringOrUndefined(raw.phone);
  if (phone !== undefined) result.phone = phone;
  return result;
}

/** Extract only valid string fields from an unknown record into LeadQualification. */
function extractQualificationFields(raw: Record<string, unknown>): LeadQualification {
  const result: LeadQualification = {};
  const needPain = stringOrUndefined(raw.needPain);
  if (needPain !== undefined) result.needPain = needPain;
  const authority = stringOrUndefined(raw.authority);
  if (authority !== undefined) result.authority = authority;
  const budgetSignal = stringOrUndefined(raw.budgetSignal);
  if (budgetSignal !== undefined) result.budgetSignal = budgetSignal;
  const timeline = stringOrUndefined(raw.timeline);
  if (timeline !== undefined) result.timeline = timeline;
  const useCase = stringOrUndefined(raw.useCase);
  if (useCase !== undefined) result.useCase = useCase;
  const productInterest = stringOrUndefined(raw.productInterest);
  if (productInterest !== undefined) result.productInterest = productInterest;
  return result;
}

/**
 * Extract only valid derived fields from an unknown record into LeadDerived.
 *
 * M7: emailDomain is intentionally NOT extracted from model output here.
 * It is always derived locally from contact.email via deriveEmailDomain(),
 * which runs after this step. This guarantees the model cannot inject an
 * arbitrary emailDomain — local derivation is the only authority.
 *
 * utm is also NOT extracted from model output — it is derived exclusively
 * from deriveCtx metadata by extractUtm().
 */
function extractDerivedFields(raw: Record<string, unknown>): LeadDerived {
  const result: LeadDerived = {};
  const referrer = stringOrUndefined(raw.referrer);
  if (referrer !== undefined) result.referrer = referrer;
  const pageUrl = stringOrUndefined(raw.pageUrl);
  if (pageUrl !== undefined) result.pageUrl = pageUrl;
  const locale = stringOrUndefined(raw.locale);
  if (locale !== undefined) result.locale = locale;
  return result;
}

// ─── Local derivation helpers ────────────────────────────────────────────────

/**
 * Derives the email domain from a captured email address.
 * Returns the part after "@", lowercased. Returns undefined if email is absent
 * or malformed.
 */
function deriveEmailDomain(email: string | undefined): string | undefined {
  if (!isNonEmpty(email)) return undefined;
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0) return undefined;
  const domain = email.slice(atIndex + 1).toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

/**
 * Extracts all keys that begin with "utm_" from the session metadata record
 * into a separate utm map. Returns undefined if no utm keys are found.
 */
function extractUtm(
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (metadata === undefined) return undefined;
  const utm: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith("utm_")) {
      utm[key] = value;
    }
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

// ─── Small utilities ─────────────────────────────────────────────────────────

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

function hasAnyContactInfo(contact: ContactInfo): boolean {
  return (
    isNonEmpty(contact.name) ||
    isNonEmpty(contact.email) ||
    isNonEmpty(contact.company) ||
    isNonEmpty(contact.role) ||
    isNonEmpty(contact.phone)
  );
}

function hasAnyQualification(qualification: LeadQualification): boolean {
  return (
    isNonEmpty(qualification.needPain) ||
    isNonEmpty(qualification.authority) ||
    isNonEmpty(qualification.budgetSignal) ||
    isNonEmpty(qualification.timeline) ||
    isNonEmpty(qualification.useCase) ||
    isNonEmpty(qualification.productInterest)
  );
}

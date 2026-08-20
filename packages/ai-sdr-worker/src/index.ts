import {
  type ChatMessage,
  type ContactInfo,
  type CrmLeadIngestRequest,
  type LeadActivityInput,
  type LeadProfile,
  type LeadStatus,
  type ProductContext,
  type ProductPlan,
  type ProductSource,
  type StableJsonValue,
  buildHmacPayload,
  isContactInfo,
  isCrmLeadIngestRequest,
  isLeadProfile,
  isLeadStatus,
  signHmacPayload,
  stableJson,
  verifyHmacSignature,
} from "@ventora/ai-sdr-contracts";
import { type Fetcher as CrmFetcher, pushLeadToCrm } from "./crm-push.js";
import { hostedClientGlobalModule, hostedClientModule } from "./hosted-client.js";
import { type LeadModelCaller, extractLeadProfile } from "./lead-profile.js";
import { type Observability, makeObservability } from "./observability.js";

export type Env = {
  AI_SDR_SESSIONS?: DurableObjectNamespace;
  AI_SDR_CONTEXT_SECRET?: string;
  AI_SDR_CONTEXT_ENDPOINT?: string;
  AI_SDR_CONTEXT_ENDPOINTS?: string;
  AI_SDR_CLIENT_ASSERTION_SECRET?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_ENDPOINT?: string;
  AI_SDR_SESSION_TTL_SECONDS?: string;
  AI_SDR_ALLOWED_ORIGINS?: string;
  AI_SDR_PRIMARY_MODEL?: string;
  AI_SDR_PRIMARY_PROVIDERS?: string;
  AI_SDR_FALLBACK_MODEL?: string;
  AI_SDR_FALLBACK_PROVIDERS?: string;
  AI_SDR_ESCALATION_MODEL?: string;
  AI_SDR_ESCALATION_PROVIDERS?: string;
  AI_SDR_CONFIDENCE_THRESHOLD?: string;
  AI_SDR_OPENROUTER_TIMEOUT_MS?: string;
  /** Base CRM lead-ingest endpoint (var). Absent ⇒ lead push is skipped. */
  CRM_INGEST_ENDPOINT?: string;
  /** HMAC secret for signing CRM lead-ingest requests (secret). Absent ⇒ push skipped. */
  CRM_INGEST_SECRET?: string;
  /**
   * Sentry DSN for error telemetry (secret). When absent, captureSentry is a no-op.
   * Set via: wrangler secret put SENTRY_DSN
   */
  SENTRY_DSN?: string;
  /**
   * PostHog API key for product analytics (secret). When absent, track is a no-op.
   * Set via: wrangler secret put POSTHOG_API_KEY
   */
  POSTHOG_API_KEY?: string;
  /**
   * PostHog ingest host (var). Defaults to https://us.i.posthog.com when absent.
   * Override for EU tenants: https://eu.i.posthog.com
   */
  POSTHOG_HOST?: string;
};

type Session = {
  id: string;
  productId: string;
  visitorId?: string;
  origin?: string;
  metadata: Record<string, string>;
  transcript: ChatMessage[];
  handoff: {
    requested: boolean;
    handoffId?: string;
    reason?: string;
    message?: string;
    contact?: ContactInfo;
  };
  createdAt: number;
  expiresAt: number;
  // ─── Lead pipeline state (all optional → old serialized sessions still validate) ───
  /** Last extracted lead profile, merged across turns. */
  leadProfile?: LeadProfile;
  /** Receipt from a successful CRM push (set once the lead is routed). */
  routeReceipt?: { customerId: string; leadId: string; status: LeadStatus };
  /** transcript.length at the time extraction last ran (gate against re-extracting). */
  lastExtractedTurnIndex?: number;
  /** True while a push is queued in the durable outbox awaiting retry. */
  leadPushPending?: boolean;
  /** True once the `lead.captured` SSE event has been emitted to the client. */
  leadCaptureEmitted?: boolean;
};

/** Subset of Session lead fields that updateLeadState may mutate. */
type LeadStatePatch = Pick<
  Session,
  | "leadProfile"
  | "routeReceipt"
  | "lastExtractedTurnIndex"
  | "leadPushPending"
  | "leadCaptureEmitted"
>;

type SessionDraft = {
  productId: string;
  visitorId?: string;
  origin?: string;
  metadata?: Record<string, unknown>;
};

type SessionStore = {
  create(id: string, draft: SessionDraft, ttlSeconds: number): Promise<Session>;
  get(id: string): Session | undefined | Promise<Session | undefined>;
  appendMessage(id: string, message: ChatMessage): Promise<void>;
  setHandoff(id: string, handoff: Session["handoff"]): Promise<void>;
  /** Persist a subset of lead-pipeline fields. Never touches transcript/handoff. */
  updateLeadState(id: string, patch: LeadStatePatch): Promise<void>;
  /** Append a pending CRM push to the durable outbox for later retry. */
  enqueuePush(sessionId: string, productKey: string, payloadJson: string): Promise<void>;
};

export type RouteKind = "primary" | "fallback" | "escalation";

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 8192;
const RETIRED_PRODUCT_IDS = new Set(["grantpipe"]);

function isRetiredProductId(productId: string): boolean {
  return RETIRED_PRODUCT_IDS.has(productId.trim().toLowerCase());
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** No-op waitUntil for direct-call tests / runtimes without an execution ctx. */
const noopWaitUntil = (_p: Promise<unknown>): void => {};

/** A minimal slice of ExecutionContext we depend on. */
type WaitUntil = (promise: Promise<unknown>) => void;

// ─── Durable outbox / retry tuning ───────────────────────────────────────────
// Imported from constants.ts — not re-exported here so wrangler's module-worker
// runtime does not see non-handler named exports on the entry module.
import { MAX_CRM_FIELD_CHARS, PUSH_BACKOFF_MS } from "./constants.js";
const PUSH_MAX_ATTEMPTS = 5;

/** Maximum length for an email address (RFC 5321 §4.5.3). */
const MAX_EMAIL_CHARS = 254;

/**
 * Delay (ms) before the next retry given the attempts-so-far count.
 * Returns null when the attempt budget is exhausted (caller drops the row).
 */
function nextAttemptDelay(attempts: number): number | null {
  if (attempts >= PUSH_MAX_ATTEMPTS) {
    return null;
  }
  return PUSH_BACKOFF_MS[attempts] ?? 3_600_000;
}

// ─── Observability ────────────────────────────────────────────────────────────
/**
 * Build bound, PII-free observability hooks for a given product scope.
 * Pass `fetcher` in tests to intercept network calls without making real HTTP
 * requests. Both hooks are no-ops when the respective env var is absent.
 *
 * The `data` passed to any call site must ONLY carry: productId/productKey,
 * status enums, reason literals, score buckets, attempt counts, and booleans.
 * Never: contact name, email, phone, company, or free-form message text.
 */
function obsFor(
  env: Env,
  productId: string,
  fetcher?: Parameters<typeof makeObservability>[2],
): Observability {
  return makeObservability(env, productId, fetcher);
}

/** Coarse, PII-free score bucket for analytics. */
export function scoreBucket(score: number | undefined): "low" | "medium" | "high" {
  if (score === undefined || score < 0.4) {
    return "low";
  }
  return score < 0.7 ? "medium" : "high";
}

// ─── Extraction trigger gate (latency guard) ─────────────────────────────────
const CONTACT_SIGNAL = /\b(email|@|company|role|title|name|phone|call me|reach out)\b/i;
const QUAL_SIGNAL =
  /\b(budget|timeline|authority|decision|use case|need|pain|problem|try|demo|buy|price|evaluate)\b/i;

/**
 * Decide whether to run lead extraction for this turn. Conservative by design:
 * extraction is the only path that calls the model a second time, so we gate it
 * hard to protect cost and latency. Pure — never mutates the session.
 */
export function shouldExtract(session: Session): boolean {
  const turnIndex = session.transcript.length;
  if (turnIndex < 2) {
    return false;
  }
  const lastExtracted = session.lastExtractedTurnIndex ?? -1;
  if (lastExtracted >= turnIndex) {
    return false;
  }
  // Already routed AND a handoff was requested → nothing more to capture.
  if (session.routeReceipt !== undefined && session.handoff.requested) {
    return false;
  }
  const recentUserTurns = session.transcript
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  const hasNewSignal = CONTACT_SIGNAL.test(recentUserTurns) || QUAL_SIGNAL.test(recentUserTurns);
  if (turnIndex - lastExtracted < 4 && !hasNewSignal) {
    return false;
  }
  return true;
}

// ─── Min-data push threshold ─────────────────────────────────────────────────
/**
 * Only push to the CRM once we have a syntactically-plausible email address.
 *
 * The CRM ingest endpoint validates `profile.contact.email` as a required
 * non-empty string and returns HTTP 400 (a terminal, non-retriable failure) when
 * it is absent or blank. Pushing without a valid email silently discards the
 * lead. Guard here so the signed POST is never sent unless we have an email that
 * is a non-empty trimmed string containing "@".
 *
 * The previously-permitted "two non-email fields" path has been removed: without
 * an email the CRM cannot key the customer record, so the push is worthless.
 */
export function meetsMinDataThreshold(profile: LeadProfile): boolean {
  return isPlausibleEmail(profile.contact.email);
}

/**
 * A non-empty, trimmed string that contains "@". This is intentionally loose —
 * it is a pre-flight guard, not RFC 5321 validation. The CRM performs the
 * authoritative validation. We only need to be confident enough to avoid
 * sending a clearly email-less body that will result in a terminal 400.
 */
function isPlausibleEmail(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.includes("@");
}

// ─── Lead model caller (non-streaming JSON-mode OpenRouter) ───────────────────
/**
 * Build a real LeadModelCaller backed by OpenRouter in non-streaming JSON mode.
 * Fail-safe: returns "" on any error (extractLeadProfile tolerates empty/bad
 * output and falls back to the prior profile), so it never throws the chat path.
 */
export function buildLeadModelCaller(env: Env, fetcher: Fetcher): LeadModelCaller {
  return async ({ system, user }) => {
    if (!env.OPENROUTER_API_KEY) {
      return "";
    }
    const endpoint = openRouterEndpoint(env);
    if (endpoint === null) {
      return "";
    }
    const model = env.AI_SDR_FALLBACK_MODEL ?? "openai/gpt-5.4-nano";
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(openRouterTimeoutMs(env)),
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!response.ok) {
        return "";
      }
      const body = (await response.json()) as unknown;
      return readOpenRouterContent(body) ?? "";
    } catch {
      return "";
    }
  };
}

// ─── Activity builder (PII-free payloads only) ───────────────────────────────
/**
 * Build CRM activities. Payloads carry ONLY non-PII metadata: timestamps,
 * page/referrer/locale, score numbers, status enums, and ids. The handoff
 * `message` field (which may carry PII) is NEVER included.
 */
function buildActivities(session: Session, profile: LeadProfile): LeadActivityInput[] {
  const activities: LeadActivityInput[] = [];

  const cap = MAX_CRM_FIELD_CHARS;
  const sessionStarted: Record<string, unknown> = {
    createdAt: new Date(session.createdAt).toISOString(),
  };
  const pageUrl = session.metadata.pageUrl;
  if (pageUrl !== undefined) {
    sessionStarted.pageUrl = truncateText(pageUrl, cap);
  }
  const referrer = session.metadata.referrer;
  if (referrer !== undefined) {
    sessionStarted.referrer = truncateText(referrer, cap);
  }
  const locale = session.metadata.locale;
  if (locale !== undefined) {
    sessionStarted.locale = truncateText(locale, cap);
  }
  activities.push({ type: "session_started", payload: sessionStarted });

  if (profile.fitScore !== undefined && profile.intentScore !== undefined) {
    const qualPayload: Record<string, unknown> = {
      fitScore: profile.fitScore,
      intentScore: profile.intentScore,
    };
    if (profile.status !== undefined) {
      qualPayload.status = profile.status;
    }
    activities.push({ type: "qualification_updated", payload: qualPayload });
  }

  if (session.handoff.requested) {
    // PII allow-list: a handoff activity carries only the handoff id. The
    // caller-supplied `reason` is unbounded free text (it can contain an email,
    // name, or phone), so it never enters the CRM activity stream — it stays on
    // the handoff record for the SDR-facing surface only.
    const handoffPayload: Record<string, unknown> = {};
    if (session.handoff.handoffId !== undefined) {
      handoffPayload.handoffId = session.handoff.handoffId;
    }
    activities.push({ type: "handoff_requested", payload: handoffPayload });
  }

  return activities;
}

/**
 * Build the CRM push config from env. Omits absent fields (rather than setting
 * them to `undefined`) so it satisfies exactOptionalPropertyTypes; pushLeadToCrm
 * treats a missing endpoint/secret as `not_configured` and skips.
 */
function crmConfig(env: Env): { endpoint?: string; secret?: string } {
  const config: { endpoint?: string; secret?: string } = {};
  if (env.CRM_INGEST_ENDPOINT !== undefined) {
    config.endpoint = env.CRM_INGEST_ENDPOINT;
  }
  if (env.CRM_INGEST_SECRET !== undefined) {
    config.secret = env.CRM_INGEST_SECRET;
  }
  return config;
}

/**
 * Clamp every model-derived free-text string field in the lead profile to
 * MAX_CRM_FIELD_CHARS before signing and sending. This prevents a runaway model
 * output from inflating the signed POST body or the persisted outbox payload_json.
 * Machine-format fields (email) are capped at their own RFC maximum instead.
 * Fields that are absent (undefined) are left unchanged.
 *
 * derived.utm values are attacker-influenceable via query string parameters, so
 * each value is also clamped to MAX_CRM_FIELD_CHARS. Keys are left as-is.
 */
function clampProfile(profile: LeadProfile): LeadProfile {
  const cap = MAX_CRM_FIELD_CHARS;
  const { contact, qualification, derived, ...rest } = profile;
  return {
    ...rest,
    contact: {
      ...contact,
      ...(contact.email !== undefined
        ? { email: truncateText(contact.email, MAX_EMAIL_CHARS) }
        : {}),
      ...(contact.name !== undefined ? { name: truncateText(contact.name, cap) } : {}),
      ...(contact.company !== undefined ? { company: truncateText(contact.company, cap) } : {}),
      ...(contact.role !== undefined ? { role: truncateText(contact.role, cap) } : {}),
      ...(contact.phone !== undefined ? { phone: truncateText(contact.phone, cap) } : {}),
    },
    qualification: {
      ...qualification,
      ...(qualification.needPain !== undefined
        ? { needPain: truncateText(qualification.needPain, cap) }
        : {}),
      ...(qualification.useCase !== undefined
        ? { useCase: truncateText(qualification.useCase, cap) }
        : {}),
      ...(qualification.budgetSignal !== undefined
        ? { budgetSignal: truncateText(qualification.budgetSignal, cap) }
        : {}),
      ...(qualification.timeline !== undefined
        ? { timeline: truncateText(qualification.timeline, cap) }
        : {}),
      ...(qualification.productInterest !== undefined
        ? { productInterest: truncateText(qualification.productInterest, cap) }
        : {}),
      ...(qualification.authority !== undefined
        ? { authority: truncateText(qualification.authority, cap) }
        : {}),
    },
    derived: {
      ...derived,
      ...(derived.referrer !== undefined ? { referrer: truncateText(derived.referrer, cap) } : {}),
      ...(derived.pageUrl !== undefined ? { pageUrl: truncateText(derived.pageUrl, cap) } : {}),
      ...(derived.locale !== undefined ? { locale: truncateText(derived.locale, cap) } : {}),
      ...(derived.utm !== undefined
        ? {
            utm: Object.fromEntries(
              Object.entries(derived.utm).map(([k, v]) => [k, truncateText(v, cap)]),
            ),
          }
        : {}),
    },
  };
}

/** Assemble the CRM ingest request for a session + freshly extracted profile. */
function buildCrmRequest(session: Session, profile: LeadProfile): CrmLeadIngestRequest {
  return {
    productKey: session.productId,
    sdrSessionId: session.id,
    profile: clampProfile(profile),
    activities: buildActivities(session, profile),
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Run lead extraction and, if the profile clears the min-data threshold and the
 * session has not already been routed, push or enqueue it. Catch-all: this
 * never rejects, so a waitUntil caller can fire-and-forget it safely.
 */
async function runExtractionAndMaybePush(
  session: Session,
  env: Env,
  store: SessionStore,
  fetcher: Fetcher,
  obs: Observability,
): Promise<void> {
  try {
    const modelCaller = buildLeadModelCaller(env, fetcher);
    let profile: LeadProfile;
    try {
      profile = await extractLeadProfile({
        transcript: session.transcript,
        prior: session.leadProfile ?? null,
        productId: session.productId,
        deriveCtx: { metadata: session.metadata },
        modelCaller,
      });
    } catch {
      await obs.captureSentry("sdr_extraction_failed", { productId: session.productId });
      return;
    }

    await store.updateLeadState(session.id, {
      leadProfile: profile,
      lastExtractedTurnIndex: session.transcript.length,
    });
    await obs.track("sdr_extraction_ok", {
      productId: session.productId,
      status: profile.status,
      fitScore: scoreBucket(profile.fitScore),
      intentScore: scoreBucket(profile.intentScore),
    });

    if (session.routeReceipt === undefined && meetsMinDataThreshold(profile)) {
      await attemptPushOrEnqueue(session, profile, env, store, fetcher, obs);
    }
  } catch {
    // Defensive catch-all: extraction/push must never surface as a rejection.
  }
}

/**
 * Attempt an immediate CRM push; on a retriable failure enqueue for the durable
 * outbox; on a terminal failure record a privacy-safe Sentry event. Skips
 * silently when the CRM is not configured.
 */
async function attemptPushOrEnqueue(
  session: Session,
  profile: LeadProfile,
  env: Env,
  store: SessionStore,
  fetcher: Fetcher,
  obs: Observability,
): Promise<void> {
  if (!env.CRM_INGEST_ENDPOINT || !env.CRM_INGEST_SECRET) {
    return;
  }
  // Guard against double-enqueue: if a push is already in-flight or queued in
  // the durable outbox (leadPushPending === true), do nothing. The outbox owns
  // this push; a new extraction on a later turn must not create a second row.
  //
  // Cross-process backstop: the CRM ingest endpoint is independently idempotent
  // by `sdrSessionId` (upsertLeadBySession). If the Worker restarts between two
  // alarm ticks and the flag is lost, a second delivery of the same outbox payload
  // produces an upsert rather than a duplicate lead — so the system is safe even
  // without a distributed dedupe key.
  if (session.leadPushPending === true) {
    return;
  }
  const request = buildCrmRequest(session, profile);
  const result = await pushLeadToCrm({
    config: crmConfig(env),
    request,
    fetcher: fetcher as CrmFetcher,
    nowFactory: () => new Date(),
    idFactory: randomId,
  });
  if (result.ok) {
    await store.updateLeadState(session.id, {
      routeReceipt: {
        customerId: result.response.customerId,
        leadId: result.response.leadId,
        status: result.response.status,
      },
      leadPushPending: false,
    });
    await obs.track("sdr_push_ok", {
      productId: session.productId,
      status: result.response.status,
    });
    return;
  }
  if (result.retriable) {
    await store.enqueuePush(session.id, session.productId, JSON.stringify(request));
    await store.updateLeadState(session.id, { leadPushPending: true });
    await obs.track("sdr_push_retriable", { productId: session.productId, reason: result.reason });
    return;
  }
  // not_configured is unreachable here (guarded above); any other non-retriable
  // reason is a terminal contract/client error.
  await obs.captureSentry("sdr_push_failed_terminal", {
    productId: session.productId,
    reason: result.reason,
  });
}

/** A queued push captured by MemorySessionStore for test assertions. */
export type PendingPushRecord = {
  sessionId: string;
  productKey: string;
  payloadJson: string;
};

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingPushes: PendingPushRecord[] = [];

  /** Read-only view of queued pushes (test/assertion helper). */
  get queuedPushes(): readonly PendingPushRecord[] {
    return this.pendingPushes;
  }

  async create(id: string, draft: SessionDraft, ttlSeconds: number): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      id,
      productId: draft.productId,
      metadata: sanitizeMetadata(draft.metadata ?? {}),
      transcript: [],
      handoff: { requested: false },
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };
    if (draft.visitorId !== undefined) {
      session.visitorId = draft.visitorId;
    }
    if (draft.origin !== undefined) {
      session.origin = draft.origin;
    }
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    // Store raw content: the lead extractor reads the transcript to capture the
    // prospect's real email/phone. Redaction happens only at telemetry/log
    // boundaries (obs.track/captureSentry/console), which never receive
    // transcript content. Redacting here blinds the extractor and breaks capture.
    this.get(id)?.transcript.push({ ...message });
  }

  async setHandoff(id: string, handoff: Session["handoff"]): Promise<void> {
    const session = this.get(id);
    if (session) {
      session.handoff = handoff;
    }
  }

  async updateLeadState(id: string, patch: LeadStatePatch): Promise<void> {
    const session = this.get(id);
    if (session) {
      applyLeadStatePatch(session, patch);
    }
  }

  async enqueuePush(sessionId: string, productKey: string, payloadJson: string): Promise<void> {
    this.pendingPushes.push({ sessionId, productKey, payloadJson });
  }
}

/**
 * Apply only the lead-pipeline fields of `patch` to `session`, in place.
 * Never touches transcript or handoff. Shared by MemorySessionStore and the DO.
 */
function applyLeadStatePatch(session: Session, patch: LeadStatePatch): void {
  if ("leadProfile" in patch && patch.leadProfile !== undefined) {
    session.leadProfile = patch.leadProfile;
  }
  if ("routeReceipt" in patch && patch.routeReceipt !== undefined) {
    session.routeReceipt = patch.routeReceipt;
  }
  if ("lastExtractedTurnIndex" in patch && patch.lastExtractedTurnIndex !== undefined) {
    session.lastExtractedTurnIndex = patch.lastExtractedTurnIndex;
  }
  if ("leadPushPending" in patch && patch.leadPushPending !== undefined) {
    session.leadPushPending = patch.leadPushPending;
  }
  if ("leadCaptureEmitted" in patch && patch.leadCaptureEmitted !== undefined) {
    session.leadCaptureEmitted = patch.leadCaptureEmitted;
  }
}

const processStore = new MemorySessionStore();

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<Response> {
    const url = new URL(request.url);
    const store = sessionStoreForEnv(env);
    const waitUntil: WaitUntil =
      ctx && typeof ctx.waitUntil === "function" ? (p) => ctx.waitUntil(p) : noopWaitUntil;
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }
    let response: Response;
    if (request.method === "GET" && url.pathname === "/health") {
      response = jsonResponse({ ok: true }, 200);
      return withCors(response, request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "alias"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.0/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.1/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.2/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.3/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.4/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.5/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.6/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.7/ai-sdr.js") {
      return withCors(hostedClientResponse(hostedClientModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "alias"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.0/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.1/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.2/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.3/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.4/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.5/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.6/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "GET" && url.pathname === "/client/v0.3.7/ai-sdr.global.js") {
      return withCors(hostedClientResponse(hostedClientGlobalModule, "versioned"), request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const originCheck = requireAllowedOrigin(request, env);
      if (originCheck !== null) return withCors(originCheck, request, env);
      const assertionCheck = await requireClientAssertion(request, env);
      if (assertionCheck !== null) return withCors(assertionCheck, request, env);
      response = await handleSessionCreate(request, env, store);
      return withCors(response, request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const originCheck = requireAllowedOrigin(request, env);
      if (originCheck !== null) return withCors(originCheck, request, env);
      const assertionCheck = await requireClientAssertion(request, env);
      if (assertionCheck !== null) return withCors(assertionCheck, request, env);
      response = await handleChat(request, env, store, randomId, waitUntil);
      return withCors(response, request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/handoff") {
      const originCheck = requireAllowedOrigin(request, env);
      if (originCheck !== null) return withCors(originCheck, request, env);
      const assertionCheck = await requireClientAssertion(request, env);
      if (assertionCheck !== null) return withCors(assertionCheck, request, env);
      response = await handleHandoff(request, env, store, randomId, waitUntil);
      return withCors(response, request, env);
    }
    return withCors(new Response("Not Found", { status: 404 }), request, env);
  },
};

export class DurableObjectSessionStore implements SessionStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async create(id: string, draft: SessionDraft, ttlSeconds: number): Promise<Session> {
    const response = await this.stub(id).fetch("https://ai-sdr-session/create", {
      method: "POST",
      body: JSON.stringify({ sessionId: id, draft, ttlSeconds }),
    });
    return readSessionResponse(response);
  }

  async get(id: string): Promise<Session | undefined> {
    const response = await this.stub(id).fetch(
      `https://ai-sdr-session/get?sessionId=${encodeURIComponent(id)}`,
    );
    return response.status === 404 ? undefined : readSessionResponse(response);
  }

  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    await this.stub(id).fetch("https://ai-sdr-session/append-message", {
      method: "POST",
      body: JSON.stringify({ sessionId: id, message }),
    });
  }

  async setHandoff(id: string, handoff: Session["handoff"]): Promise<void> {
    await this.stub(id).fetch("https://ai-sdr-session/set-handoff", {
      method: "POST",
      body: JSON.stringify({ sessionId: id, handoff }),
    });
  }

  async updateLeadState(id: string, patch: LeadStatePatch): Promise<void> {
    await this.stub(id).fetch("https://ai-sdr-session/update-lead-state", {
      method: "POST",
      body: JSON.stringify({ sessionId: id, patch }),
    });
  }

  async enqueuePush(sessionId: string, productKey: string, payloadJson: string): Promise<void> {
    await this.stub(sessionId).fetch("https://ai-sdr-session/enqueue-push", {
      method: "POST",
      body: JSON.stringify({ sessionId, productKey, payloadJson }),
    });
  }

  private stub(id: string): DurableObjectStub {
    return this.namespace.get(this.namespace.idFromName(id));
  }
}

function sessionStoreForEnv(env: Env): SessionStore {
  return env.AI_SDR_SESSIONS ? new DurableObjectSessionStore(env.AI_SDR_SESSIONS) : processStore;
}

export async function handleSessionCreate(
  request: Request,
  env: Env,
  store: SessionStore,
  idFactory: () => string = randomId,
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (!body || typeof body.productId !== "string") {
    return jsonResponse({ error: "Invalid session request" }, 400);
  }
  if (isRetiredProductId(body.productId)) {
    return jsonResponse({ error: "Product retired" }, 403);
  }
  const draft: SessionDraft = {
    productId: body.productId,
    metadata: isRecord(body.metadata) ? body.metadata : {},
  };
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    draft.origin = origin;
  }
  if (typeof body.visitorId === "string") {
    draft.visitorId = body.visitorId;
  }
  const session = await store.create(idFactory(), draft, ttlSeconds(env));
  return jsonResponse({ sessionId: session.id }, 201);
}

export async function handleChat(
  request: Request,
  env: Env,
  store: SessionStore,
  idFactory: () => string = randomId,
  waitUntil: WaitUntil = noopWaitUntil,
  obsFetcher?: Parameters<typeof makeObservability>[2],
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (!body || typeof body.sessionId !== "string" || typeof body.message !== "string") {
    return jsonResponse({ error: "Invalid chat request" }, 400);
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ error: "Message too long" }, 400);
  }
  const session = await store.get(body.sessionId);
  if (!session) {
    return jsonResponse({ error: "Session not found" }, 404);
  }
  if (!requestMatchesSessionOrigin(request, session)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (isRetiredProductId(session.productId)) {
    return jsonResponse({ error: "Product retired" }, 403);
  }
  const messageId = idFactory();
  const userMessage = body.message;
  const history = session.transcript.slice();

  if (isContinuousDevelopmentRequest(userMessage)) {
    await store.appendMessage(session.id, { role: "user", content: body.message });
    const refusal =
      "I can't commit to continuous development work. I can explain current product capabilities or route you to a human.";
    await store.appendMessage(session.id, { role: "assistant", content: refusal });
    return sseResponse([
      { event: "message.delta", data: { messageId, delta: refusal } },
      { event: "message.done", data: { messageId } },
    ]);
  }

  const context = await fetchSignedProductContext(session.productId, env, fetch);
  if (!context.ok) {
    // Do not persist the user turn before context fetch succeeds: appending it
    // first would let a client retry (after a 502) append the same user message
    // twice and corrupt the history the model sees on the next turn.
    return jsonResponse({ error: "Product context unavailable" }, 502);
  }
  await store.appendMessage(session.id, { role: "user", content: body.message });

  const route = selectRoute(
    {
      primaryFailed: false,
      sourceRelevant: sourceRelevant(context.product, userMessage),
      confidence: confidenceFor(userMessage),
    },
    env,
  );
  let contentResult = await callOpenRouter(
    route.kind,
    env,
    context.product,
    userMessage,
    history,
    fetch,
  );
  if (!contentResult.ok && route.kind === "primary") {
    contentResult = await callOpenRouter(
      "fallback",
      env,
      context.product,
      userMessage,
      history,
      fetch,
    );
  }

  const obs = obsFor(env, session.productId, obsFetcher);
  const prelude: SseOutput[] = [];
  // lead.captured is emitted on the FIRST turn after a successful CRM push: the
  // push completes via waitUntil after the previous stream closed, so it can't
  // be injected into that closed stream. Emit it once, here, then mark it.
  if (session.routeReceipt !== undefined && session.leadCaptureEmitted !== true) {
    const receipt = session.routeReceipt;
    prelude.push({
      event: "lead.captured",
      data: { leadId: receipt.leadId, status: receipt.status },
    });
    waitUntil(store.updateLeadState(session.id, { leadCaptureEmitted: true }));
    waitUntil(
      obs.track("sdr_lead_captured", { productId: session.productId, status: receipt.status }),
    );
  }
  const firstSource = context.product.sources?.[0];
  if (firstSource !== undefined) {
    prelude.push({ event: "source", data: { source: firstSource as unknown as StableJsonValue } });
  }
  const recommendation = planRecommendation(context.product, userMessage);
  if (recommendation !== null) {
    prelude.push({ event: "plan.recommendation", data: { recommendation } });
  }
  // Kick off lead extraction + push AFTER the answer is committed, never on the
  // hot path. Re-read the session so extraction sees the freshly-appended
  // assistant turn (the gate counts turns). Fire-and-forget via waitUntil.
  const triggerExtraction = (): void => {
    // Deferred work requires a real execution context. When none was provided
    // (noopWaitUntil — e.g. a runtime without ctx, or a direct unit-test call
    // that did not opt in), skip extraction entirely rather than start a promise
    // whose side effects (a second model call) would run un-awaited.
    if (waitUntil === noopWaitUntil) {
      return;
    }
    waitUntil(
      (async () => {
        const fresh = await store.get(session.id);
        if (fresh && shouldExtract(fresh)) {
          await runExtractionAndMaybePush(fresh, env, store, fetch, obs);
        }
      })(),
    );
  };

  // End-of-turn events only. The prelude (`source`, `plan.recommendation`) is
  // emitted exactly once at the start of the stream by the streaming/non-stream
  // paths below; finalEvents must NOT re-include it or those events would be
  // duplicated once per turn.
  const finalEvents = (content: string): SseOutput[] => {
    const endEvents: SseOutput[] = [];
    const trialCta = trialCtaForProduct(context.product, userMessage, content);
    if (trialCta !== null) {
      endEvents.push({
        event: "trial.cta",
        data: {
          cta: trialCta,
        },
      });
    }
    endEvents.push({ event: "message.done", data: { messageId } });
    return endEvents;
  };
  if (contentResult.ok && contentResult.stream !== undefined) {
    return streamingSseResponse(prelude, contentResult.stream, messageId, {
      onDone: async (content) => {
        await store.appendMessage(session.id, { role: "assistant", content });
        triggerExtraction();
        return finalEvents(content);
      },
      onError: async (content) => {
        // A mid-stream failure must still terminate the SSE cleanly: persist
        // whatever partial assistant content accumulated, then emit an `error`
        // event plus `message.done` so the client stops showing "Thinking…".
        if (content !== "") {
          await store.appendMessage(session.id, { role: "assistant", content });
        }
        return [
          {
            event: "error",
            data: { code: "stream_failed", message: "The response was interrupted." },
          },
          { event: "message.done", data: { messageId } },
        ];
      },
    });
  }
  const events: SseOutput[] = [...prelude];
  const content = contentResult.ok
    ? stripThinkBlocks(contentResult.content)
    : "I could not generate a response right now.";
  await store.appendMessage(session.id, { role: "assistant", content });
  triggerExtraction();
  if (!contentResult.ok) {
    // Every model route failed or timed out. Emit a graceful failure terminal
    // sequence rather than leaving the client hanging.
    events.push({
      event: "error",
      data: { code: "model_unavailable", message: "The assistant is temporarily unavailable." },
    });
  }
  events.push({ event: "message.delta", data: { messageId, delta: content } });
  const trialCta = trialCtaForProduct(context.product, userMessage, content);
  if (trialCta !== null) {
    events.push({
      event: "trial.cta",
      data: {
        cta: trialCta,
      },
    });
  }
  events.push({ event: "message.done", data: { messageId } });
  return sseResponse(events);
}

export async function handleHandoff(
  request: Request,
  env: Env,
  store: SessionStore,
  idFactory: () => string = randomId,
  waitUntil: WaitUntil = noopWaitUntil,
  obsFetcher?: Parameters<typeof makeObservability>[2],
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (!body || typeof body.sessionId !== "string") {
    return jsonResponse({ error: "Invalid handoff request" }, 400);
  }
  const session = await store.get(body.sessionId);
  if (!session) {
    return jsonResponse({ error: "Session not found" }, 404);
  }
  if (!requestMatchesSessionOrigin(request, session)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (isRetiredProductId(session.productId)) {
    return jsonResponse({ error: "Product retired" }, 403);
  }
  const message = typeof body.message === "string" ? body.message : "";
  const handoff: Session["handoff"] = {
    requested: true,
    handoffId: idFactory(),
    message: sanitizeText(message),
  };
  if (typeof body.reason === "string") {
    handoff.reason = body.reason;
  }
  if (asksForContact(message) && isContactInfo(body.contact)) {
    handoff.contact = body.contact;
  }
  await store.setHandoff(session.id, handoff);

  // A handoff is the strongest lead signal there is. Run extraction + push off
  // the hot path so the 202 returns immediately (no CRM latency on this path).
  // Re-read so the pushed profile reflects the just-set handoff (activities).
  // Skip when no real execution context is available (noopWaitUntil).
  if (waitUntil !== noopWaitUntil) {
    const obs = obsFor(env, session.productId, obsFetcher);
    waitUntil(
      (async () => {
        const fresh = await store.get(session.id);
        if (fresh) {
          await runExtractionAndMaybePush(fresh, env, store, fetch, obs);
        }
      })(),
    );
  }

  return jsonResponse({ handoffId: handoff.handoffId, status: "queued" }, 202);
}

export async function fetchSignedProductContext(
  productId: string,
  env: Env,
  fetcher: Fetcher,
): Promise<{ ok: true; product: ProductContext } | { ok: false; reason: string }> {
  const contextEndpoint = contextEndpointForProduct(productId, env);
  if (!contextEndpoint || !env.AI_SDR_CONTEXT_SECRET) {
    return { ok: false, reason: "missing_config" };
  }
  const url = new URL(contextEndpoint);
  url.searchParams.set("productId", productId);
  const path = `${url.pathname}${url.search}`;
  const timestamp = new Date().toISOString();
  const nonce = randomId();
  const requestBody: StableJsonValue = { productId };
  const requestPayload = buildHmacPayload({
    timestamp,
    nonce,
    method: "GET",
    path,
    body: requestBody,
  });
  const response = await fetcher(url.toString(), {
    method: "GET",
    headers: {
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
      "X-Ventora-Signature": signHmacPayload(requestPayload, env.AI_SDR_CONTEXT_SECRET),
    },
  });
  if (!response.ok) {
    return { ok: false, reason: "upstream_error" };
  }
  const product = (await response.json()) as unknown;
  if (!isProductContext(product)) {
    return { ok: false, reason: "invalid_context" };
  }
  if (product.productId !== productId) {
    return { ok: false, reason: "invalid_context" };
  }
  const responseTimestamp = response.headers.get("X-Ventora-Timestamp");
  const responseNonce = response.headers.get("X-Ventora-Nonce");
  const responseSignature = response.headers.get("X-Ventora-Signature");
  if (!responseTimestamp || !responseNonce || !responseSignature) {
    return { ok: false, reason: "missing_signature" };
  }
  const payload = buildHmacPayload({
    timestamp: responseTimestamp,
    nonce: responseNonce,
    method: "GET",
    path,
    body: product as unknown as StableJsonValue,
  });
  const verification = verifyHmacSignature({
    payload,
    signature: responseSignature,
    secret: env.AI_SDR_CONTEXT_SECRET,
    timestamp: responseTimestamp,
  });
  return verification.ok
    ? { ok: true, product: minimizeProductContext(product) }
    : { ok: false, reason: verification.reason };
}

function contextEndpointForProduct(productId: string, env: Env): string | null {
  const endpointMap = env.AI_SDR_CONTEXT_ENDPOINTS?.trim();
  if (endpointMap) {
    const endpoints = parseContextEndpointMap(endpointMap, env);
    if (endpoints === null) {
      return null;
    }
    return Object.hasOwn(endpoints, productId) ? (endpoints[productId] ?? null) : null;
  }
  const endpoint = env.AI_SDR_CONTEXT_ENDPOINT?.trim();
  if (!endpoint) {
    return null;
  }
  const parsed = parseHttpsUrl(endpoint, env);
  return parsed === null ? null : parsed.toString();
}

function parseContextEndpointMap(value: string, env: Env): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }
    const endpoints: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [productId, endpoint] of Object.entries(parsed)) {
      if (typeof endpoint !== "string" || endpoint.trim() === "") {
        return null;
      }
      const url = parseHttpsUrl(endpoint, env);
      if (url === null) {
        return null;
      }
      endpoints[productId] = url.toString();
    }
    return endpoints;
  } catch {
    return null;
  }
}

function parseHttpsUrl(value: string, env: Env): URL | null {
  try {
    const url = new URL(value);
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      isLocalhost &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      allowsLocalEndpoint(env)
    ) {
      return url;
    }
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function buildOpenRouterPayload(
  kind: RouteKind,
  env: Env,
  product: ProductContext,
  message: string,
  history: ChatMessage[],
): Record<string, unknown> {
  const config = modelConfig(kind, env);
  const cappedHistory = history.slice(-MAX_HISTORY_MESSAGES);
  return {
    model: config.model,
    ...(config.providers.length > 0 ? { provider: { order: config.providers } } : {}),
    ...(kind === "primary" ? {} : { reasoning: { effort: "medium" } }),
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(product),
      },
      ...cappedHistory.map(({ role, content }) => ({ role, content })),
      { role: "user", content: message },
    ],
  };
}

function buildSystemPrompt(product: ProductContext): string {
  return [
    "You are Ventora AI-SDR, an inbound sales rep. You do two jobs at once: help the prospect learn what this product does and the problems it solves, and learn enough about them to follow up well.",
    "Lead with the problem the product solves and the value it delivers. Then explain fit for the prospect's situation. Use only the calls to action, trial terms, pricing, and buying path present in the signed context.",
    "Qualify by being genuinely curious, never by interrogating. As the conversation opens it up, learn what they are trying to fix or achieve, what they use today, who else weighs in on the decision, and their rough timeline. Ask at most one question at a time, only when it follows from what they just said, and always give value before you ask.",
    "When the prospect shows real interest, offer to have the founder follow up and ask for the best name, work email, and company to reach them. Make it easy to say no. Never hold back an answer or a next step until they share contact details, and help them first, every time.",
    "Never pressure, never ask about budget bluntly, and never stack questions. If the prospect just wants answers, give answers.",
    "Use the signed product context as the single source of truth. Do not invent features, pricing, discounts, integrations, competitors, or policy details.",
    "For pricing: use canonical plan fields exactly. If annual is the default, say annual is the default; if monthly exists, say monthly is available. Include discounts exactly as provided when present.",
    "In comparisons, put our product first, frame the comparison around fit, speed, and simplicity, and keep us on top without making false claims.",
    "For objections, answer directly from context, then suggest the signed context CTA when it fits.",
    "Offer Founder contact when the prospect asks to speak to a human, asks for a capability not in the signed context, or shows clear buying intent (asks about next steps, getting started, onboarding, or a deal). If a capability is not listed, say it is not listed in the current context. Do not push or suggest human contact otherwise.",
    "Human handoff label: Founder contact. Never invent a contact channel: the only ones you may offer are those present in the signed context.",
    "If the signed context includes meetingLinks and the prospect wants to talk to the founder, book time, see a walkthrough, or get onboarding help, offer the matching meeting link with its exact url. Pick the link whose purpose fits the request. Never invent a booking url.",
    "Write concise chat copy with short paragraphs and bullets. Never output markdown tables. Avoid raw markdown emphasis markers unless emphasis is necessary and renderable by the client.",
    `Signed product context: ${stableJson(product as unknown as StableJsonValue)}`,
  ].join("\n");
}

function isUsableSource(source: ProductSource): boolean {
  return (
    typeof source.id === "string" &&
    typeof source.title === "string" &&
    typeof source.url === "string"
  );
}

function minimizeProductContext(product: ProductContext): ProductContext {
  const minimized: ProductContext = {
    productId: sanitizeText(product.productId),
    name: sanitizeText(product.name),
  };
  if (product.description !== undefined) {
    minimized.description = truncateText(sanitizeText(product.description), 600);
  }
  if (product.sources !== undefined) {
    // The signed context is authenticated, not schema-validated: a product
    // backend can send a source missing the contract-required id/title/url.
    // Drop those rather than crash truncateText (and never emit a malformed
    // "source" SSE event downstream).
    minimized.sources = product.sources
      .filter(isUsableSource)
      .slice(0, 8)
      .map((source) => ({
        id: truncateText(source.id, 120),
        title: truncateText(sanitizeText(source.title), 160),
        url: source.url,
        ...(source.excerpt === undefined
          ? {}
          : { excerpt: truncateText(sanitizeText(source.excerpt), 600) }),
      }));
  }
  if (product.plans !== undefined) {
    minimized.plans = product.plans.slice(0, 8).map((plan) => ({
      id: truncateText(plan.id, 120),
      name: truncateText(sanitizeText(plan.name), 160),
      ...(plan.price === undefined ? {} : { price: truncateText(sanitizeText(plan.price), 120) }),
      ...(plan.monthlyPrice === undefined
        ? {}
        : { monthlyPrice: truncateText(sanitizeText(plan.monthlyPrice), 120) }),
      ...(plan.annualPrice === undefined
        ? {}
        : { annualPrice: truncateText(sanitizeText(plan.annualPrice), 120) }),
      ...(plan.discount === undefined
        ? {}
        : { discount: truncateText(sanitizeText(plan.discount), 120) }),
      ...(isDefaultCadence(plan.defaultCadence) ? { defaultCadence: plan.defaultCadence } : {}),
      ...(plan.trialDays === undefined ? {} : { trialDays: plan.trialDays }),
      ...(plan.ctaUrl === undefined ? {} : { ctaUrl: plan.ctaUrl }),
      ...(plan.features === undefined
        ? {}
        : {
            features: plan.features
              .slice(0, 12)
              .map((feature) => truncateText(sanitizeText(feature), 160)),
          }),
    }));
  }
  if (product.meetingLinks !== undefined) {
    minimized.meetingLinks = product.meetingLinks.slice(0, 12).map((link) => ({
      id: truncateText(link.id, 120),
      label: truncateText(sanitizeText(link.label), 120),
      url: link.url,
      ...(link.description === undefined
        ? {}
        : { description: truncateText(sanitizeText(link.description), 240) }),
    }));
  }
  return minimized;
}

export function selectRoute(
  signal: { primaryFailed: boolean; sourceRelevant: boolean; confidence: number },
  env: Env,
): { kind: RouteKind } {
  if (signal.primaryFailed) {
    return { kind: "fallback" };
  }
  if (signal.sourceRelevant && signal.confidence < confidenceThreshold(env)) {
    return { kind: "escalation" };
  }
  return { kind: "primary" };
}

export function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .trim()
    .split(/(?:\r\n|\r|\n){2}/)
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split(/\r\n|\r|\n/);
      const event = (lines.find((line) => line.startsWith("event: ")) ?? "event: ").slice(7);
      const data = JSON.parse(
        (lines.find((line) => line.startsWith("data: ")) ?? "data: null").slice(6),
      ) as unknown;
      return { event, data };
    });
}

type SseOutput = { event: string; data: StableJsonValue };

async function callOpenRouter(
  kind: RouteKind,
  env: Env,
  product: ProductContext,
  message: string,
  history: ChatMessage[],
  fetcher: Fetcher,
): Promise<{ ok: true; content: string; stream?: ReadableStream<Uint8Array> } | { ok: false }> {
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false };
  }
  const endpoint = openRouterEndpoint(env);
  if (endpoint === null) {
    return { ok: false };
  }
  let response: Response;
  try {
    // Bound the upstream call so a hung OpenRouter connection cannot pin the
    // request open forever. On timeout the fetch rejects (AbortError) and we
    // fall through to the next route / graceful failure rather than hanging.
    response = await fetcher(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(openRouterTimeoutMs(env)),
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...buildOpenRouterPayload(kind, env, product, message, history),
        stream: true,
      }),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false };
  }
  if (
    response.body !== null &&
    response.headers.get("Content-Type")?.includes("text/event-stream")
  ) {
    return { ok: true, content: "", stream: response.body };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false };
  }
  const content = readOpenRouterContent(body);
  return content ? { ok: true, content } : { ok: false };
}

export function allowsLocalEndpoint(env: Env): boolean {
  const mode = env.ENVIRONMENT ?? env.NODE_ENV;
  // Explicit dev values ONLY. undefined must NOT enable the localhost bypass (prod safety).
  return mode === "local" || mode === "development" || mode === "test";
}

export function openRouterEndpoint(env: Env): string | null {
  const endpoint = env.OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions";
  try {
    const url = new URL(endpoint);
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      isLocalhost &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      allowsLocalEndpoint(env)
    ) {
      url.search = "";
      url.hash = "";
      return url.toString();
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "openrouter.ai" ||
      url.pathname !== "/api/v1/chat/completions"
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function readOpenRouterContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return null;
  }
  const first = value.choices[0];
  return isRecord(first) && isRecord(first.message) && typeof first.message.content === "string"
    ? first.message.content
    : null;
}

function modelConfig(kind: RouteKind, env: Env): { model: string; providers: string[] } {
  if (kind === "fallback") {
    return {
      model: env.AI_SDR_FALLBACK_MODEL ?? "openai/gpt-5.4-nano",
      providers: splitCsv(env.AI_SDR_FALLBACK_PROVIDERS ?? ""),
    };
  }
  if (kind === "escalation") {
    return {
      model: env.AI_SDR_ESCALATION_MODEL ?? "x-ai/grok-4.3",
      providers: splitCsv(env.AI_SDR_ESCALATION_PROVIDERS ?? ""),
    };
  }
  return {
    model: env.AI_SDR_PRIMARY_MODEL ?? "minimax/minimax-m3",
    providers: splitCsv(env.AI_SDR_PRIMARY_PROVIDERS ?? ""),
  };
}

function sseResponse(events: SseOutput[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

function streamingSseResponse(
  prelude: SseOutput[],
  source: ReadableStream<Uint8Array>,
  messageId: string,
  handlers: {
    onDone: (content: string) => Promise<SseOutput[]>;
    onError: (content: string) => Promise<SseOutput[]>;
  },
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of prelude) {
        controller.enqueue(encoder.encode(formatSse(event)));
      }
      const reader = source.getReader();
      const stripper = createThinkStripper();
      let buffer = "";
      let content = "";
      try {
        while (true) {
          const read = await reader.read();
          if (read.done) {
            break;
          }
          buffer += decoder.decode(read.value, { stream: true });
          const parsed = drainOpenRouterFrames(buffer);
          buffer = parsed.remainder;
          for (const delta of parsed.deltas) {
            const clean = stripper.push(delta);
            content += clean;
            if (clean !== "") {
              controller.enqueue(
                encoder.encode(
                  formatSse({ event: "message.delta", data: { messageId, delta: clean } }),
                ),
              );
            }
          }
        }
        buffer += decoder.decode();
        const parsed = drainOpenRouterFrames(`${buffer}\n\n`);
        for (const delta of parsed.deltas) {
          const clean = stripper.push(delta);
          content += clean;
          if (clean !== "") {
            controller.enqueue(
              encoder.encode(
                formatSse({ event: "message.delta", data: { messageId, delta: clean } }),
              ),
            );
          }
        }
        const tail = stripper.flush();
        if (tail !== "") {
          content += tail;
          controller.enqueue(
            encoder.encode(formatSse({ event: "message.delta", data: { messageId, delta: tail } })),
          );
        }
        for (const event of await handlers.onDone(content)) {
          controller.enqueue(encoder.encode(formatSse(event)));
        }
        controller.close();
      } catch {
        // A mid-stream failure (reader/network error after partial content)
        // must not abort the SSE: that leaves the browser stuck on "Thinking…".
        // Emit a terminal `error` + `message.done` sequence and close cleanly.
        try {
          for (const event of await handlers.onError(content)) {
            controller.enqueue(encoder.encode(formatSse(event)));
          }
        } catch {
          // ignore secondary failures while emitting the terminal sequence
        }
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

function formatSse(event: SseOutput): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function drainOpenRouterFrames(buffer: string): { deltas: string[]; remainder: string } {
  const deltas: string[] = [];
  const delimiter = /\r?\n\r?\n/;
  let remainder = buffer;
  let match = delimiter.exec(remainder);
  while (match !== null) {
    const frame = remainder.slice(0, match.index);
    remainder = remainder.slice(match.index + match[0].length);
    const delta = readOpenRouterSseDelta(frame);
    if (delta !== null) {
      deltas.push(delta);
    }
    match = delimiter.exec(remainder);
  }
  return { deltas, remainder };
}

/**
 * Remove minimax-style `<think>…</think>` reasoning spans from a complete model
 * response so the chain-of-thought never reaches the user. Handles multiple
 * blocks and tolerates an unterminated trailing `<think>` by dropping the rest.
 */
function stripThinkBlocks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<think>", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf("</think>", open + 7);
    if (close === -1) {
      break; // unterminated reasoning block: drop the remainder
    }
    i = close + 8;
  }
  return out.replace(/[ \t]*\n{3,}/g, "\n\n").trim();
}

/**
 * Stateful streaming filter that strips `<think>…</think>` spans across chunk
 * boundaries (an opening or closing tag may be split between deltas). `push`
 * returns only the text that is safe to forward; `flush` returns any trailing
 * text that was being held back but turned out not to be a tag (dropping it if
 * the stream ended mid-reasoning).
 */
function createThinkStripper(): { push(chunk: string): string; flush(): string } {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inside = false;
  let pending = "";
  const partialTail = (buf: string, tag: string): number => {
    const max = Math.min(buf.length, tag.length - 1);
    for (let k = max; k > 0; k--) {
      if (buf.slice(buf.length - k) === tag.slice(0, k)) {
        return k;
      }
    }
    return 0;
  };
  return {
    push(chunk: string): string {
      let buf = pending + chunk;
      pending = "";
      let out = "";
      while (buf.length > 0) {
        if (!inside) {
          const idx = buf.indexOf(OPEN);
          if (idx !== -1) {
            out += buf.slice(0, idx);
            buf = buf.slice(idx + OPEN.length);
            inside = true;
            continue;
          }
          const tail = partialTail(buf, OPEN);
          out += buf.slice(0, buf.length - tail);
          pending = buf.slice(buf.length - tail);
          break;
        }
        const idx = buf.indexOf(CLOSE);
        if (idx !== -1) {
          buf = buf.slice(idx + CLOSE.length);
          inside = false;
          continue;
        }
        pending = buf.slice(buf.length - partialTail(buf, CLOSE));
        break;
      }
      return out;
    },
    flush(): string {
      const rest = inside ? "" : pending;
      pending = "";
      return rest;
    },
  };
}

function readOpenRouterSseDelta(frame: string): string | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (data === "" || data === "[DONE]") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null; // skip malformed frame instead of poisoning the stream
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    return null;
  }
  const first = parsed.choices[0];
  return isRecord(first) && isRecord(first.delta) && typeof first.delta.content === "string"
    ? first.delta.content
    : null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hostedClientResponse(script: string, cache: "alias" | "versioned"): Response {
  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control":
        cache === "versioned"
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300, must-revalidate",
    },
  });
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    return response;
  }
  const allowedOrigin = allowedCorsOrigin(origin, env);
  if (allowedOrigin === null) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "content-type, x-requested-with, x-ventora-client, x-ventora-timestamp, x-ventora-nonce, x-ventora-signature",
  );
  headers.set("Access-Control-Max-Age", "86400");
  if (allowedOrigin !== "*") {
    headers.append("Vary", "Origin");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requireAllowedOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (origin === null || allowedCorsOrigin(origin, env) === null) {
    // Include Access-Control-Allow-Origin on the 403 so cross-origin browsers
    // can read the error body rather than seeing an opaque network error.
    const forbidden = jsonResponse({ error: "Forbidden origin" }, 403);
    if (origin !== null) {
      const headers = new Headers(forbidden.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.append("Vary", "Origin");
      return new Response(forbidden.body, { status: 403, headers });
    }
    return forbidden;
  }
  return null;
}

const consumedClientAssertions = new Map<string, number>();
const CLIENT_ASSERTION_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_ASSERTION_OBJECT_NAME = "__client_assertions__";

async function requireClientAssertion(request: Request, env: Env): Promise<Response | null> {
  if (!env.AI_SDR_CLIENT_ASSERTION_SECRET) {
    return allowsUnsignedClientAssertions(env)
      ? null
      : jsonResponse({ error: "Invalid client assertion" }, 401);
  }
  const body = await readJsonRecord(request.clone() as Request);
  const timestamp = request.headers.get("X-Ventora-Timestamp");
  const nonce = request.headers.get("X-Ventora-Nonce");
  const signature = request.headers.get("X-Ventora-Signature");
  if (!body || !timestamp || !nonce || !signature) {
    return jsonResponse({ error: "Invalid client assertion" }, 401);
  }
  const payload = buildHmacPayload({
    timestamp,
    nonce,
    method: request.method,
    path: new URL(request.url).pathname,
    body: body as unknown as StableJsonValue,
  });
  const verification = verifyHmacSignature({
    payload,
    signature,
    secret: env.AI_SDR_CLIENT_ASSERTION_SECRET,
    timestamp,
  });
  if (!verification.ok || !(await consumeClientAssertion(env, timestamp, nonce, signature))) {
    return jsonResponse({ error: "Invalid client assertion" }, 401);
  }
  return null;
}

function allowsUnsignedClientAssertions(env: Env): boolean {
  const mode = env.ENVIRONMENT ?? env.NODE_ENV;
  return mode === "local" || mode === "development" || mode === "test";
}

async function consumeClientAssertion(
  env: Env,
  timestamp: string,
  nonce: string,
  _signature: string,
): Promise<boolean> {
  const now = Date.now();
  const key = `${timestamp}:${nonce}`;
  const expiresAt = now + CLIENT_ASSERTION_REPLAY_WINDOW_MS;
  if (env.AI_SDR_SESSIONS) {
    const id = env.AI_SDR_SESSIONS.idFromName(CLIENT_ASSERTION_OBJECT_NAME);
    const response = await env.AI_SDR_SESSIONS.get(id).fetch(
      "https://ai-sdr-session/consume-client-assertion",
      {
        method: "POST",
        body: JSON.stringify({ key, expiresAt }),
      },
    );
    return response.ok;
  }

  for (const [key, expiresAt] of consumedClientAssertions) {
    if (expiresAt <= now) {
      consumedClientAssertions.delete(key);
    }
  }
  if (consumedClientAssertions.has(key)) {
    return false;
  }
  consumedClientAssertions.set(key, expiresAt);
  return true;
}

function allowedCorsOrigin(origin: string, env: Env): string | null {
  const configured = splitCsv(env.AI_SDR_ALLOWED_ORIGINS ?? "");
  return configured.includes(origin) ? origin : null;
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function ttlSeconds(env: Env): number {
  const parsed = Number(env.AI_SDR_SESSION_TTL_SECONDS ?? "86400");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400;
}

function confidenceThreshold(env: Env): number {
  const parsed = Number(env.AI_SDR_CONFIDENCE_THRESHOLD ?? "0.72");
  return Number.isFinite(parsed) ? parsed : 0.72;
}

const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;

export function openRouterTimeoutMs(env: Env): number {
  const parsed = Number(env.AI_SDR_OPENROUTER_TIMEOUT_MS ?? String(DEFAULT_OPENROUTER_TIMEOUT_MS));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENROUTER_TIMEOUT_MS;
}

function confidenceFor(message: string): number {
  return /\b(price|pricing|trial|demo|plan|cost)\b/i.test(message) ? 0.65 : 0.86;
}

function sourceRelevant(product: ProductContext, message: string): boolean {
  const sourceText =
    product.sources?.map((source) => `${source.title} ${source.excerpt ?? ""}`).join(" ") ?? "";
  return message
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3)
    .some((word) => sourceText.toLowerCase().includes(word));
}

function shouldOfferTrial(message: string, response: string, product: ProductContext): boolean {
  const hasTrialPlan = product.plans?.some(planHasTrial) ?? false;
  return (
    hasTrialPlan &&
    (/\b(start|try|trial|sign up|demo)\b/i.test(message) || /\b(good fit|trial)\b/i.test(response))
  );
}

function trialCtaForProduct(
  product: ProductContext,
  message: string,
  response: string,
): StableJsonValue | null {
  if (!shouldOfferTrial(message, response, product)) {
    return null;
  }
  const plan = product.plans?.find(planHasTrial);
  if (plan === undefined || plan.ctaUrl === undefined) {
    return null;
  }
  return {
    label: ctaLabelForPlan(product, plan),
    url: plan.ctaUrl,
  };
}

function planHasTrial(plan: ProductPlan): boolean {
  const trialText = `${plan.price ?? ""} ${plan.monthlyPrice ?? ""} ${plan.annualPrice ?? ""} ${
    plan.discount ?? ""
  } ${plan.features?.join(" ") ?? ""}`;
  if (
    /\b(no|without|unavailable|not available|not offered|none)\s+(?:free\s+)?trial\b/i.test(
      trialText,
    )
  ) {
    return false;
  }
  if (/\btrial\s+(?:unavailable|not available|not offered)\b/i.test(trialText)) {
    return false;
  }
  if (typeof plan.trialDays === "number" && plan.trialDays > 0) {
    return true;
  }
  return /\btrial\b/i.test(trialText);
}

function ctaLabelForPlan(product: ProductContext, plan: ProductPlan): string {
  if (/\bcamaudit\b/i.test(`${product.productId} ${product.name}`)) {
    return "Start partner setup";
  }
  if (plan.ctaUrl !== undefined && /\bpartners?\b/i.test(plan.ctaUrl)) {
    return "Start partner setup";
  }
  return "Start trial";
}

function planRecommendation(product: ProductContext, message: string): StableJsonValue | null {
  const plan = bestMatchingPlan(product.plans, message);
  if (
    plan === undefined ||
    !/\b(price|pricing|trial|demo|plan|cost|audit|audits|credit|credits)\b/i.test(message)
  ) {
    return null;
  }
  const recommendation: StableJsonValue = {
    reason: "Recommended from signed product plan context.",
    confidence: 0.65,
  };
  // The HMAC validator only enforces productId + name, so a validly-signed plan
  // can omit its id. Only surface planId when it is a usable string — never leak
  // an empty planId that the client would render as a broken plan card.
  if (typeof plan.id === "string" && plan.id.length > 0) {
    recommendation.planId = plan.id;
  }
  const priceSummary = planPriceSummary(plan);
  if (priceSummary !== null) {
    recommendation.priceSummary = priceSummary;
  }
  return recommendation;
}

function bestMatchingPlan(
  plans: ProductPlan[] | undefined,
  message: string,
): ProductPlan | undefined {
  if (plans === undefined || plans.length === 0) {
    return undefined;
  }
  const tokens = messageTokens(message);
  const requestedAuditVolume = auditVolumeFromMessage(message);
  let bestPlan = plans[0];
  let bestScore = -1;
  for (const plan of plans) {
    const haystack = planSearchText(plan);
    const textScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    const volumeScore =
      requestedAuditVolume === null ? 0 : auditVolumeScore(plan, requestedAuditVolume);
    const score = textScore + volumeScore;
    if (score > bestScore) {
      bestPlan = plan;
      bestScore = score;
    }
  }
  return bestPlan;
}

function planSearchText(plan: ProductPlan): string {
  return `${plan.id} ${plan.name} ${plan.price ?? ""} ${plan.monthlyPrice ?? ""} ${
    plan.annualPrice ?? ""
  } ${plan.discount ?? ""} ${plan.defaultCadence ?? ""} ${plan.features?.join(" ") ?? ""}`
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (match) => match.replace(/,/g, ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function messageTokens(message: string): string[] {
  const tokens = message
    .toLowerCase()
    .split(/\W+/)
    .flatMap((word) => normalizedTokenVariants(word));
  return Array.from(new Set(tokens));
}

function normalizedTokenVariants(word: string): string[] {
  if (word.length === 0) {
    return [];
  }
  if (/^\d+$/.test(word)) {
    return [word];
  }
  if (word.length <= 3) {
    return [];
  }
  const variants = [word];
  if (word.endsWith("ies") && word.length > 4) {
    variants.push(`${word.slice(0, -3)}y`);
  } else if (word.endsWith("s") && word.length > 4) {
    variants.push(word.slice(0, -1));
  }
  return variants;
}

function auditVolumeFromMessage(message: string): number | null {
  const matches = message.matchAll(/\b(\d{1,5})\s+(?:cam\s+)?audits?\b/gi);
  for (const match of matches) {
    return Number(match[1]);
  }
  return null;
}

function auditCreditsFromPlan(plan: ProductPlan): number | null {
  const searchable = planSearchText(plan);
  const matches = searchable.matchAll(
    /\b(\d{1,5})\s+(?:cam\s+)?audit(?:s)?(?:\s+credit(?:s)?)?\b/g,
  );
  for (const match of matches) {
    return Number(match[1]);
  }
  return null;
}

function auditVolumeScore(plan: ProductPlan, requestedAuditVolume: number): number {
  const credits = auditCreditsFromPlan(plan);
  if (credits === null) {
    return 0;
  }
  if (credits >= requestedAuditVolume) {
    return Math.max(0, 10 - Math.log10(credits - requestedAuditVolume + 1));
  }
  return Math.max(0, 4 - Math.log10(requestedAuditVolume - credits + 1));
}

function planPriceSummary(plan: ProductPlan): string | null {
  const parts: string[] = [];
  if (plan.annualPrice !== undefined) {
    parts.push(`Annual ${plan.annualPrice}`);
  }
  if (plan.monthlyPrice !== undefined) {
    parts.push(`Monthly ${plan.monthlyPrice}`);
  }
  if (plan.discount !== undefined) {
    parts.push(plan.discount);
  }
  if (parts.length === 0 && plan.price !== undefined) {
    parts.push(plan.price);
  }
  if (plan.defaultCadence === "year" && parts.length > 0) {
    parts.push("annual default");
  }
  if (plan.defaultCadence === "month" && parts.length > 0) {
    parts.push("monthly default");
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function isContinuousDevelopmentRequest(message: string): boolean {
  return /\b(continuous|forever|every day|ongoing development|build a feature)\b/i.test(message);
}

function requestMatchesSessionOrigin(request: Request, session: Session): boolean {
  // A session with no bound origin (created without an Origin header) must not
  // be usable from any origin. Require a bound origin and an exact match so a
  // session token cannot be replayed cross-origin.
  if (session.origin === undefined) {
    return false;
  }
  return request.headers.get("Origin") === session.origin;
}

function asksForContact(message: string): boolean {
  return /\b(contact me|reach out|call me|email me|please contact)\b/i.test(message);
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      sanitized[key] = sanitizeText(value);
    }
  }
  return sanitized;
}

function sanitizeText(value: string): string {
  // A validly-signed context can still carry a non-string where the type
  // promises a string (the HMAC validator only enforces productId + name), so
  // coerce defensively instead of throwing and 500-ing the chat.
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]");
}

function truncateText(value: string, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isDefaultCadence(value: unknown): value is ProductPlan["defaultCadence"] {
  return value === "month" || value === "year";
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isProductContext(value: unknown): value is ProductContext {
  return isRecord(value) && typeof value.productId === "string" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSessionResponse(response: Response): Promise<Session> {
  if (!response.ok) {
    throw new Error("Durable Object session operation failed");
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !isSession(body.session)) {
    throw new Error("Invalid Durable Object session response");
  }
  return body.session;
}

function isSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.productId === "string" &&
    isRecord(value.metadata) &&
    Array.isArray(value.transcript) &&
    isRecord(value.handoff) &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number"
  );
}

/** A single durable-outbox row as selected from the pending_pushes table. */
type PendingPushRow = {
  id: string;
  session_id: string;
  product_key: string;
  payload_json: string;
  attempts: number;
};

/**
 * Parse a stored outbox payload back into a CrmLeadIngestRequest, validating the
 * shape so a corrupt/legacy row can never be re-sent as a malformed request.
 */
function parseCrmRequest(payloadJson: string): CrmLeadIngestRequest | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return isCrmLeadIngestRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate the wire form of a LeadStatePatch (DO route boundary). Each field is
 * checked independently so a partial patch with one bad field still applies the
 * good fields. Mirrors LeadStatePatch exactly.
 */
function leadStatePatchFromRecord(value: Record<string, unknown>): LeadStatePatch {
  const patch: LeadStatePatch = {};
  if (isLeadProfile(value.leadProfile)) {
    patch.leadProfile = value.leadProfile;
  }
  if (isRouteReceipt(value.routeReceipt)) {
    patch.routeReceipt = value.routeReceipt;
  }
  if (typeof value.lastExtractedTurnIndex === "number") {
    patch.lastExtractedTurnIndex = value.lastExtractedTurnIndex;
  }
  if (typeof value.leadPushPending === "boolean") {
    patch.leadPushPending = value.leadPushPending;
  }
  if (typeof value.leadCaptureEmitted === "boolean") {
    patch.leadCaptureEmitted = value.leadCaptureEmitted;
  }
  return patch;
}

function isRouteReceipt(value: unknown): value is NonNullable<Session["routeReceipt"]> {
  return (
    isRecord(value) &&
    typeof value.customerId === "string" &&
    typeof value.leadId === "string" &&
    isLeadStatus(value.status)
  );
}

export class AiSdrSession implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      return this.createSession(request);
    }
    if (request.method === "GET" && url.pathname === "/get") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? this.readSession(sessionId) : undefined;
      return session
        ? jsonResponse({ session }, 200)
        : jsonResponse({ error: "Session not found" }, 404);
    }
    if (request.method === "POST" && url.pathname === "/append-message") {
      return this.updateSession(request, (session, body) => {
        if (isRecord(body.message) && typeof body.message.content === "string") {
          const role = body.message.role;
          if (role === "user" || role === "assistant" || role === "system") {
            // Raw content by design — the lead extractor reads the transcript to
            // capture the prospect's real contact. PII is redacted only at the
            // telemetry/log boundaries, never in the stored transcript.
            session.transcript.push({ role, content: body.message.content });
          }
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/set-handoff") {
      return this.updateSession(request, (session, body) => {
        if (isRecord(body.handoff)) {
          session.handoff = normalizeHandoff(body.handoff);
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/update-lead-state") {
      return this.updateSession(request, (session, body) => {
        if (isRecord(body.patch)) {
          applyLeadStatePatch(session, leadStatePatchFromRecord(body.patch));
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/enqueue-push") {
      return this.enqueuePush(request);
    }
    if (request.method === "POST" && url.pathname === "/consume-client-assertion") {
      return this.consumeClientAssertion(request);
    }
    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();
    // A) Drain due CRM pushes from the durable outbox (bounded batch per tick).
    //    Isolated in try/catch: a storage-layer failure in the drain must not
    //    strand the DO — the TTL GC and alarm reschedule must always run.
    try {
      await this.drainDuePushes(now);
    } catch {
      // Use a stable non-PII key for DO-level (cross-product) error events.
      await makeObservability(this.env, "sdr-worker").captureSentry("sdr_alarm_drain_error", {});
    }
    // B) TTL GC (UNCHANGED): evict expired sessions.
    await this.state.storage.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    // C) Reschedule for the earliest pending push or session expiry.
    await this.scheduleNextAlarm(Date.now());
  }

  private async drainDuePushes(now: number): Promise<void> {
    const due = this.state.storage.sql
      .exec<PendingPushRow>(
        "SELECT id, session_id, product_key, payload_json, attempts FROM pending_pushes WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 10",
        now,
      )
      .toArray();
    for (const row of due) {
      const rowObs = makeObservability(this.env, row.product_key);
      const queuedSession = this.readSession(row.session_id);
      const payload = parseCrmRequest(row.payload_json);
      if (
        isRetiredProductId(row.product_key) ||
        (payload !== null && isRetiredProductId(payload.productKey)) ||
        (queuedSession !== undefined && isRetiredProductId(queuedSession.productId))
      ) {
        await this.state.storage.sql.exec("DELETE FROM pending_pushes WHERE id = ?", row.id);
        if (queuedSession) {
          queuedSession.leadPushPending = false;
          await this.writeSession(queuedSession);
        }
        await rowObs.captureSentry("sdr_push_failed_terminal", {
          productKey: row.product_key,
          reason: "product_retired",
        });
        continue;
      }
      if (payload === null) {
        // Unparseable/invalid payload can never succeed — drop it rather than
        // retry forever. Record a privacy-safe terminal event.
        await rowObs.captureSentry("sdr_push_failed_terminal", {
          productKey: row.product_key,
          reason: "invalid_response",
        });
        await this.state.storage.sql.exec("DELETE FROM pending_pushes WHERE id = ?", row.id);
        continue;
      }
      const result = await pushLeadToCrm({
        config: crmConfig(this.env),
        request: payload,
        fetcher: fetch as CrmFetcher,
        nowFactory: () => new Date(),
        idFactory: randomId,
      });
      if (result.ok) {
        const session = this.readSession(row.session_id);
        if (session) {
          session.routeReceipt = {
            customerId: result.response.customerId,
            leadId: result.response.leadId,
            status: result.response.status,
          };
          session.leadPushPending = false;
          await this.writeSession(session);
        }
        await this.state.storage.sql.exec("DELETE FROM pending_pushes WHERE id = ?", row.id);
        await rowObs.track("sdr_push_ok", {
          productKey: row.product_key,
          status: result.response.status,
        });
        continue;
      }
      if (result.retriable) {
        const attempts = row.attempts + 1;
        const delay = nextAttemptDelay(attempts);
        if (delay === null) {
          await rowObs.captureSentry("sdr_push_retry_exhausted", { productKey: row.product_key });
          await this.state.storage.sql.exec("DELETE FROM pending_pushes WHERE id = ?", row.id);
          // Clear the flag so future extractions are not permanently suppressed.
          const exhaustedSession = this.readSession(row.session_id);
          if (exhaustedSession) {
            exhaustedSession.leadPushPending = false;
            await this.writeSession(exhaustedSession);
          }
          continue;
        }
        await this.state.storage.sql.exec(
          "UPDATE pending_pushes SET attempts = ?, next_attempt_at = ?, last_reason = ? WHERE id = ?",
          attempts,
          now + delay,
          result.reason,
          row.id,
        );
        await rowObs.track("sdr_push_retriable", {
          productKey: row.product_key,
          reason: result.reason,
        });
        continue;
      }
      // Terminal (non-retriable, non-"not_configured") contract/client error.
      await rowObs.captureSentry("sdr_push_failed_terminal", {
        productKey: row.product_key,
        reason: result.reason,
      });
      await this.state.storage.sql.exec("DELETE FROM pending_pushes WHERE id = ?", row.id);
      // Clear the flag so future extractions are not permanently suppressed.
      const terminalSession = this.readSession(row.session_id);
      if (terminalSession) {
        terminalSession.leadPushPending = false;
        await this.writeSession(terminalSession);
      }
    }
  }

  private async scheduleNextAlarm(now: number): Promise<void> {
    const nextPush = this.state.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(next_attempt_at) AS next FROM pending_pushes")
      .toArray()[0]?.next;
    const nextSession = this.state.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM sessions")
      .toArray()[0]?.next;
    const candidates = [nextPush, nextSession].filter(
      (value): value is number => typeof value === "number",
    );
    if (candidates.length === 0) {
      return;
    }
    // Never schedule in the past: a due-but-undrained row (e.g. CRM still failing)
    // would otherwise busy-loop the alarm. Floor at now so CF fires once promptly.
    await this.state.storage.setAlarm(Math.max(Math.min(...candidates), now));
  }

  private async enqueuePush(request: Request): Promise<Response> {
    const body = await readJsonRecord(request);
    if (
      !body ||
      typeof body.sessionId !== "string" ||
      typeof body.productKey !== "string" ||
      typeof body.payloadJson !== "string"
    ) {
      return jsonResponse({ error: "Invalid enqueue-push request" }, 400);
    }
    const payload = parseCrmRequest(body.payloadJson);
    if (
      isRetiredProductId(body.productKey) ||
      (payload !== null && isRetiredProductId(payload.productKey))
    ) {
      return jsonResponse({ error: "Product retired" }, 403);
    }
    const now = Date.now();
    await this.state.storage.sql.exec(
      "INSERT INTO pending_pushes (id, session_id, product_key, payload_json, attempts, next_attempt_at, created_at, last_reason) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)",
      randomId(),
      body.sessionId,
      body.productKey,
      body.payloadJson,
      now,
      now,
    );
    await this.scheduleNextAlarm(now);
    return jsonResponse({ ok: true }, 200);
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await readJsonRecord(request);
    if (!body || typeof body.sessionId !== "string" || !isRecord(body.draft)) {
      return jsonResponse({ error: "Invalid Durable Object session request" }, 400);
    }
    const ttl = typeof body.ttlSeconds === "number" ? body.ttlSeconds : ttlSeconds(this.env);
    const session = createSessionFromDraft(body.sessionId, body.draft, ttl);
    await this.writeSession(session);
    // Route the alarm through scheduleNextAlarm so it always reflects the
    // earliest of this session's expiry AND any already-pending push, rather
    // than clobbering a sooner push alarm with this session's TTL.
    await this.scheduleNextAlarm(Date.now());
    return jsonResponse({ session }, 200);
  }

  private async updateSession(
    request: Request,
    mutate: (session: Session, body: Record<string, unknown>) => void,
  ): Promise<Response> {
    const body = await readJsonRecord(request);
    if (!body || typeof body.sessionId !== "string") {
      return jsonResponse({ error: "Invalid Durable Object update request" }, 400);
    }
    const session = this.readSession(body.sessionId);
    if (!session) {
      return jsonResponse({ error: "Session not found" }, 404);
    }
    mutate(session, body);
    await this.writeSession(session);
    return jsonResponse({ session }, 200);
  }

  private async ensureSchema(): Promise<void> {
    await this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    );
    await this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS client_assertions (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
    await this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending_pushes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, product_key TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_reason TEXT)",
    );
    await this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_pushes_next_attempt ON pending_pushes (next_attempt_at ASC)",
    );
  }

  private async consumeClientAssertion(request: Request): Promise<Response> {
    const body = await readJsonRecord(request);
    if (!body || typeof body.key !== "string" || typeof body.expiresAt !== "number") {
      return jsonResponse({ error: "Invalid client assertion request" }, 400);
    }
    const now = Date.now();
    await this.state.storage.sql.exec("DELETE FROM client_assertions WHERE expires_at <= ?", now);
    const existing = this.state.storage.sql
      .exec<{ key: string }>("SELECT key FROM client_assertions WHERE key = ?", body.key)
      .toArray();
    if (existing.length > 0) {
      return jsonResponse({ error: "Client assertion replay" }, 409);
    }
    await this.state.storage.sql.exec(
      "INSERT INTO client_assertions (key, expires_at) VALUES (?, ?)",
      body.key,
      body.expiresAt,
    );
    return jsonResponse({ ok: true }, 200);
  }

  private readSession(id: string): Session | undefined {
    const rows = this.state.storage.sql
      .exec<{ payload: string; expires_at: number }>(
        "SELECT payload, expires_at FROM sessions WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row || row.expires_at <= Date.now()) {
      return undefined;
    }
    const parsed = JSON.parse(row.payload) as unknown;
    return isSession(parsed) ? parsed : undefined;
  }

  private async writeSession(session: Session): Promise<void> {
    await this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO sessions (id, payload, expires_at) VALUES (?, ?, ?)",
      session.id,
      JSON.stringify(session),
      session.expiresAt,
    );
  }
}

function createSessionFromDraft(
  id: string,
  draft: Record<string, unknown>,
  ttlSecondsValue: number,
): Session {
  const now = Date.now();
  const session: Session = {
    id,
    productId: typeof draft.productId === "string" ? draft.productId : "",
    metadata: sanitizeMetadata(isRecord(draft.metadata) ? draft.metadata : {}),
    transcript: [],
    handoff: { requested: false },
    createdAt: now,
    expiresAt: now + ttlSecondsValue * 1000,
  };
  if (typeof draft.visitorId === "string") {
    session.visitorId = draft.visitorId;
  }
  if (typeof draft.origin === "string") {
    session.origin = draft.origin;
  }
  return session;
}

function normalizeHandoff(value: Record<string, unknown>): Session["handoff"] {
  const handoff: Session["handoff"] = { requested: value.requested === true };
  if (typeof value.handoffId === "string") {
    handoff.handoffId = value.handoffId;
  }
  if (typeof value.reason === "string") {
    handoff.reason = value.reason;
  }
  if (typeof value.message === "string") {
    handoff.message = sanitizeText(value.message);
  }
  if (isContactInfo(value.contact)) {
    handoff.contact = value.contact;
  }
  return handoff;
}

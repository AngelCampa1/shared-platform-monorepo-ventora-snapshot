/**
 * Minimal, dependency-free observability transports for the AI-SDR Worker.
 *
 * Pattern mirrors camaudit-v2/cloudflare/api/src/observability/sentry.ts — a
 * direct Sentry envelope POST (no @sentry/* SDK) and a bare PostHog capture
 * POST — both adapted for the ai-sdr-worker Env shape.
 *
 * Design invariants:
 *  - Env-gated: when SENTRY_DSN / POSTHOG_API_KEY is absent the hook is a
 *    no-op, preserving today's behaviour for tests that don't set these vars.
 *  - Fail-open: every network call is wrapped in try/catch. Telemetry failures
 *    never surface to the caller and never affect the chat/alarm flow.
 *  - PII-free: the transports only emit what the call sites hand in —
 *    productId/productKey/status enums/reason literals/score buckets/counts.
 *    They add no field that could carry message text, email, name, or phone.
 *  - Injectable fetcher: all network I/O goes through a `fetcher` param so
 *    unit tests can pass a vi.fn() and inspect the wire payload without making
 *    real HTTP calls.
 */

/** Minimal fetch signature — avoids DOM/Node lib dependency. */
export type ObservabilityFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>;

/** Subset of Env the observability layer needs. */
export type ObservabilityEnv = {
  SENTRY_DSN?: string;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
};

interface ParsedSentryDsn {
  readonly ingestUrl: string;
  readonly publicKey: string;
}

/**
 * Parse a Sentry DSN (`https://<publicKey>@<host>/<projectId>`) into the
 * envelope ingest URL and public key. Returns null when the DSN is absent or
 * malformed.
 */
export function parseSentryDsn(dsn: string | undefined): ParsedSentryDsn | null {
  if (!dsn) {
    return null;
  }
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!publicKey || !projectId) {
      return null;
    }
    return {
      ingestUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey,
    };
  } catch {
    return null;
  }
}

/**
 * Send a best-effort Sentry envelope event (level: error). No-op when SENTRY_DSN
 * is absent. Never throws.
 *
 * @param env     - Worker env (reads SENTRY_DSN)
 * @param event   - Short machine-readable event name used as the Sentry message
 * @param data    - PII-free key/value pairs placed in Sentry `extra`
 * @param fetcher - Injectable fetch implementation (defaults to globalThis.fetch)
 */
export async function captureSentryEvent(
  env: ObservabilityEnv,
  event: string,
  data: Record<string, unknown>,
  fetcher: ObservabilityFetcher = globalThis.fetch as unknown as ObservabilityFetcher,
): Promise<void> {
  const parsed = parseSentryDsn(env.SENTRY_DSN);
  if (!parsed) {
    return;
  }
  try {
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const nowSeconds = Date.now() / 1000;
    const sentryEvent: Record<string, unknown> = {
      event_id: eventId,
      timestamp: nowSeconds,
      platform: "javascript",
      level: "error",
      server_name: "ventora-ai-sdr-worker",
      message: event,
      tags: { event },
      extra: data,
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date(nowSeconds * 1000).toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(sentryEvent),
    ].join("\n");
    await fetcher(parsed.ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=ventora-ai-sdr-worker/1.0`,
      },
      body: envelope,
    });
  } catch {
    // Fail-open: never surface telemetry failures to the caller.
  }
}

/**
 * Send a best-effort PostHog server event. No-op when POSTHOG_API_KEY is absent.
 * Never throws.
 *
 * @param env        - Worker env (reads POSTHOG_API_KEY, POSTHOG_HOST)
 * @param event      - PostHog event name
 * @param data       - PII-free properties (placed under `properties` in the payload)
 * @param distinctId - Non-PII identifier — caller must derive from productId/sessionId
 * @param fetcher    - Injectable fetch implementation
 */
export async function trackEvent(
  env: ObservabilityEnv,
  event: string,
  data: Record<string, unknown>,
  distinctId: string,
  fetcher: ObservabilityFetcher = globalThis.fetch as unknown as ObservabilityFetcher,
): Promise<void> {
  if (!env.POSTHOG_API_KEY) {
    return;
  }
  try {
    const host = env.POSTHOG_HOST ?? "https://us.i.posthog.com";
    const payload = {
      api_key: env.POSTHOG_API_KEY,
      event,
      timestamp: new Date().toISOString(),
      distinct_id: distinctId,
      properties: {
        ...data,
        distinct_id: distinctId,
      },
    };
    await fetcher(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Fail-open: never surface telemetry failures to the caller.
  }
}

/** Bound observability hooks, threaded through call sites. */
export type Observability = {
  /**
   * Capture an error/fail-open event in Sentry. PII-free — only productId,
   * productKey, status enums, reason literals, score buckets, and counts.
   */
  captureSentry: (event: string, data: Record<string, unknown>) => Promise<void>;
  /**
   * Emit a product analytics event to PostHog. PII-free — same contract as
   * captureSentry regarding allowed data shapes.
   */
  track: (event: string, data: Record<string, unknown>) => Promise<void>;
};

/**
 * Build bound observability hooks from env + an injectable fetcher.
 *
 * Derive the PostHog distinct_id from `productId` (PII-free stable key) so
 * events group by product without ever including visitor identity.
 *
 * When SENTRY_DSN / POSTHOG_API_KEY are absent the returned functions are
 * true no-ops (return immediately without touching the network).
 */
export function makeObservability(
  env: ObservabilityEnv,
  productId: string,
  fetcher: ObservabilityFetcher = globalThis.fetch as unknown as ObservabilityFetcher,
): Observability {
  return {
    captureSentry: (event, data) => captureSentryEvent(env, event, data, fetcher),
    track: (event, data) => trackEvent(env, event, data, `product:${productId}`, fetcher),
  };
}

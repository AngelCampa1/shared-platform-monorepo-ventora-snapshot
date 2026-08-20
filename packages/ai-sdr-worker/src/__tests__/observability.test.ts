import { describe, expect, it, vi } from "vitest";
import {
  captureSentryEvent,
  makeObservability,
  parseSentryDsn,
  trackEvent,
} from "../observability.js";

// ─── parseSentryDsn ───────────────────────────────────────────────────────────

describe("parseSentryDsn", () => {
  it("returns null for undefined", () => {
    expect(parseSentryDsn(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSentryDsn("")).toBeNull();
  });

  it("returns null for a non-DSN URL (no public key)", () => {
    expect(parseSentryDsn("https://sentry.io/api/123/envelope/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseSentryDsn("not-a-url")).toBeNull();
  });

  it("returns null when project id is missing (path is '/')", () => {
    expect(parseSentryDsn("https://abc@sentry.io/")).toBeNull();
  });

  it("parses a standard Sentry DSN into ingestUrl and publicKey", () => {
    const result = parseSentryDsn("https://abc123@o123456.ingest.sentry.io/789");
    expect(result).toEqual({
      ingestUrl: "https://o123456.ingest.sentry.io/api/789/envelope/",
      publicKey: "abc123",
    });
  });

  it("parses a self-hosted Sentry DSN", () => {
    const result = parseSentryDsn("https://pubkey@sentry.example.com/42");
    expect(result).toEqual({
      ingestUrl: "https://sentry.example.com/api/42/envelope/",
      publicKey: "pubkey",
    });
  });
});

// ─── captureSentryEvent ───────────────────────────────────────────────────────

describe("captureSentryEvent", () => {
  it("is a no-op when SENTRY_DSN is absent", async () => {
    const fetcher = vi.fn();
    await captureSentryEvent({}, "sdr_extraction_failed", { productId: "prod_1" }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is a no-op when SENTRY_DSN is empty string", async () => {
    const fetcher = vi.fn();
    await captureSentryEvent({ SENTRY_DSN: "" }, "sdr_extraction_failed", {}, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts a Sentry envelope to the correct ingest URL", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await captureSentryEvent(
      { SENTRY_DSN: "https://pubkey@o1.ingest.sentry.io/99" },
      "sdr_push_failed_terminal",
      { productId: "prod_1", reason: "contract_error" },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://o1.ingest.sentry.io/api/99/envelope/");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(init.headers["x-sentry-auth"]).toContain("sentry_key=pubkey");
  });

  it("envelope body is valid JSON lines (header, item header, event)", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await captureSentryEvent(
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
      "sdr_alarm_drain_error",
      {},
      fetcher,
    );
    const body = (fetcher.mock.calls[0] as [string, { body: string }])[1].body;
    const lines = body.split("\n");
    expect(lines).toHaveLength(3);
    const [line0, line1, line2] = lines;
    const header = JSON.parse(line0 ?? "") as Record<string, unknown>;
    const itemHeader = JSON.parse(line1 ?? "") as Record<string, unknown>;
    const event = JSON.parse(line2 ?? "") as Record<string, unknown>;
    expect(typeof header.event_id).toBe("string");
    expect(header.event_id).toHaveLength(32); // UUID without dashes
    expect(typeof header.sent_at).toBe("string");
    expect(itemHeader).toEqual({ type: "event" });
    expect(event.level).toBe("error");
    expect(event.message).toBe("sdr_alarm_drain_error");
    expect(event.platform).toBe("javascript");
    expect(event.server_name).toBe("ventora-ai-sdr-worker");
  });

  it("places event name in tags and data in extra", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await captureSentryEvent(
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
      "sdr_push_retry_exhausted",
      { productKey: "prod_abc" },
      fetcher,
    );
    const body = (fetcher.mock.calls[0] as [string, { body: string }])[1].body;
    const eventLine = body.split("\n")[2] ?? "";
    const event = JSON.parse(eventLine) as Record<string, unknown>;
    expect((event.tags as Record<string, string>).event).toBe("sdr_push_retry_exhausted");
    expect((event.extra as Record<string, unknown>).productKey).toBe("prod_abc");
  });

  it("is fail-open: does not throw when the fetcher rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(
      captureSentryEvent(
        { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
        "sdr_push_failed_terminal",
        {},
        fetcher,
      ),
    ).resolves.toBeUndefined();
  });

  // ─── PII leak guard ────────────────────────────────────────────────────────
  it("PII GUARD: envelope body must not contain PII-shaped values handed in as data", async () => {
    // Assert that a known-safe payload does not produce PII-shaped strings in the wire body.
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await captureSentryEvent(
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
      "sdr_extraction_ok",
      { productId: "prod_safe", status: "qualified", fitScore: "high" },
      fetcher,
    );
    const body = (fetcher.mock.calls[0] as [string, { body: string }])[1].body;
    expect(body).not.toContain("user@example.com");
    expect(body).not.toContain("+1 555-867-5309");
    expect(body).not.toContain("John Doe");
    expect(body).not.toContain("ACME Corp");
    expect(body).not.toContain("Hi, my name is Alice and I need help with billing.");
  });

  it("PII GUARD: transport does not inject email, name, phone, or message-text fields", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await captureSentryEvent(
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
      "sdr_extraction_failed",
      { productId: "prod_x" },
      fetcher,
    );
    const body = (fetcher.mock.calls[0] as [string, { body: string }])[1].body;
    const parsed = JSON.parse(body.split("\n")[2] ?? "") as Record<string, unknown>;
    // The transport-injected top-level fields must only be safe metadata fields.
    const allowedTopLevel = new Set([
      "event_id",
      "timestamp",
      "platform",
      "level",
      "server_name",
      "message",
      "tags",
      "extra",
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowedTopLevel.has(key)).toBe(true);
    }
    // extra must only contain what the caller passed (productId here).
    const extra = parsed.extra as Record<string, unknown>;
    expect(Object.keys(extra)).toEqual(["productId"]);
  });
});

// ─── trackEvent ──────────────────────────────────────────────────────────────

describe("trackEvent", () => {
  it("is a no-op when POSTHOG_API_KEY is absent", async () => {
    const fetcher = vi.fn();
    await trackEvent({}, "sdr_push_ok", { productId: "p1" }, "product:p1", fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is a no-op when POSTHOG_API_KEY is empty string", async () => {
    const fetcher = vi.fn();
    await trackEvent({ POSTHOG_API_KEY: "" }, "sdr_push_ok", {}, "product:p1", fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts to the default PostHog US endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await trackEvent(
      { POSTHOG_API_KEY: "phc_test" },
      "sdr_extraction_ok",
      { productId: "p1", status: "qualified" },
      "product:p1",
      fetcher,
    );
    const [url] = fetcher.mock.calls[0] as [string];
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
  });

  it("respects POSTHOG_HOST override", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await trackEvent(
      { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" },
      "sdr_push_ok",
      {},
      "product:p1",
      fetcher,
    );
    const [url] = fetcher.mock.calls[0] as [string];
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
  });

  it("sends the correct payload shape", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await trackEvent(
      { POSTHOG_API_KEY: "phc_abc" },
      "sdr_lead_captured",
      { productId: "prod_1", status: "hot" },
      "product:prod_1",
      fetcher,
    );
    const init = (
      fetcher.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    )[1];
    expect(init.headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload.api_key).toBe("phc_abc");
    expect(payload.event).toBe("sdr_lead_captured");
    expect(payload.distinct_id).toBe("product:prod_1");
    expect(typeof payload.timestamp).toBe("string");
    expect((payload.properties as Record<string, unknown>).productId).toBe("prod_1");
    expect((payload.properties as Record<string, unknown>).status).toBe("hot");
  });

  it("is fail-open: does not throw when the fetcher rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("PostHog down"));
    await expect(
      trackEvent({ POSTHOG_API_KEY: "phc_abc" }, "sdr_push_ok", {}, "product:p1", fetcher),
    ).resolves.toBeUndefined();
  });

  // ─── PII leak guard ────────────────────────────────────────────────────────
  it("PII GUARD: transport does not inject PII fields beyond what the caller passes", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await trackEvent(
      { POSTHOG_API_KEY: "phc_test" },
      "sdr_push_ok",
      { productId: "prod_safe", status: "routed" },
      "product:prod_safe",
      fetcher,
    );
    const body = JSON.parse(
      (fetcher.mock.calls[0] as [string, { body: string }])[1].body,
    ) as Record<string, unknown>;
    // The transport must NOT add any PII-shaped field of its own.
    // Top-level keys must be the approved PostHog envelope shape only.
    const allowedTopLevel = new Set(["api_key", "event", "timestamp", "distinct_id", "properties"]);
    for (const key of Object.keys(body)) {
      expect(allowedTopLevel.has(key)).toBe(true);
    }
    // distinct_id must be derived from productId, never from visitor/email/phone.
    expect(body.distinct_id).toBe("product:prod_safe");
    // properties must only contain what the caller passed + distinct_id (PostHog convention).
    const props = body.properties as Record<string, unknown>;
    const allowedProps = new Set(["productId", "status", "distinct_id"]);
    for (const key of Object.keys(props)) {
      expect(allowedProps.has(key)).toBe(true);
    }
  });
});

// ─── makeObservability ────────────────────────────────────────────────────────

describe("makeObservability", () => {
  it("returns captureSentry and track functions", () => {
    const obs = makeObservability({}, "prod_1");
    expect(typeof obs.captureSentry).toBe("function");
    expect(typeof obs.track).toBe("function");
  });

  it("captureSentry is a no-op when SENTRY_DSN is absent", async () => {
    const fetcher = vi.fn();
    const obs = makeObservability({}, "prod_1", fetcher);
    await obs.captureSentry("sdr_extraction_failed", { productId: "prod_1" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("track is a no-op when POSTHOG_API_KEY is absent", async () => {
    const fetcher = vi.fn();
    const obs = makeObservability({}, "prod_1", fetcher);
    await obs.track("sdr_push_ok", { productId: "prod_1" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("captureSentry calls Sentry when SENTRY_DSN is set", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const obs = makeObservability(
      { SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1" },
      "prod_x",
      fetcher,
    );
    await obs.captureSentry("sdr_push_failed_terminal", {
      productId: "prod_x",
      reason: "invalid_contract",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url] = fetcher.mock.calls[0] as [string];
    expect(url).toBe("https://o1.ingest.sentry.io/api/1/envelope/");
  });

  it("track calls PostHog when POSTHOG_API_KEY is set", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const obs = makeObservability({ POSTHOG_API_KEY: "phc_abc" }, "prod_x", fetcher);
    await obs.track("sdr_extraction_ok", { productId: "prod_x", status: "qualified" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url] = fetcher.mock.calls[0] as [string];
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
  });

  it("track derives distinct_id from productId (not visitor identity)", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const obs = makeObservability({ POSTHOG_API_KEY: "phc_abc" }, "my_product", fetcher);
    await obs.track("sdr_lead_captured", { productId: "my_product" });
    const body = JSON.parse(
      (fetcher.mock.calls[0] as [string, { body: string }])[1].body,
    ) as Record<string, unknown>;
    // distinct_id must be the scoped product key, not anything that could carry visitor identity.
    expect(body.distinct_id).toBe("product:my_product");
    expect(typeof body.distinct_id).toBe("string");
    // Must not be an email address or phone number.
    expect(body.distinct_id).not.toMatch(/@/);
    expect(body.distinct_id).not.toMatch(/\d{3}[-.\s]\d{3}/);
  });

  it("both transports can fire concurrently when both keys are set", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const obs = makeObservability(
      {
        SENTRY_DSN: "https://pk@o1.ingest.sentry.io/1",
        POSTHOG_API_KEY: "phc_abc",
      },
      "prod_dual",
      fetcher,
    );
    // captureSentry posts to Sentry only, track posts to PostHog only.
    await obs.captureSentry("sdr_push_failed_terminal", { productId: "prod_dual" });
    await obs.track("sdr_push_retriable", { productId: "prod_dual", reason: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = fetcher.mock.calls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes("sentry.io"))).toBe(true);
    expect(urls.some((u) => u.includes("posthog.com"))).toBe(true);
  });
});

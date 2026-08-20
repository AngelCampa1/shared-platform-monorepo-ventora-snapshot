import { describe, expect, expectTypeOf, it, vi } from "vitest";

describe("@ventora/observability", () => {
  it("exports AppError with correct status", async () => {
    const { NotFoundError, buildInternalErrorBody } = await import("@ventora/observability");
    const e = new NotFoundError("test");
    expect(e.status).toBe(404);
    expect(buildInternalErrorBody("abc")).toEqual({
      error: "Something went wrong. Please try again.",
      trackingId: "abc",
    });
  });
});

describe("@ventora/analytics", () => {
  it("exports APPROVED_EVENTS with known events", async () => {
    const { APPROVED_EVENTS } = await import("@ventora/analytics");
    expect(APPROVED_EVENTS.user_signed_up).toBe("user_signed_up");
  });

  it("resolves all public subpath exports", async () => {
    const browser = await import("@ventora/analytics/browser");
    const server = await import("@ventora/analytics/server");
    const events = await import("@ventora/analytics/events");

    expect(typeof browser.initAnalytics).toBe("function");
    expect(typeof server.captureServerEvent).toBe("function");
    expect(events.APPROVED_EVENTS.user_signed_up).toBe("user_signed_up");
  });
});

describe("@ventora/seo", () => {
  it("buildWebSiteJsonLd returns correct @type", async () => {
    const { buildWebSiteJsonLd } = await import("@ventora/seo");
    const cfg = {
      name: "Test",
      domain: "test.com",
      metaDescription: "test",
      defaultOgImagePath: "/og.png",
      organization: { legalName: "Test Inc", sameAs: [] },
    };
    const ld = buildWebSiteJsonLd(cfg);
    expect(ld["@type"]).toBe("WebSite");
  });

  it("resolves all public subpath exports", async () => {
    const schema = await import("@ventora/seo/schema");
    const metadata = await import("@ventora/seo/metadata");
    const sitemap = await import("@ventora/seo/sitemap");
    const feed = await import("@ventora/seo/feed");
    const indexnow = await import("@ventora/seo/indexnow");

    expect(typeof schema.serializeJsonLd).toBe("function");
    expect(typeof metadata.buildCanonicalUrl).toBe("function");
    expect(typeof sitemap.buildSitemapXml).toBe("function");
    expect(typeof feed.buildJsonFeed).toBe("function");
    expect(typeof indexnow.submitToIndexNow).toBe("function");
  });
});

describe("@ventora/email-templates", () => {
  it("exports render", async () => {
    const { render } = await import("@ventora/email-templates");
    expect(typeof render).toBe("function");
  });

  it("renders a published template in the consumer app", async () => {
    const { render } = await import("@ventora/email-templates");
    const result = await render("password-reset", {
      resetUrl: "https://example.test/reset",
    });

    expect(result.html).toContain("https://example.test/reset");
    expect(result.text).toContain("https://example.test/reset");
    expect(result.text).not.toMatch(/<[a-z][\s\S]*>/i);
  });
});

describe("@ventora/email", () => {
  it("generateUnsubscribeToken produces a token", async () => {
    const { generateUnsubscribeToken, verifyUnsubscribeToken } = await import("@ventora/email");
    const token = await generateUnsubscribeToken(
      "user-1",
      "marketing",
      "secret-key-32-chars-padded----",
    );
    expect(token).toContain(".");
    const result = await verifyUnsubscribeToken(token, "secret-key-32-chars-padded----");
    expect(result?.userId).toBe("user-1");
  });
});

describe("@ventora/storage", () => {
  it("sanitizeFilename cleans unsafe chars", async () => {
    const { sanitizeFilename } = await import("@ventora/storage");
    expect(sanitizeFilename("hello world.pdf")).toBe("hello_world.pdf");
  });
});

describe("@ventora/api-client", () => {
  it("ApiError has correct shape", async () => {
    const { ApiError, isApiError } = await import("@ventora/api-client");
    const err = new ApiError({ status: 404 });
    expect(isApiError(err)).toBe(true);
    expect(err.status).toBe(404);
  });

  it("resolves query-client subpath export", async () => {
    const { createQueryClient } = await import("@ventora/api-client/query-client");
    expect(typeof createQueryClient).toBe("function");
  });
});

describe("@ventora/billing", () => {
  it("normalizeBillingStatus maps stripe statuses", async () => {
    const { normalizeBillingStatus } = await import("@ventora/billing");
    expect(normalizeBillingStatus("active")).toBe("active");
    expect(normalizeBillingStatus("cancelled")).toBe("canceled");
    expect(normalizeBillingStatus("unknown")).toBe("inactive");
  });
});

describe("@ventora/auth-better", () => {
  it("encryptedTokenPlugin returns correct _type", async () => {
    const { encryptedTokenPlugin } = await import("@ventora/auth-better/advanced");
    const plugin = encryptedTokenPlugin({ kmsKeyId: "arn:test", region: "us-east-1" });
    expect(plugin._type).toBe("encrypted-token");
  });

  it("resolves all public subpath exports", async () => {
    const factory = await import("@ventora/auth-better/factory");
    const helpers = await import("@ventora/auth-better/helpers");
    const advanced = await import("@ventora/auth-better/advanced");

    expect(typeof factory.createAuth).toBe("function");
    expect(typeof helpers.requireSession).toBe("function");
    expect(typeof advanced.resolvePlugins).toBe("function");
  });
});

describe("@ventora/ai-sdr", () => {
  it("exports browser helpers and shared contracts", async () => {
    const client = await import("@ventora/ai-sdr");

    expect(typeof client.createAiSdrSession).toBe("function");
    expect(typeof client.sendAiSdrChatMessage).toBe("function");
    expect(typeof client.createAiSdrWidget).toBe("function");
    expectTypeOf<ReturnType<typeof client.createAiSdrWidget>>().toMatchTypeOf<{
      startNewChat(): Promise<void>;
    }>();
    expect(client.isAiSdrSseEvent({ event: "message.done", data: { messageId: "msg_1" } })).toBe(
      true,
    );
  });

  it("exports contract HMAC helpers directly", async () => {
    const contracts = await import("@ventora/ai-sdr-contracts");
    const payload = contracts.buildHmacPayload({
      timestamp: "2026-05-13T00:00:00.000Z",
      nonce: "nonce",
      method: "POST",
      path: "/v1/chat",
      body: { sessionId: "sess_1", message: "hello" },
    });

    expect(payload).toMatch(/^2026-05-13T00:00:00\.000Z\.nonce\.POST\.\/v1\/chat\.[a-f0-9]{64}$/);
  });
});

describe("@ventora/ai-assistant-contracts", () => {
  it("exports shared assistant protocol helpers", async () => {
    const contracts = await import("@ventora/ai-assistant-contracts");

    expect(contracts.stableJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
    expect(
      contracts.isAiAssistantSseEvent({ event: "message.done", data: { messageId: "msg_1" } }),
    ).toBe(true);
  });
});

describe("@ventora/ai-cs-contracts", () => {
  it("exports authenticated app support contracts", async () => {
    const contracts = await import("@ventora/ai-cs-contracts");

    expect(
      contracts.isAiCsSseEvent({
        event: "navigation.suggestion",
        data: { target: { label: "Billing", path: "/settings/billing" } },
      }),
    ).toBe(true);
    expect(contracts.parseAiCsSseEventName("trial.cta")).toBeNull();
  });
});

describe("@ventora/ai-cs", () => {
  it("exports browser helpers and AI-CS contracts", async () => {
    const client = await import("@ventora/ai-cs");

    expect(typeof client.createAiCsSession).toBe("function");
    expect(typeof client.createAiCsSessionManager).toBe("function");
    expectTypeOf<ReturnType<typeof client.createAiCsSessionManager>>().toMatchTypeOf<{
      getOrCreateSession(): Promise<{ sessionId: string }>;
      startNewChat(): Promise<{ sessionId: string }>;
    }>();
    expect(typeof client.sendAiCsChatMessage).toBe("function");
    expect(typeof client.requestAiCsSupportEscalation).toBe("function");
    expect(
      client.isAiCsSseEvent({
        event: "workflow.step",
        data: { step: { id: "setup", label: "Finish setup", status: "next" } },
      }),
    ).toBe(true);
  });

  it("sends authenticated AI-CS session requests", async () => {
    const client = await import("@ventora/ai-cs");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "sess_1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      client.createAiCsSession(
        {
          baseUrl: "https://support.example",
          fetch: fetchFn,
          credentials: "include",
          headers: { "X-App": "lextract" },
        },
        { appId: "lextract", userId: "user_1" },
      ),
    ).resolves.toEqual({ sessionId: "sess_1" });

    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("X-App")).toBe("lextract");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("streams AI-CS chat events through the published package", async () => {
    const client = await import("@ventora/ai-cs");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('event: message.done\ndata: {"messageId":"msg_1"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    await expect(
      client.sendAiCsChatMessage(
        { baseUrl: "https://support.example", fetch: fetchFn },
        { sessionId: "sess_1", message: "done", appId: "lextract", userId: "user_1" },
      ),
    ).resolves.toEqual([{ event: "message.done", data: { messageId: "msg_1" } }]);
  });

  it("exposes the React widget subpath", async () => {
    const react = await import("@ventora/ai-cs/react");
    expect(typeof react.AiCsWidget).toBe("function");
    expect(typeof react.useAiCsWidget).toBe("function");
    expect(typeof react.ensureAiCsStyles).toBe("function");
    expect(typeof react.resolveAiCsBrand).toBe("function");
  });
});

describe("@ventora/observability/redact-hipaa", () => {
  it("exports HIPAA redaction rules that redact identifiers", async () => {
    const { redact } = await import("@ventora/observability");
    const { HIPAA_RULES } = await import("@ventora/observability/redact-hipaa");
    expect(HIPAA_RULES.patterns.length).toBeGreaterThan(0);
    expect(redact("MRN: ABCD-1234 NPI: 1234567890", HIPAA_RULES)).toBe("[mrn] [npi]");
  });
});

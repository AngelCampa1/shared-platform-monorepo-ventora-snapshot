import {
  type CrmLeadIngestRequest,
  type CrmLeadIngestResponse,
  type StableJsonValue,
  buildHmacPayload,
  stableJson,
  verifyHmacSignature,
} from "@ventora/ai-sdr-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PushResult, pushLeadToCrm } from "../crm-push.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-crm-secret-abc123";
const BASE_ENDPOINT = "https://crm.example.com/s/ingest/leads";
const FIXED_TIMESTAMP = "2026-06-20T12:00:00.000Z";
const FIXED_NONCE = "deadbeefcafe1234deadbeefcafe5678";

const FIXED_NOW = new Date(FIXED_TIMESTAMP);
const nowFactory = () => FIXED_NOW;
const idFactory = () => FIXED_NONCE;

const sampleRequest: CrmLeadIngestRequest = {
  productKey: "grantpipe",
  sdrSessionId: "sess_abc123",
  profile: {
    contact: {
      // NOTE: real contact info only in the fixture — never in reason/log assertions
      name: "Jane Doe",
      email: "jane@example.com",
      company: "Acme Corp",
    },
    qualification: {
      needPain: "Manual grant tracking",
      useCase: "Automate applications",
    },
    derived: {
      emailDomain: "example.com",
      pageUrl: "https://example.com/pricing",
    },
  },
  activities: [
    { type: "session_started", payload: { page: "pricing" } },
    { type: "handoff_requested" },
  ],
  occurredAt: FIXED_TIMESTAMP,
};

const validCrmResponse: CrmLeadIngestResponse = {
  customerId: "cust_xyz",
  leadId: "lead_abc",
  status: "new",
};

// ---------------------------------------------------------------------------
// Helper: build the expected signed path
// ---------------------------------------------------------------------------
function expectedPath(): string {
  const url = new URL(`${BASE_ENDPOINT}/${encodeURIComponent(sampleRequest.productKey)}`);
  return url.pathname;
}

// ---------------------------------------------------------------------------
// Mock fetcher factory
// ---------------------------------------------------------------------------
function makeFetcher(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ---------------------------------------------------------------------------
// Console spy
// ---------------------------------------------------------------------------
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PII sentinel check helper
// ---------------------------------------------------------------------------
const PII_PATTERNS = [
  "jane",
  "jane@example.com",
  "acme",
  "acme corp",
  "manual grant",
  "automate applications",
  "sess_abc123",
];

function assertNoPiiInLogs(): void {
  const allCalls = [
    ...consoleLogSpy.mock.calls,
    ...consoleWarnSpy.mock.calls,
    ...consoleErrorSpy.mock.calls,
  ]
    .flat()
    .map((arg) =>
      typeof arg === "string" ? arg.toLowerCase() : JSON.stringify(arg).toLowerCase(),
    );

  for (const pattern of PII_PATTERNS) {
    for (const call of allCalls) {
      expect(call).not.toContain(pattern.toLowerCase());
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pushLeadToCrm", () => {
  describe("not_configured: missing endpoint or secret", () => {
    it("returns not_configured when endpoint is missing", async () => {
      const result = await pushLeadToCrm({
        config: { secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: vi.fn(),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "not_configured",
      });
      assertNoPiiInLogs();
    });

    it("returns not_configured when endpoint is empty string", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: "   ", secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: vi.fn(),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "not_configured",
      });
      assertNoPiiInLogs();
    });

    it("returns not_configured when secret is missing", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT },
        request: sampleRequest,
        fetcher: vi.fn(),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "not_configured",
      });
      assertNoPiiInLogs();
    });

    it("returns not_configured when secret is empty string", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: "" },
        request: sampleRequest,
        fetcher: vi.fn(),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "not_configured",
      });
      assertNoPiiInLogs();
    });

    it("does not call fetcher when not configured", async () => {
      const fetcher = vi.fn();
      await pushLeadToCrm({
        config: {},
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe("signing correctness", () => {
    it("sends all three signing headers", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(fetcher).toHaveBeenCalledOnce();
      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      // Cast headers to a known shape for inspection
      const headers = init?.headers as Record<string, string | undefined>;

      expect(headers["X-Ventora-Timestamp"]).toBe(FIXED_TIMESTAMP);
      expect(headers["X-Ventora-Nonce"]).toBe(FIXED_NONCE);
      expect(typeof headers["X-Ventora-Signature"]).toBe("string");
      // Signature must be 64 hex chars (SHA-256 HMAC → 32 bytes → 64 hex)
      expect(headers["X-Ventora-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    });

    it("posts to the correct URL with productKey in path", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_ENDPOINT}/grantpipe`);
    });

    it("signature verifies correctly against verifyHmacSignature with same secret", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string | undefined>;
      const signature = headers["X-Ventora-Signature"] ?? "";

      // M3: Assert wire body equals the signed bytes — the CRM receives bytes
      // that byte-match the hash digest (stableJson of the same frozen object).
      const expectedBody = stableJson(sampleRequest as unknown as StableJsonValue);
      expect(init?.body).toBe(expectedBody);

      // Reconstruct the same payload the client built internally
      const path = expectedPath();
      const body = sampleRequest as unknown as StableJsonValue;

      const payload = buildHmacPayload({
        timestamp: FIXED_TIMESTAMP,
        nonce: FIXED_NONCE,
        method: "POST",
        path,
        body,
      });

      // Pass nowMs matching the fixed timestamp so freshness check passes
      const result = verifyHmacSignature({
        payload,
        signature,
        secret: TEST_SECRET,
        timestamp: FIXED_TIMESTAMP,
        nowMs: FIXED_NOW.getTime(),
      });

      expect(result.ok).toBe(true);
      assertNoPiiInLogs();
    });

    it("signs the pathname only (no query string)", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string | undefined>;
      const signature = headers["X-Ventora-Signature"] ?? "";

      // Verify with path containing "?" should fail — proves no query string signed
      const payloadWithQuery = buildHmacPayload({
        timestamp: FIXED_TIMESTAMP,
        nonce: FIXED_NONCE,
        method: "POST",
        path: `${expectedPath()}?foo=bar`,
        body: sampleRequest as unknown as StableJsonValue,
      });

      const badResult = verifyHmacSignature({
        payload: payloadWithQuery,
        signature,
        secret: TEST_SECRET,
        timestamp: FIXED_TIMESTAMP,
        nowMs: FIXED_NOW.getTime(),
      });

      expect(badResult.ok).toBe(false);
    });

    it("uses method POST in signing (GET signed path would fail verification)", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string | undefined>;
      const signature = headers["X-Ventora-Signature"] ?? "";

      // Try to verify with GET — should fail
      const payloadGet = buildHmacPayload({
        timestamp: FIXED_TIMESTAMP,
        nonce: FIXED_NONCE,
        method: "GET",
        path: expectedPath(),
        body: sampleRequest as unknown as StableJsonValue,
      });

      const badResult = verifyHmacSignature({
        payload: payloadGet,
        signature,
        secret: TEST_SECRET,
        timestamp: FIXED_TIMESTAMP,
        nowMs: FIXED_NOW.getTime(),
      });

      expect(badResult.ok).toBe(false);
    });
  });

  describe("success path", () => {
    it("returns ok:true with parsed CrmLeadIngestResponse on 200 + valid body", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: true, response: validCrmResponse });
      assertNoPiiInLogs();
    });

    it("sends Content-Type: application/json", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("sends method POST", async () => {
      const fetcher = makeFetcher(200, validCrmResponse);

      await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(init?.method).toBe("POST");
    });
  });

  describe("invalid response body", () => {
    it("returns non-retriable invalid_response on 200 with wrong body shape", async () => {
      const fetcher = makeFetcher(200, { wrong: "shape" });

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "invalid_response",
      });
      assertNoPiiInLogs();
    });

    it("returns non-retriable invalid_response on 200 with empty body", async () => {
      const fetcher = makeFetcher(200, null);

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: false,
        reason: "invalid_response",
      });
      assertNoPiiInLogs();
    });
  });

  describe("HTTP error codes", () => {
    it("returns retriable on 500", async () => {
      const fetcher = makeFetcher(500, { error: "internal" });

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({
        ok: false,
        retriable: true,
        reason: "http_5xx",
      });
      assertNoPiiInLogs();
    });

    it("returns retriable on 503", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(503, {}),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: true, reason: "http_5xx" });
    });

    it("returns retriable on 429", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(429, {}),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: true, reason: "http_429" });
      assertNoPiiInLogs();
    });

    it("returns non-retriable on 400", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(400, { error: "bad_request" }),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: false, reason: "http_4xx" });
      assertNoPiiInLogs();
    });

    it("returns non-retriable on 401", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(401, { error: "unauthorized" }),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: false, reason: "http_4xx" });
    });

    it("returns non-retriable on 404", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(404, {}),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: false, reason: "http_4xx" });
    });

    it("returns non-retriable on 409", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(409, {}),
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: false, reason: "http_4xx" });
    });
  });

  describe("network errors", () => {
    it("returns retriable on network throw (TypeError)", async () => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: true, reason: "network_error" });
      assertNoPiiInLogs();
    });

    it("returns retriable on AbortSignal timeout (DOMException TimeoutError)", async () => {
      const fetcher = vi
        .fn()
        .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
        timeoutMs: 1,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: true, reason: "timeout" });
      assertNoPiiInLogs();
    });

    it("returns retriable on generic Error throw from fetcher", async () => {
      const fetcher = vi.fn().mockRejectedValue(new Error("connection refused"));

      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher,
        nowFactory,
        idFactory,
      });

      expect(result).toEqual<PushResult>({ ok: false, retriable: true, reason: "network_error" });
    });
  });

  describe("privacy: no PII in reason strings", () => {
    const piiStrings = [
      "jane",
      "jane@example.com",
      "acme",
      "example.com",
      "manual grant",
      "sess_abc123",
    ];

    it("reason string on 500 contains no PII", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: makeFetcher(500, {}),
        nowFactory,
        idFactory,
      });

      if (!result.ok) {
        for (const pii of piiStrings) {
          expect(result.reason.toLowerCase()).not.toContain(pii.toLowerCase());
        }
      }
    });

    it("reason string on network error contains no PII", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: sampleRequest,
        fetcher: vi.fn().mockRejectedValue(new Error("connection reset by jane@example.com")),
        nowFactory,
        idFactory,
      });

      if (!result.ok) {
        for (const pii of piiStrings) {
          expect(result.reason.toLowerCase()).not.toContain(pii.toLowerCase());
        }
      }
      assertNoPiiInLogs();
    });

    it("reason string on invalid response contains no PII", async () => {
      const result = await pushLeadToCrm({
        config: { endpoint: BASE_ENDPOINT, secret: TEST_SECRET },
        request: { ...sampleRequest, profile: { ...sampleRequest.profile } },
        fetcher: makeFetcher(200, { bad: "body" }),
        nowFactory,
        idFactory,
      });

      if (!result.ok) {
        for (const pii of piiStrings) {
          expect(result.reason.toLowerCase()).not.toContain(pii.toLowerCase());
        }
      }
      assertNoPiiInLogs();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateHmac } from "../hmac.js";

// Mock @ventora/email-templates before importing the worker
vi.mock("@ventora/email-templates", () => ({
  render: vi.fn(),
}));

import * as emailTemplates from "@ventora/email-templates";
// Import worker after mock is set up
import worker from "../index.js";

const mockRender = vi.mocked(emailTemplates.render);

const HMAC_SECRET = "test-renderer-secret";

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `https://renderer.example.com${path}`;
  if (body !== undefined) {
    return new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

async function makeSignedRequest(
  template: string,
  vars: Record<string, unknown>,
  secret: string,
  options: {
    tamperHmac?: boolean;
    timestamp?: string;
    nonce?: string;
    hmacTransform?: (hmac: string) => string;
  } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const nonce = options.nonce ?? "render-nonce-1";
  const payload = JSON.stringify({
    timestamp,
    nonce,
    method: "POST",
    path: "/render",
    body: { template, vars },
  });
  let hmac = await generateHmac(payload, secret);
  if (options.tamperHmac) {
    hmac = `${hmac.slice(0, -4)}0000`;
  }
  if (options.hmacTransform !== undefined) {
    hmac = options.hmacTransform(hmac);
  }
  return makeRequest("POST", "/render", { template, vars, timestamp, nonce, hmac });
}

describe("Worker fetch handler", () => {
  beforeEach(() => {
    mockRender.mockReset();
  });

  it("GET /render returns 405 Method Not Allowed", async () => {
    const req = makeRequest("GET", "/render");
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(405);
  });

  it("POST /other-path returns 404 Not Found", async () => {
    const req = makeRequest("POST", "/other-path", {});
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(404);
  });

  it("POST /render with invalid JSON body returns 400", async () => {
    const req = new Request("https://renderer.example.com/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json{{{",
    });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid JSON");
  });

  it("POST /render rejects malformed JSON shape before HMAC verification", async () => {
    const req = makeRequest("POST", "/render", {});
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid render request" });
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("POST /render rejects non-object JSON bodies", async () => {
    const req = makeRequest("POST", "/render", []);
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid render request" });
  });

  it("POST /render without HMAC_SECRET set fails closed in production-like mode", async () => {
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: { firstName: "Prod" },
      hmac: "",
    });
    const res = await worker.fetch(req, { ENVIRONMENT: "production" });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Renderer HMAC secret is not configured");
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("POST /render without HMAC_SECRET set renders only in explicit development mode", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi</p>", text: "Hi" });
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: { firstName: "Dev" },
      hmac: "",
    });
    const res = await worker.fetch(req, { ENVIRONMENT: "development" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: string; text: string };
    expect(json.html).toBe("<p>Hi</p>");
    expect(json.text).toBe("Hi");
  });

  it("POST /render without HMAC_SECRET set renders in explicit test mode", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi test</p>", text: "Hi test" });
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: { firstName: "Test" },
      hmac: "",
    });
    const res = await worker.fetch(req, { ENVIRONMENT: "test" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: string; text: string };
    expect(json.html).toBe("<p>Hi test</p>");
    expect(json.text).toBe("Hi test");
  });

  it("POST /render without HMAC field renders in explicit test mode", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi test</p>", text: "Hi test" });
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: { firstName: "Test" },
    });

    const res = await worker.fetch(req, { ENVIRONMENT: "test" });

    expect(res.status).toBe(200);
    expect(mockRender).toHaveBeenCalledWith("welcome", { firstName: "Test" });
  });

  it.each([
    ["ENVIRONMENT", { ENVIRONMENT: "local" }],
    ["NODE_ENV", { NODE_ENV: "local" }],
  ])(
    "POST /render without HMAC_SECRET set renders unsigned when %s is local",
    async (_envName, env) => {
      mockRender.mockResolvedValue({ html: "<p>Hi local</p>", text: "Hi local" });
      const req = makeRequest("POST", "/render", {
        template: "welcome",
        vars: { firstName: "Local" },
        hmac: "",
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { html: string; text: string };
      expect(json.html).toBe("<p>Hi local</p>");
      expect(json.text).toBe("Hi local");
    },
  );

  it("POST /render with valid HMAC returns 200 with html+text", async () => {
    mockRender.mockResolvedValue({ html: "<h1>Welcome</h1>", text: "Welcome" });
    const req = await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET);
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: string; text: string };
    expect(json.html).toBe("<h1>Welcome</h1>");
    expect(json.text).toBe("Welcome");
  });

  it("POST /render with invalid HMAC returns 401 Unauthorized", async () => {
    const req = await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
      tamperHmac: true,
    });
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  it("POST /render rejects stale signed requests", async () => {
    mockRender.mockResolvedValue({ html: "<p>Expired</p>", text: "Expired" });
    const req = await makeSignedRequest("welcome", { firstName: "Old" }, HMAC_SECRET, {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      nonce: "stale-nonce",
    });

    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("POST /render rejects signed requests with invalid timestamps", async () => {
    const req = await makeSignedRequest("welcome", { firstName: "Old" }, HMAC_SECRET, {
      timestamp: "not-a-date",
      nonce: "invalid-timestamp-nonce",
    });

    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("POST /render rejects replayed signed requests", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi</p>", text: "Hi" });
    const timestamp = new Date().toISOString();
    const nonce = "single-use-render-nonce";

    const first = await worker.fetch(
      await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
        timestamp,
        nonce,
      }),
      { RENDERER_HMAC_SECRET: HMAC_SECRET },
    );
    const replay = await worker.fetch(
      await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
        timestamp,
        nonce,
      }),
      { RENDERER_HMAC_SECRET: HMAC_SECRET },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("POST /render rejects replayed signed requests with different HMAC hex casing", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi</p>", text: "Hi" });
    const timestamp = new Date().toISOString();
    const nonce = "case-replay-render-nonce";

    const first = await worker.fetch(
      await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
        timestamp,
        nonce,
      }),
      { RENDERER_HMAC_SECRET: HMAC_SECRET },
    );
    const replay = await worker.fetch(
      await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
        timestamp,
        nonce,
        hmacTransform: (hmac) => hmac.toUpperCase(),
      }),
      { RENDERER_HMAC_SECRET: HMAC_SECRET },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("POST /render prunes expired replay entries before accepting a fresh request", async () => {
    vi.useFakeTimers();
    try {
      mockRender.mockResolvedValue({ html: "<p>Hi</p>", text: "Hi" });
      const firstNow = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(firstNow);
      const first = await worker.fetch(
        await makeSignedRequest("welcome", { firstName: "Alice" }, HMAC_SECRET, {
          timestamp: firstNow.toISOString(),
          nonce: "expiring-render-nonce",
        }),
        { RENDERER_HMAC_SECRET: HMAC_SECRET },
      );
      expect(first.status).toBe(200);

      const later = new Date(firstNow.getTime() + 6 * 60 * 1000);
      vi.setSystemTime(later);
      const second = await worker.fetch(
        await makeSignedRequest("welcome", { firstName: "Bob" }, HMAC_SECRET, {
          timestamp: later.toISOString(),
          nonce: "fresh-render-nonce",
        }),
        { RENDERER_HMAC_SECRET: HMAC_SECRET },
      );
      expect(second.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("POST /render with unknown template returns 422", async () => {
    mockRender.mockRejectedValue(new Error("Unknown template: nonexistent"));
    const req = await makeSignedRequest("nonexistent", {}, HMAC_SECRET);
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unknown template: nonexistent");
  });

  it("POST /render returns 422 for missing required template vars", async () => {
    mockRender.mockRejectedValue(
      new Error('Template "password-reset" requires string var "resetUrl"'),
    );

    const req = await makeSignedRequest("password-reset", {}, HMAC_SECRET);
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: 'Template "password-reset" requires string var "resetUrl"',
    });
  });

  it("POST /render with render throwing non-Error returns 422 with Unknown error", async () => {
    mockRender.mockRejectedValue("some string error");
    const req = await makeSignedRequest("welcome", {}, HMAC_SECRET);
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unknown error");
  });

  it("renders with correct template name and vars passed to render()", async () => {
    mockRender.mockResolvedValue({ html: "<p>Receipt</p>", text: "Receipt" });
    const vars = { amount: "99.00", currency: "USD", planName: "Pro", date: "2026-05-01" };
    const req = await makeSignedRequest("payment-receipt", vars, HMAC_SECRET);
    await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(mockRender).toHaveBeenCalledWith("payment-receipt", vars);
  });

  it("returns Content-Type application/json on success", async () => {
    mockRender.mockResolvedValue({ html: "<p>Hi</p>", text: "Hi" });
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: {},
      hmac: "",
    });
    const res = await worker.fetch(req, { ENVIRONMENT: "test" });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns Content-Type application/json on 401", async () => {
    const req = makeRequest("POST", "/render", {
      template: "welcome",
      vars: {},
      hmac: "badhmacsignature",
    });
    const res = await worker.fetch(req, { RENDERER_HMAC_SECRET: HMAC_SECRET });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

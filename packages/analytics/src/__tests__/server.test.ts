import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedEvent } from "../_generated-events.js";
import { captureServerEvent, sanitizeProperties } from "../server.js";

describe("captureServerEvent", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("no-ops when POSTHOG_KEY is absent", async () => {
    await captureServerEvent("user_signed_up", {
      distinctId: "user-1",
      env: {},
      fetch: mockFetch,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("no-ops for unapproved event names (runtime guard)", async () => {
    await captureServerEvent("not_an_event" as ApprovedEvent, {
      distinctId: "user-1",
      env: { POSTHOG_KEY: "phc_test_key" },
      fetch: mockFetch,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls fetch with correct payload when key is present", async () => {
    await captureServerEvent("user_signed_up", {
      distinctId: "user-abc",
      properties: { plan: "pro" },
      env: { POSTHOG_KEY: "phc_test_key" },
      fetch: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/i/v0/e/");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe("phc_test_key");
    expect(body.event).toBe("user_signed_up");
    expect(typeof body.timestamp).toBe("string");

    const props = body.properties as Record<string, unknown>;
    expect(props.distinct_id).toBe("user-abc");
    expect(props.plan).toBe("pro");
  });

  it("includes $groups when orgId is provided", async () => {
    await captureServerEvent("workspace_created", {
      distinctId: "user-abc",
      orgId: "org-123",
      env: { POSTHOG_KEY: "phc_test_key" },
      fetch: mockFetch,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const props = body.properties as Record<string, unknown>;
    expect(props.$groups).toEqual({ organization: "org-123" });
  });

  it("does not include $groups when orgId is absent", async () => {
    await captureServerEvent("user_signed_up", {
      distinctId: "user-abc",
      env: { POSTHOG_KEY: "phc_test_key" },
      fetch: mockFetch,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const props = body.properties as Record<string, unknown>;
    expect(props.$groups).toBeUndefined();
  });

  it("rewrites app.posthog.com to us.i.posthog.com", async () => {
    await captureServerEvent("user_signed_up", {
      distinctId: "user-1",
      env: {
        POSTHOG_KEY: "phc_test_key",
        POSTHOG_HOST: "https://app.posthog.com",
      },
      fetch: mockFetch,
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("us.i.posthog.com");
    expect(url).not.toContain("app.posthog.com");
  });

  it("preserves non-app.posthog.com host unchanged", async () => {
    await captureServerEvent("user_signed_up", {
      distinctId: "user-1",
      env: {
        POSTHOG_KEY: "phc_test_key",
        POSTHOG_HOST: "https://eu.posthog.com",
      },
      fetch: mockFetch,
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("eu.posthog.com");
  });

  it("never throws even when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    await expect(
      captureServerEvent("user_signed_up", {
        distinctId: "user-1",
        env: { POSTHOG_KEY: "phc_test_key" },
        fetch: mockFetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sanitizeProperties", () => {
  it("removes keys containing 'password'", () => {
    const result = sanitizeProperties({ password: "secret123", name: "Alice" });
    expect(result).not.toHaveProperty("password");
    expect(result.name).toBe("Alice");
  });

  it("removes keys containing 'token'", () => {
    const result = sanitizeProperties({ auth_token: "tok_abc", userId: "u1" });
    expect(result).not.toHaveProperty("auth_token");
    expect(result.userId).toBe("u1");
  });

  it("removes keys containing 'secret'", () => {
    const result = sanitizeProperties({ client_secret: "shhh", plan: "free" });
    expect(result).not.toHaveProperty("client_secret");
    expect(result.plan).toBe("free");
  });

  it("removes keys ending with 'key'", () => {
    const result = sanitizeProperties({ api_key: "k123", event: "click" });
    expect(result).not.toHaveProperty("api_key");
    expect(result.event).toBe("click");
  });

  it("is case-insensitive for secret key matching", () => {
    const result = sanitizeProperties({
      Password: "p",
      TOKEN: "t",
      SECRET: "s",
      API_KEY: "k",
      safe: "yes",
    });
    expect(result).not.toHaveProperty("Password");
    expect(result).not.toHaveProperty("TOKEN");
    expect(result).not.toHaveProperty("SECRET");
    expect(result).not.toHaveProperty("API_KEY");
    expect(result.safe).toBe("yes");
  });

  it("truncates string values to 1000 characters", () => {
    const longString = "a".repeat(2000);
    const result = sanitizeProperties({ description: longString });
    expect((result.description as string).length).toBe(1000);
  });

  it("does not truncate strings under 1000 characters", () => {
    const result = sanitizeProperties({ note: "short" });
    expect(result.note).toBe("short");
  });

  it("removes undefined values", () => {
    const result = sanitizeProperties({
      defined: "yes",
      missing: undefined,
    } as Record<string, unknown>);
    expect(result).toHaveProperty("defined");
    expect(result).not.toHaveProperty("missing");
  });

  it("does not mutate the original object", () => {
    const original: Record<string, unknown> = { name: "test", password: "secret" };
    const result = sanitizeProperties(original);
    expect(original).toHaveProperty("password");
    expect(result).not.toHaveProperty("password");
  });

  it("passes through non-string non-secret values unchanged", () => {
    const result = sanitizeProperties({ count: 42, active: true, ratio: 3.14 });
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.ratio).toBe(3.14);
  });

  it("returns empty object for empty input", () => {
    expect(sanitizeProperties({})).toEqual({});
  });

  it("removes keys containing 'credential'", () => {
    const result = sanitizeProperties({ api_credential: "cred_xyz", plan: "starter" });
    expect(result).not.toHaveProperty("api_credential");
    expect(result.plan).toBe("starter");
  });

  it("removes keys ending with 'auth'", () => {
    const result = sanitizeProperties({ x_auth: "bearer_tok", region: "us-east" });
    expect(result).not.toHaveProperty("x_auth");
    expect(result.region).toBe("us-east");
  });

  it("removes keys ending with 'auth' regardless of prefix (oauth)", () => {
    const result = sanitizeProperties({ oauth: "code_abc", user: "alice" });
    expect(result).not.toHaveProperty("oauth");
    expect(result.user).toBe("alice");
  });

  it("removes keys ending with 'key' (camelCase apiKey)", () => {
    const result = sanitizeProperties({ apiKey: "k999", label: "prod" });
    expect(result).not.toHaveProperty("apiKey");
    expect(result.label).toBe("prod");
  });

  it("removes keys containing 'token' as substring (session_token)", () => {
    const result = sanitizeProperties({ session_token: "tok_session", role: "admin" });
    expect(result).not.toHaveProperty("session_token");
    expect(result.role).toBe("admin");
  });

  it("does NOT remove keys whose suffix is 'or' not 'auth' (author)", () => {
    const result = sanitizeProperties({ author: "Alice", plan: "pro" });
    expect(result.author).toBe("Alice");
    expect(result.plan).toBe("pro");
  });

  it("does NOT remove normal keys like plan_name", () => {
    const result = sanitizeProperties({ plan_name: "enterprise", seats: 50 });
    expect(result.plan_name).toBe("enterprise");
    expect(result.seats).toBe(50);
  });
});

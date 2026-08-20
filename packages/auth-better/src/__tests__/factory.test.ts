import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthInstance, User } from "../types.js";

// Mock better-auth before importing factory
vi.mock("better-auth", () => {
  const mockInstance: BetterAuthInstance = {
    handler: async (_req: Request) => new Response("ok"),
    api: {
      getSession: async (_opts: { headers: Headers }) => null,
    },
  };
  return {
    betterAuth: vi.fn(() => mockInstance),
  };
});

const { createAuth } = await import("../factory.js");

const VALID_SECRET = "a".repeat(32);

const baseOpts = {
  db: {},
  env: { BETTER_AUTH_SECRET: VALID_SECRET },
  appUrl: "https://app.example.com",
};

describe("createAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if BETTER_AUTH_SECRET is missing", () => {
    expect(() => createAuth({ ...baseOpts, env: { BETTER_AUTH_SECRET: "" } })).toThrow(
      "BETTER_AUTH_SECRET is required",
    );
  });

  it("throws if secret is shorter than 32 characters", () => {
    expect(() => createAuth({ ...baseOpts, env: { BETTER_AUTH_SECRET: "short" } })).toThrow(
      "BETTER_AUTH_SECRET must be at least 32 characters",
    );
  });

  it("returns an object with handler and api.getSession", () => {
    const auth = createAuth(baseOpts);
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.api.getSession).toBe("function");
  });

  it("does not throw with crossSubdomainCookie config enabled", () => {
    expect(() =>
      createAuth({
        ...baseOpts,
        crossSubdomainCookie: { enabled: true, domain: ".lextract.app" },
      }),
    ).not.toThrow();
  });

  it("does not throw with crossSubdomainCookie config disabled", () => {
    expect(() =>
      createAuth({
        ...baseOpts,
        crossSubdomainCookie: { enabled: false, domain: ".lextract.app" },
      }),
    ).not.toThrow();
  });

  it("includes Google OAuth provider when enableGoogleOAuth is true and credentials present", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth({
      ...baseOpts,
      env: {
        BETTER_AUTH_SECRET: VALID_SECRET,
        GOOGLE_CLIENT_ID: "google-client-id",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
      },
      enableGoogleOAuth: true,
    });

    expect(betterAuthMock).toHaveBeenCalledOnce();
    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const socialProviders = config.socialProviders as Record<string, unknown>;
    expect(socialProviders.google).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
  });

  it("does not include Google OAuth when enableGoogleOAuth is false", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth({
      ...baseOpts,
      env: {
        BETTER_AUTH_SECRET: VALID_SECRET,
        GOOGLE_CLIENT_ID: "google-client-id",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
      },
      enableGoogleOAuth: false,
    });

    expect(betterAuthMock).toHaveBeenCalledOnce();
    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const socialProviders = config.socialProviders as Record<string, unknown>;
    expect(socialProviders.google).toBeUndefined();
  });

  it("uses BETTER_AUTH_URL over appUrl when provided", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth({
      ...baseOpts,
      env: {
        BETTER_AUTH_SECRET: VALID_SECRET,
        BETTER_AUTH_URL: "https://auth.example.com",
      },
    });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseURL).toBe("https://auth.example.com");
  });

  it("falls back to appUrl when BETTER_AUTH_URL is not provided", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth(baseOpts);

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.baseURL).toBe("https://app.example.com");
  });

  it("passes email verification config when provided", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const handler = vi.fn();

    createAuth({
      ...baseOpts,
      emailVerification: {
        sendOnSignUp: true,
        handler,
      },
    });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const emailVerif = config.emailVerification as Record<string, unknown>;
    expect(emailVerif.sendOnSignUp).toBe(true);
    expect(typeof emailVerif.sendVerificationEmail).toBe("function");
  });

  it("sendVerificationEmail callback invokes the handler", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const handler = vi.fn().mockResolvedValue(undefined);
    const mockUser: User = {
      id: "u1",
      email: "a@b.com",
      emailVerified: false,
      createdAt: new Date(),
    };

    createAuth({
      ...baseOpts,
      emailVerification: { sendOnSignUp: true, handler },
    });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const emailVerif = config.emailVerification as Record<string, unknown>;
    const sendFn = emailVerif.sendVerificationEmail as (data: {
      user: User;
      url: string;
      token: string;
    }) => Promise<void>;

    await sendFn({ user: mockUser, url: "https://example.com/verify", token: "tok" });
    expect(handler).toHaveBeenCalledWith({
      user: mockUser,
      url: "https://example.com/verify",
      token: "tok",
    });
  });

  it("passes password reset handler when provided", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const passwordReset = vi.fn();

    createAuth({ ...baseOpts, passwordReset });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const emailAndPassword = config.emailAndPassword as Record<string, unknown>;
    expect(emailAndPassword.enabled).toBe(true);
    expect(typeof emailAndPassword.sendResetPassword).toBe("function");
  });

  it("enables email/password auth by default", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth(baseOpts);

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const emailAndPassword = config.emailAndPassword as Record<string, unknown>;
    expect(emailAndPassword.enabled).toBe(true);
  });

  it("sendResetPassword callback invokes the passwordReset handler", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const passwordReset = vi.fn().mockResolvedValue(undefined);
    const mockUser: User = {
      id: "u1",
      email: "a@b.com",
      emailVerified: true,
      createdAt: new Date(),
    };

    createAuth({ ...baseOpts, passwordReset });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const emailAndPassword = config.emailAndPassword as Record<string, unknown>;
    const sendFn = emailAndPassword.sendResetPassword as (data: {
      user: User;
      url: string;
      token: string;
    }) => Promise<void>;

    await sendFn({ user: mockUser, url: "https://example.com/reset", token: "rst" });
    expect(passwordReset).toHaveBeenCalledWith({
      user: mockUser,
      url: "https://example.com/reset",
      token: "rst",
    });
  });

  it("signupHook callback invokes the hook with user and request", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const signupHook = vi.fn().mockResolvedValue(undefined);
    const mockUser: User = {
      id: "u1",
      email: "a@b.com",
      emailVerified: false,
      createdAt: new Date(),
    };

    createAuth({ ...baseOpts, signupHook });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    const afterHook = hooks.after as (ctx: Record<string, unknown>) => Promise<void>;
    expect(typeof afterHook).toBe("function");

    // Test handler with a valid newUser
    const mockRequest = new Request("https://app.example.com");
    await afterHook({
      path: "/sign-up/email",
      context: { newUser: { user: mockUser } },
      request: mockRequest,
    });
    expect(signupHook).toHaveBeenCalledWith(mockUser, mockRequest);

    await afterHook({
      path: "/sign-in/email",
      context: { newUser: { user: mockUser } },
      request: mockRequest,
    });
    expect(signupHook).toHaveBeenCalledOnce();
  });

  it("signupHook handler uses fallback Request when request is undefined", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const signupHook = vi.fn().mockResolvedValue(undefined);
    const mockUser: User = {
      id: "u1",
      email: "a@b.com",
      emailVerified: false,
      createdAt: new Date(),
    };

    createAuth({ ...baseOpts, signupHook });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    const afterHook = hooks.after as (ctx: Record<string, unknown>) => Promise<void>;

    await afterHook({
      path: "/sign-up/email",
      context: { newUser: { user: mockUser } },
      // no request field — tests fallback path
    });
    expect(signupHook).toHaveBeenCalledOnce();
  });

  it("signupHook handler does not call hook when newUser is undefined", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const signupHook = vi.fn().mockResolvedValue(undefined);

    createAuth({ ...baseOpts, signupHook });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    const afterHook = hooks.after as (ctx: Record<string, unknown>) => Promise<void>;

    await afterHook({
      path: "/sign-up/email",
      context: {},
    });
    expect(signupHook).not.toHaveBeenCalled();
  });

  it("passes plugins array through to betterAuth", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);
    const fakePlugin = { id: "test-plugin" };

    createAuth({ ...baseOpts, plugins: [fakePlugin] });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.plugins).toEqual([fakePlugin]);
  });

  it("uses default cookieCacheMaxAge of 60 when not provided", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth(baseOpts);

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const advanced = config.advanced as Record<string, unknown>;
    const cookieCache = advanced.cookieCache as Record<string, unknown>;
    expect(cookieCache.maxAge).toBe(60);
  });

  it("uses provided cookieCacheMaxAge", async () => {
    const { betterAuth } = await import("better-auth");
    const betterAuthMock = vi.mocked(betterAuth);

    createAuth({ ...baseOpts, cookieCacheMaxAge: 120 });

    const config = betterAuthMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const advanced = config.advanced as Record<string, unknown>;
    const cookieCache = advanced.cookieCache as Record<string, unknown>;
    expect(cookieCache.maxAge).toBe(120);
  });
});

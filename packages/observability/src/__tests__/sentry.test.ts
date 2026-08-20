import type { Scope } from "@sentry/cloudflare";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/core before importing the module under test
vi.mock("@sentry/core", () => {
  const withScopeMock = vi.fn(<T>(fn: (scope: Scope) => T): T => {
    return fn({
      setTag: vi.fn(),
      setExtra: vi.fn(),
    } as unknown as Scope);
  });
  return {
    withScope: withScopeMock,
    captureException: vi.fn(() => "mock-event-id"),
    captureMessage: vi.fn(),
  };
});

import * as SentryMock from "@sentry/core";
import {
  captureException,
  captureMessage,
  initSentryCloudflare,
  initSentryNode,
} from "../sentry.js";
import type { SentryCloudflareEnv, SentryNodeOpts } from "../sentry.js";

// Helper to avoid fighting with Sentry's overloaded withScope type in vi.mocked
function mockWithScopeOnce(impl: <T>(fn: (scope: Scope) => T) => T): void {
  (SentryMock.withScope as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(impl);
}

describe("initSentryCloudflare", () => {
  it("returns null when SENTRY_DSN is absent", () => {
    const env: SentryCloudflareEnv = {};
    expect(initSentryCloudflare(env)).toBeNull();
  });

  it("returns null when SENTRY_DSN is empty string", () => {
    const env: SentryCloudflareEnv = { SENTRY_DSN: "" };
    expect(initSentryCloudflare(env)).toBeNull();
  });

  it("returns config object with DSN when SENTRY_DSN is present", () => {
    const env: SentryCloudflareEnv = {
      SENTRY_DSN: "https://key@sentry.io/123",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: "1.0.0",
    };
    const config = initSentryCloudflare(env);
    expect(config).not.toBeNull();
    expect(config?.dsn).toBe("https://key@sentry.io/123");
    expect(config?.environment).toBe("production");
    expect(config?.release).toBe("1.0.0");
    expect(config?.sendDefaultPii).toBe(false);
  });

  it("returns config with sendDefaultPii: false regardless of input", () => {
    const env: SentryCloudflareEnv = { SENTRY_DSN: "https://key@sentry.io/123" };
    const config = initSentryCloudflare(env);
    expect(config?.sendDefaultPii).toBe(false);
  });

  it("returns config with undefined optional fields when not provided", () => {
    const env: SentryCloudflareEnv = { SENTRY_DSN: "https://key@sentry.io/123" };
    const config = initSentryCloudflare(env);
    expect(config?.environment).toBeUndefined();
    expect(config?.release).toBeUndefined();
  });
});

describe("captureException", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls withScope and captureException", () => {
    const err = new Error("test error");
    captureException(err);
    expect(SentryMock.withScope).toHaveBeenCalledTimes(1);
    expect(SentryMock.captureException).toHaveBeenCalledWith(err);
  });

  it("returns the event ID string from Sentry", () => {
    const err = new Error("test");
    const id = captureException(err);
    expect(typeof id).toBe("string");
    expect(id).toBe("mock-event-id");
  });

  it("applies tags to the scope", () => {
    const setTag = vi.fn();
    const setExtra = vi.fn();
    const scopeMock = { setTag, setExtra } as unknown as Scope;
    mockWithScopeOnce(<T>(fn: (scope: Scope) => T): T => fn(scopeMock));
    captureException(new Error("e"), { tags: { env: "prod", count: 1 } });
    expect(setTag).toHaveBeenCalledWith("env", "prod");
    expect(setTag).toHaveBeenCalledWith("count", "1");
  });

  it("applies extra context to the scope", () => {
    const setTag = vi.fn();
    const setExtra = vi.fn();
    const scopeMock = { setTag, setExtra } as unknown as Scope;
    mockWithScopeOnce(<T>(fn: (scope: Scope) => T): T => fn(scopeMock));
    captureException(new Error("e"), { extra: { userId: "u1", data: { x: 1 } } });
    expect(setExtra).toHaveBeenCalledWith("userId", "u1");
    expect(setExtra).toHaveBeenCalledWith("data", { x: 1 });
  });

  it("skips null/undefined tag values without crashing", () => {
    const setTag = vi.fn();
    const setExtra = vi.fn();
    const scopeMock = { setTag, setExtra } as unknown as Scope;
    mockWithScopeOnce(<T>(fn: (scope: Scope) => T): T => fn(scopeMock));
    captureException(new Error("e"), {
      tags: { a: null, b: undefined, c: "ok" },
    });
    // null and undefined are skipped
    expect(setTag).toHaveBeenCalledTimes(1);
    expect(setTag).toHaveBeenCalledWith("c", "ok");
  });

  it("no-ops silently when withScope throws", () => {
    (SentryMock.withScope as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Sentry not initialized");
    });
    expect(() => captureException(new Error("e"))).not.toThrow();
  });

  it("returns undefined when withScope throws", () => {
    (SentryMock.withScope as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Sentry not initialized");
    });
    expect(captureException(new Error("e"))).toBeUndefined();
  });

  it("works with no context argument", () => {
    expect(() => captureException(new Error("no ctx"))).not.toThrow();
  });
});

describe("captureMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls withScope and captureMessage", () => {
    captureMessage("hello");
    expect(SentryMock.withScope).toHaveBeenCalledTimes(1);
    expect(SentryMock.captureMessage).toHaveBeenCalledWith("hello");
  });

  it("applies tags to the scope", () => {
    const setTag = vi.fn();
    const setExtra = vi.fn();
    const scopeMock = { setTag, setExtra } as unknown as Scope;
    mockWithScopeOnce(<T>(fn: (scope: Scope) => T): T => fn(scopeMock));
    captureMessage("msg", { tags: { region: "us-east" } });
    expect(setTag).toHaveBeenCalledWith("region", "us-east");
  });

  it("applies extra context to the scope", () => {
    const setTag = vi.fn();
    const setExtra = vi.fn();
    const scopeMock = { setTag, setExtra } as unknown as Scope;
    mockWithScopeOnce(<T>(fn: (scope: Scope) => T): T => fn(scopeMock));
    captureMessage("msg", { extra: { requestId: "req-1", details: { x: 1 } } });
    expect(setExtra).toHaveBeenCalledWith("requestId", "req-1");
    expect(setExtra).toHaveBeenCalledWith("details", { x: 1 });
  });

  it("no-ops silently when withScope throws", () => {
    (SentryMock.withScope as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Sentry not initialized");
    });
    expect(() => captureMessage("msg")).not.toThrow();
  });

  it("works with no context argument", () => {
    expect(() => captureMessage("bare message")).not.toThrow();
  });
});

describe("initSentryNode", () => {
  it("resolves without error when dsn is provided", async () => {
    const opts: SentryNodeOpts = {
      dsn: "https://key@sentry.io/456",
      environment: "test",
    };
    await expect(initSentryNode(opts)).resolves.toBeUndefined();
  });

  it("resolves with release and sendDefaultPii set", async () => {
    const opts: SentryNodeOpts = {
      dsn: "https://key@sentry.io/456",
      environment: "production",
      release: "1.2.3",
      sendDefaultPii: true,
    };
    await expect(initSentryNode(opts)).resolves.toBeUndefined();
  });

  it("resolves immediately when dsn is absent", async () => {
    const opts: SentryNodeOpts = {};
    await expect(initSentryNode(opts)).resolves.toBeUndefined();
  });
});

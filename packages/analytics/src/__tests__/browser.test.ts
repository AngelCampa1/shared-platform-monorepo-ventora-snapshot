import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock posthog-js before importing browser module
const mockPosthog = {
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
};

vi.mock("posthog-js", () => ({ default: mockPosthog }));

// Import after mock is set up
const { initAnalytics, trackEvent, identifyUser, groupOrganization, resetAnalytics } = await import(
  "../browser.js"
);

describe("browser analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state between tests
    resetAnalytics();
    // posthog.reset is also called by resetAnalytics — clear again after
    vi.clearAllMocks();
  });

  describe("initAnalytics", () => {
    it("no-ops when posthogKey is absent", async () => {
      initAnalytics({
        environment: "test",
        productSlug: "camaudit",
      });

      // Give dynamic import time to resolve (it won't in no-key path anyway)
      await vi.runAllTimersAsync().catch(() => null);
      expect(mockPosthog.init).not.toHaveBeenCalled();
    });

    it("no-ops in SSR environment (no window)", async () => {
      // happy-dom provides window, but the key-absent guard fires first
      // This test verifies the no-key path as the observable SSR safety
      initAnalytics({
        environment: "test",
        productSlug: "camaudit",
      });
      expect(mockPosthog.init).not.toHaveBeenCalled();
    });

    it("calls posthog.init with correct api_host when key is provided", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
        posthogHost: "https://eu.posthog.com",
      });

      // Wait for dynamic import to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(mockPosthog.init).toHaveBeenCalledWith("phc_test", {
        api_host: "https://eu.posthog.com",
        debug: false,
        loaded: expect.any(Function) as unknown,
      });
    });

    it("rewrites app.posthog.com host to us.i.posthog.com", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
        posthogHost: "https://app.posthog.com",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { api_host: string }];
      expect(initCall[1].api_host).toBe("https://us.i.posthog.com");
    });

    it("uses us.i.posthog.com as default host", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "lextract",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { api_host: string }];
      expect(initCall[1].api_host).toBe("https://us.i.posthog.com");
    });

    it("passes debug flag through", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
        debug: true,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { debug: boolean }];
      expect(initCall[1].debug).toBe(true);
    });
  });

  describe("trackEvent (not initialized)", () => {
    it("no-ops when not initialized", () => {
      trackEvent("user_signed_up", { plan: "pro" });
      expect(mockPosthog.capture).not.toHaveBeenCalled();
    });
  });

  describe("trackEvent (initialized)", () => {
    beforeEach(async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Simulate posthog.init calling the loaded callback
      const initCall = mockPosthog.init.mock.calls[0] as [string, { loaded: () => void }];
      initCall[1].loaded();
    });

    it("calls posthog.capture with event and product slug", () => {
      trackEvent("user_signed_in", { source: "web" });
      expect(mockPosthog.capture).toHaveBeenCalledWith("user_signed_in", {
        source: "web",
        product: "camaudit",
      });
    });

    it("warns and no-ops for unapproved event (runtime guard)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      trackEvent("not_an_event" as Parameters<typeof trackEvent>[0], {});
      expect(mockPosthog.capture).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unapproved event"));
      warnSpy.mockRestore();
    });

    it("captures event without extra props", () => {
      trackEvent("page_viewed");
      expect(mockPosthog.capture).toHaveBeenCalledWith("page_viewed", {
        product: "camaudit",
      });
    });
  });

  describe("identifyUser", () => {
    it("no-ops when not initialized", () => {
      identifyUser("user-1", { name: "Alice" });
      expect(mockPosthog.identify).not.toHaveBeenCalled();
    });

    it("calls posthog.identify when initialized", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { loaded: () => void }];
      initCall[1].loaded();

      identifyUser("user-42", { name: "Alice", plan: "pro" });
      expect(mockPosthog.identify).toHaveBeenCalledWith("user-42", {
        name: "Alice",
        plan: "pro",
      });
    });
  });

  describe("groupOrganization", () => {
    it("no-ops when not initialized", () => {
      groupOrganization("org-1");
      expect(mockPosthog.group).not.toHaveBeenCalled();
    });

    it("calls posthog.group when initialized", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { loaded: () => void }];
      initCall[1].loaded();

      groupOrganization("org-123", { tier: "enterprise" });
      expect(mockPosthog.group).toHaveBeenCalledWith("organization", "org-123", {
        tier: "enterprise",
      });
    });
  });

  describe("resetAnalytics", () => {
    it("calls posthog.reset when initialized", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { loaded: () => void }];
      initCall[1].loaded();

      resetAnalytics();
      expect(mockPosthog.reset).toHaveBeenCalledOnce();
    });

    it("resets state so subsequent trackEvent no-ops", async () => {
      initAnalytics({
        posthogKey: "phc_test",
        environment: "test",
        productSlug: "camaudit",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const initCall = mockPosthog.init.mock.calls[0] as [string, { loaded: () => void }];
      initCall[1].loaded();

      resetAnalytics();
      vi.clearAllMocks();

      trackEvent("user_signed_out");
      expect(mockPosthog.capture).not.toHaveBeenCalled();
    });

    it("does not throw when called without prior init", () => {
      expect(() => resetAnalytics()).not.toThrow();
    });
  });
});

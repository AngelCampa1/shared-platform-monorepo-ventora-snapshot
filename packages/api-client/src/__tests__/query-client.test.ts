import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../error.js";
import { createQueryClient } from "../query-client.js";

describe("createQueryClient", () => {
  it("returns a QueryClient instance", () => {
    const qc = createQueryClient();
    expect(qc).toBeInstanceOf(QueryClient);
  });

  it("uses default staleTime of 60s", () => {
    const qc = createQueryClient();
    const defaults = qc.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(60_000);
  });

  it("uses default gcTime of 5min", () => {
    const qc = createQueryClient();
    const defaults = qc.getDefaultOptions();
    expect(defaults.queries?.gcTime).toBe(300_000);
  });

  it("respects custom staleTime", () => {
    const qc = createQueryClient({ staleTime: 10_000 });
    const defaults = qc.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(10_000);
  });

  it("respects custom gcTime", () => {
    const qc = createQueryClient({ gcTime: 60_000 });
    const defaults = qc.getDefaultOptions();
    expect(defaults.queries?.gcTime).toBe(60_000);
  });

  describe("retry function", () => {
    it("returns false for 4xx ApiErrors", () => {
      const qc = createQueryClient({ retries: 3 });
      const retryFn = qc.getDefaultOptions().queries?.retry;
      expect(typeof retryFn).toBe("function");

      if (typeof retryFn === "function") {
        const err4xx = new ApiError({ status: 400 });
        expect(retryFn(0, err4xx)).toBe(false);
        expect(retryFn(1, err4xx)).toBe(false);

        const err404 = new ApiError({ status: 404 });
        expect(retryFn(0, err404)).toBe(false);

        const err401 = new ApiError({ status: 401 });
        expect(retryFn(0, err401)).toBe(false);

        const err422 = new ApiError({ status: 422 });
        expect(retryFn(0, err422)).toBe(false);
      }
    });

    it("returns true for 5xx ApiErrors when under retry limit", () => {
      const qc = createQueryClient({ retries: 2 });
      const retryFn = qc.getDefaultOptions().queries?.retry;

      if (typeof retryFn === "function") {
        const err5xx = new ApiError({ status: 500 });
        expect(retryFn(0, err5xx)).toBe(true);
        expect(retryFn(1, err5xx)).toBe(true);
        expect(retryFn(2, err5xx)).toBe(false);
      }
    });

    it("returns true for non-ApiError when under retry limit", () => {
      const qc = createQueryClient({ retries: 1 });
      const retryFn = qc.getDefaultOptions().queries?.retry;

      if (typeof retryFn === "function") {
        const networkErr = new TypeError("Failed to fetch");
        expect(retryFn(0, networkErr)).toBe(true);
        expect(retryFn(1, networkErr)).toBe(false);
      }
    });

    it("uses default retries of 1", () => {
      const qc = createQueryClient();
      const retryFn = qc.getDefaultOptions().queries?.retry;

      if (typeof retryFn === "function") {
        const networkErr = new TypeError("Failed to fetch");
        expect(retryFn(0, networkErr)).toBe(true);
        expect(retryFn(1, networkErr)).toBe(false);
      }
    });

    it("does not retry 5xx when failureCount equals retries", () => {
      const qc = createQueryClient({ retries: 1 });
      const retryFn = qc.getDefaultOptions().queries?.retry;

      if (typeof retryFn === "function") {
        const err5xx = new ApiError({ status: 503 });
        expect(retryFn(1, err5xx)).toBe(false);
      }
    });
  });

  describe("mutations default options", () => {
    it("mutations have retry false by default", () => {
      const qc = createQueryClient();
      const defaults = qc.getDefaultOptions();
      expect(defaults.mutations?.retry).toBe(false);
    });
  });

  describe("onError callback", () => {
    it("stores onError option for mutations", () => {
      const onError = vi.fn();
      const qc = createQueryClient({ onError });
      const defaults = qc.getDefaultOptions();
      // The onError is set on mutations
      expect(defaults.mutations?.onError).toBe(onError);
    });
  });
});

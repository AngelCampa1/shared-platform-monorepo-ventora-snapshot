import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../client.js";
import { ApiError } from "../error.js";

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("createApiClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("URL construction", () => {
    it("joins baseUrl and path correctly", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.get("/users");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/users");
    });

    it("handles trailing slash on baseUrl", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com/" });
      await client.get("/users");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/users");
    });

    it("handles path without leading slash", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.get("users/123");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/users/123");
    });
  });

  describe("auth header", () => {
    it("adds Authorization header when authProvider returns token", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ data: "secret" }));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        authProvider: async () => ({ token: "my-token" }),
      });
      await client.get("/protected");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-token");
    });

    it("does not add Authorization header when authProvider returns null", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ data: "public" }));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        authProvider: async () => null,
      });
      await client.get("/public");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it("does not add Authorization header when authProvider returns no token", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ data: "public" }));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        authProvider: async () => ({}),
      });
      await client.get("/public");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });
  });

  describe("401 handling", () => {
    it("calls onUnauthorized and throws ApiError on 401", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ message: "Unauthorized" }, 401));

      const onUnauthorized = vi.fn();
      const client = createApiClient({
        baseUrl: "https://api.example.com",
        onUnauthorized,
      });

      await expect(client.get("/secure")).rejects.toBeInstanceOf(ApiError);
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });

    it("throws ApiError with status 401 on 401 response", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ message: "Token expired" }, 401));

      const client = createApiClient({ baseUrl: "https://api.example.com" });

      try {
        await client.get("/secure");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(401);
      }
    });
  });

  describe("error handling on non-2xx", () => {
    it("throws ApiError on 4xx response", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ message: "Not found" }, 404));

      const client = createApiClient({ baseUrl: "https://api.example.com" });

      await expect(client.get("/missing")).rejects.toBeInstanceOf(ApiError);
    });

    it("throws ApiError on 5xx response", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      // retries=0 to avoid retrying
      fetchMock.mockResolvedValue(mockResponse({ message: "Server error" }, 500));

      const client = createApiClient({ baseUrl: "https://api.example.com", retries: 0 });

      await expect(client.get("/broken")).rejects.toBeInstanceOf(ApiError);
    });

    it("calls sentryCapture with context on non-2xx", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValue(mockResponse({ message: "Bad" }, 400));

      const sentryCapture = vi.fn();
      const client = createApiClient({
        baseUrl: "https://api.example.com",
        sentryCapture,
        retries: 0,
      });

      await expect(client.get("/bad")).rejects.toBeInstanceOf(ApiError);
      expect(sentryCapture).toHaveBeenCalledOnce();
    });
  });

  describe("retry logic", () => {
    it("retries GET on 5xx up to retries times", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock
        .mockResolvedValueOnce(mockResponse({ error: "Server error" }, 500))
        .mockResolvedValueOnce(mockResponse({ data: "ok" }, 200));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        retries: 1,
        timeoutMs: 5000,
      });

      const result = await client.get<{ data: string }>("/unstable");
      expect(result).toEqual({ data: "ok" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 10_000);

    it("does not retry POST on 5xx", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValue(mockResponse({ error: "Server error" }, 500));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        retries: 1,
      });

      await expect(client.post("/submit", { data: "x" })).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry POST on network error", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        retries: 2,
      });

      await expect(client.post("/submit", { data: "x" })).rejects.toThrow("Failed to fetch");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats negative retries as zero", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValue(mockResponse({ error: "Server error" }, 500));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        retries: -1,
      });

      await expect(client.get("/broken")).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries GET on network error", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(mockResponse({ data: "recovered" }));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        retries: 1,
        timeoutMs: 5000,
      });

      const result = await client.get<{ data: string }>("/flaky");
      expect(result).toEqual({ data: "recovered" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 10_000);
  });

  describe("HTTP methods", () => {
    it("sends POST with JSON body", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ id: "new-id" }, 201));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      const result = await client.post<{ id: string }>("/items", { name: "widget" });

      expect(result).toEqual({ id: "new-id" });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ name: "widget" }));
    });

    it("sends PUT with JSON body", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ updated: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.put("/items/1", { name: "updated" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("PUT");
    });

    it("sends PATCH with JSON body", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ patched: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.patch("/items/1", { name: "patched" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("PATCH");
    });

    it("sends DELETE", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      const result = await client.del("/items/1");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("DELETE");
      expect(result).toBeUndefined();
    });
  });

  describe("downloadBlob", () => {
    it("returns Blob on 2xx response", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      const blob = new Blob(["file content"], { type: "application/pdf" });
      fetchMock.mockResolvedValueOnce(new Response(blob, { status: 200 }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      const result = await client.downloadBlob("/files/doc.pdf");

      expect(result).toBeInstanceOf(Blob);
    });

    it("throws ApiError on non-2xx when downloading", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ message: "Not found" }, 404));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await expect(client.downloadBlob("/files/missing.pdf")).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("timeout", () => {
    it("passes signal to fetch", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createApiClient({
        baseUrl: "https://api.example.com",
        timeoutMs: 10_000,
      });
      await client.get("/health");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
    });

    it("merges incoming AbortSignal with timeout signal", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const controller = new AbortController();
      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.get("/health", { signal: controller.signal });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
    });

    it("propagates abort when signal fires", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      const controller = new AbortController();

      fetchMock.mockImplementationOnce((_url, init) => {
        // simulate fetch rejecting when signal is aborted
        return new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal)?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          controller.abort();
        });
      });

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await expect(client.get("/slow", { signal: controller.signal })).rejects.toThrow();
    });
  });

  describe("custom headers", () => {
    it("merges custom request headers", async () => {
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const client = createApiClient({ baseUrl: "https://api.example.com" });
      await client.get("/items", { headers: { "x-tenant-id": "tenant-1" } });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["x-tenant-id"]).toBe("tenant-1");
    });
  });
});

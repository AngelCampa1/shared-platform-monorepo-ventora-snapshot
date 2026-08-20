import { describe, expect, it, vi } from "vitest";
import { submitToIndexNow } from "../indexnow.js";

type MockFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

function makeMockFetch(status: number, ok: boolean): MockFetch {
  return vi.fn().mockResolvedValue({ ok, status }) as unknown as MockFetch;
}

function makeErrorFetch(): MockFetch {
  return vi.fn().mockRejectedValue(new Error("Network error")) as unknown as MockFetch;
}

describe("submitToIndexNow", () => {
  it("returns ok=true and status for successful submission", async () => {
    const mockFetch = makeMockFetch(200, true);
    const result = await submitToIndexNow(["https://example.com/page-1"], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("POSTs to https://api.indexnow.org/indexnow", async () => {
    const mockFetch = makeMockFetch(200, true);
    await submitToIndexNow(["https://example.com/page-1"], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.indexnow.org/indexnow",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends correct JSON body", async () => {
    const mockFetch = makeMockFetch(200, true);
    await submitToIndexNow(["https://example.com/page-1", "https://example.com/page-2"], {
      key: "mykey",
      host: "example.com",
      fetch: mockFetch,
    });
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const options = callArgs[1] as { body: string };
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body.host).toBe("example.com");
    expect(body.key).toBe("mykey");
    expect(body.keyLocation).toBe("https://example.com/mykey.txt");
    expect(body.urlList).toEqual(["https://example.com/page-1", "https://example.com/page-2"]);
  });

  it("sets Content-Type header to application/json with charset", async () => {
    const mockFetch = makeMockFetch(200, true);
    await submitToIndexNow(["https://example.com/"], {
      key: "k",
      host: "example.com",
      fetch: mockFetch,
    });
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const options = callArgs[1] as { headers: Record<string, string> };
    expect(options.headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("returns ok=false and correct status for 4xx response", async () => {
    const mockFetch = makeMockFetch(422, false);
    const result = await submitToIndexNow(["https://example.com/page-1"], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
  });

  it("returns { ok: false, status: 0 } on network error", async () => {
    const mockFetch = makeErrorFetch();
    const result = await submitToIndexNow(["https://example.com/page-1"], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it("never throws on network failure", async () => {
    const mockFetch = makeErrorFetch();
    await expect(
      submitToIndexNow(["https://example.com/page-1"], {
        key: "abc123",
        host: "example.com",
        fetch: mockFetch,
      }),
    ).resolves.not.toThrow();
  });

  it("handles empty urls array", async () => {
    const mockFetch = makeMockFetch(200, true);
    const result = await submitToIndexNow([], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(result.ok).toBe(true);
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const options = callArgs[1] as { body: string };
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body.urlList).toEqual([]);
  });

  it("returns ok=false and status=0 when fetch throws synchronously", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      throw new Error("Synchronous error");
    }) as unknown as MockFetch;
    const result = await submitToIndexNow(["https://example.com/page-1"], {
      key: "abc123",
      host: "example.com",
      fetch: mockFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it("returns { ok: false, status: 0 } when no fetch function is available", async () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: undefined,
      });
      const result = await submitToIndexNow(["https://example.com/page-1"], {
        key: "abc123",
        host: "example.com",
      });
      expect(result).toEqual({ ok: false, status: 0 });
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
      });
    }
  });
});

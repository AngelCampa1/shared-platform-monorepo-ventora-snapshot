import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiCsApiError,
  createAiCsSession,
  createAiCsSessionManager,
  createAiCsSseParser,
  createAiCsWidget,
  requestAiCsSupportEscalation,
  sendAiCsChatMessage,
} from "./index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
  const responseInit: ResponseInit = {
    status: init.status ?? 200,
    headers,
  };
  if (init.statusText !== undefined) {
    responseInit.statusText = init.statusText;
  }
  return new Response(JSON.stringify(body), responseInit);
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function fetchMock(response: Response): FetchMock {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe("createAiCsSseParser", () => {
  it("parses AI-CS events across chunks and flushes the final frame", () => {
    const seen: string[] = [];
    const parser = createAiCsSseParser({
      onEvent: (event) => seen.push(event.event),
    });

    expect(
      parser.feed(
        'event: navigation.suggestion\ndata: {"target":{"label":"Billing","path":"/settings/billing"}}\n\n',
      ),
    ).toEqual([
      {
        event: "navigation.suggestion",
        data: { target: { label: "Billing", path: "/settings/billing" } },
      },
    ]);
    parser.feed('event: message.done\ndata: {"messageId":"msg_1"}');
    expect(parser.end()).toEqual([{ event: "message.done", data: { messageId: "msg_1" } }]);
    expect(seen).toEqual(["navigation.suggestion", "message.done"]);
  });

  it("reports invalid JSON or event shapes and supports reset", () => {
    const errors: string[] = [];
    const parser = createAiCsSseParser({ onError: (error) => errors.push(error.message) });

    expect(parser.feed("event: message.done\ndata: not-json\n\n")).toEqual([]);
    expect(parser.feed('event: unknown\ndata: {"ok":true}\n\n')).toEqual([]);
    parser.feed('event: message.done\ndata: {"messageId":"discard"}');
    parser.reset();
    expect(parser.end()).toEqual([]);
    expect(errors).toEqual(["Invalid SSE JSON payload", "Invalid AI-CS SSE event"]);
  });

  it("ignores empty frames, comments, and unsupported SSE fields", () => {
    const parser = createAiCsSseParser();

    expect(parser.feed(": keepalive\nretry: 1000\n\n")).toEqual([]);
    expect(parser.feed('event: message.done\ndata: {"messageId":"msg_1"}\nignored\n\n')).toEqual([
      { event: "message.done", data: { messageId: "msg_1" } },
    ]);
  });

  it("parses CR-only SSE line endings", () => {
    const parser = createAiCsSseParser();

    expect(parser.feed('event: message.done\rdata: {"messageId":"msg_1"}\r\r')).toEqual([
      { event: "message.done", data: { messageId: "msg_1" } },
    ]);
  });
});

describe("AI-CS API helpers", () => {
  it("creates authenticated app sessions with browser-safe headers", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_1" }, { status: 201 }));

    await expect(
      createAiCsSession(
        { baseUrl: "https://support.example", fetch: fetchFn },
        { appId: "lextract", userId: "user_1", currentPath: "/dashboard" },
      ),
    ).resolves.toEqual({ sessionId: "sess_1" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(
      JSON.stringify({ appId: "lextract", userId: "user_1", currentPath: "/dashboard" }),
    );
  });

  it("merges auth headers and credentials from config and request options", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_auth" }, { status: 201 }));

    await expect(
      createAiCsSession(
        {
          baseUrl: "https://support.example",
          fetch: fetchFn,
          credentials: "include",
          headers: { Authorization: "Bearer config", "X-App": "lextract" },
        },
        { appId: "lextract", userId: "user_1" },
        {
          credentials: "omit",
          headers: { Authorization: "Bearer override", "X-Trace": "trace_1" },
        },
      ),
    ).resolves.toEqual({ sessionId: "sess_auth" });

    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("omit");
    expect(headers.get("Authorization")).toBe("Bearer override");
    expect(headers.get("X-App")).toBe("lextract");
    expect(headers.get("X-Trace")).toBe("trace_1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("streams chat events through callbacks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message.delta\ndata: {"messageId":"msg_1","delta":"Open billing."}\n\n',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            'event: navigation.suggestion\ndata: {"target":{"label":"Billing","path":"/settings/billing"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchFn = fetchMock(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const events: string[] = [];

    await expect(
      sendAiCsChatMessage(
        { baseUrl: "https://support.example", fetch: fetchFn },
        {
          sessionId: "sess_1",
          appId: "lextract",
          userId: "user_1",
          message: "Where is billing?",
          currentPath: "/settings",
        },
        { onEvent: (event) => events.push(event.event) },
      ),
    ).resolves.toEqual([
      { event: "message.delta", data: { messageId: "msg_1", delta: "Open billing." } },
      {
        event: "navigation.suggestion",
        data: { target: { label: "Billing", path: "/settings/billing" } },
      },
    ]);
    expect(events).toEqual(["message.delta", "navigation.suggestion"]);
  });

  it("invokes signRequest with the structured body and attaches HMAC headers", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_signed" }, { status: 201 }));
    const signRequest = vi.fn(async (input: { method: string; path: string; body: unknown }) => ({
      timestamp: "2026-05-01T00:00:00Z",
      nonce: `n-${input.path}`,
      signature: `sig-${JSON.stringify(input.body).length}-${input.method}`,
    }));
    const request = { appId: "lextract", userId: "user_signed" };
    await createAiCsSession(
      { baseUrl: "https://support.example", fetch: fetchFn, signRequest },
      request,
    );
    expect(signRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/sessions",
      body: request,
      serializedBody: JSON.stringify(request),
    });
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Timestamp")).toBe("2026-05-01T00:00:00Z");
    expect(headers.get("X-Ventora-Nonce")).toBe("n-/v1/sessions");
    expect(headers.get("X-Ventora-Signature")).toMatch(/^sig-/);
  });

  it("falls back to clientAssertion when no signRequest is provided", async () => {
    const fetchFn = fetchMock(jsonResponse({ escalationId: "e1", status: "queued" }));
    await requestAiCsSupportEscalation(
      {
        baseUrl: "https://support.example",
        fetch: fetchFn,
        clientAssertion: { timestamp: "ts-x", nonce: "nn-x", signature: "sg-x" },
      },
      { sessionId: "s", appId: "lextract", userId: "user_1" },
    );
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Timestamp")).toBe("ts-x");
    expect(headers.get("X-Ventora-Nonce")).toBe("nn-x");
    expect(headers.get("X-Ventora-Signature")).toBe("sg-x");
  });

  it("sends chat messages with signed headers on every call", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: message.done\ndata: {"messageId":"m1"}\n\n'),
        );
        controller.close();
      },
    });
    const fetchFn = fetchMock(new Response(stream, { status: 200 }));
    const signRequest = vi.fn(async () => ({
      timestamp: "t",
      nonce: "n",
      signature: "s",
    }));
    await sendAiCsChatMessage(
      { baseUrl: "https://support.example", fetch: fetchFn, signRequest },
      { sessionId: "sess_x", appId: "lextract", userId: "user_1", message: "hi" },
    );
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Signature")).toBe("s");
  });

  it("requests support escalations with typed receipts", async () => {
    const fetchFn = fetchMock(jsonResponse({ escalationId: "esc_1", status: "queued" }));

    await expect(
      requestAiCsSupportEscalation(
        { baseUrl: "https://support.example", fetch: fetchFn },
        {
          sessionId: "sess_1",
          appId: "lextract",
          userId: "user_1",
          reason: "account_issue",
          message: "Need help",
        },
      ),
    ).resolves.toEqual({ escalationId: "esc_1", status: "queued" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(
      JSON.stringify({
        sessionId: "sess_1",
        appId: "lextract",
        userId: "user_1",
        reason: "account_issue",
        message: "Need help",
      }),
    );
  });

  it("throws typed API errors and validates response shapes", async () => {
    await expect(
      createAiCsSession(
        { baseUrl: "https://support.example", fetch: fetchMock(jsonResponse({ id: "bad" })) },
        { appId: "lextract", userId: "user_1" },
      ),
    ).rejects.toThrow("Invalid create session response");

    await expect(
      sendAiCsChatMessage(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(
            jsonResponse({ error: "No session" }, { status: 404, statusText: "Not Found" }),
          ),
        },
        { sessionId: "missing", appId: "lextract", userId: "user_1", message: "hello" },
      ),
    ).rejects.toMatchObject(new AiCsApiError("No session", 404));

    await expect(
      requestAiCsSupportEscalation(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(jsonResponse({ status: "queued" })),
        },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1" },
      ),
    ).rejects.toThrow("Invalid support escalation response");
  });

  it("supports abort signals, text-only responses, and fallback error messages", async () => {
    const signal = new AbortController().signal;
    const textResponse = {
      ok: true,
      body: null,
      text: async () => 'event: message.done\ndata: {"messageId":"msg_1"}',
    } as Response;
    const fetchFn = fetchMock(textResponse);

    await expect(
      sendAiCsChatMessage(
        { baseUrl: "https://support.example/", fetch: fetchFn },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "done" },
        { signal },
      ),
    ).resolves.toEqual([{ event: "message.done", data: { messageId: "msg_1" } }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(
      JSON.stringify({ sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "done" }),
    );
    expect(init.signal).toBe(signal);

    await expect(
      sendAiCsChatMessage(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock({
            ok: true,
            body: undefined,
            text: async () => 'event: message.done\ndata: {"messageId":"msg_undefined_body"}',
          } as unknown as Response),
        },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "done" },
      ),
    ).resolves.toEqual([{ event: "message.done", data: { messageId: "msg_undefined_body" } }]);

    await expect(
      sendAiCsChatMessage(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(new Response("not-json", { status: 500, statusText: "" })),
        },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "hello" },
      ),
    ).rejects.toMatchObject(new AiCsApiError("Request failed", 500));
  });

  it("throws on empty or malformed successful chat streams", async () => {
    await expect(
      sendAiCsChatMessage(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(new Response("", { status: 200 })),
        },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "hello" },
      ),
    ).rejects.toThrow("Invalid AI-CS SSE event");

    await expect(
      sendAiCsChatMessage(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(
            new Response('event: unknown\ndata: {"ok":true}\n\n', {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          ),
        },
        { sessionId: "sess_1", appId: "lextract", userId: "user_1", message: "hello" },
      ),
    ).rejects.toThrow("Invalid AI-CS SSE event");
  });

  it("throws postJson API errors with fallback messages", async () => {
    await expect(
      createAiCsSession(
        {
          baseUrl: "https://support.example",
          fetch: fetchMock(new Response("", { status: 503, statusText: "Service Unavailable" })),
        },
        { appId: "lextract", userId: "user_1" },
      ),
    ).rejects.toMatchObject(new AiCsApiError("Service Unavailable", 503));
  });

  it("throws a clear error when no fetch implementation is available", async () => {
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: undefined });

    try {
      await expect(
        createAiCsSession(
          { baseUrl: "https://support.example" },
          { appId: "lextract", userId: "user_1" },
        ),
      ).rejects.toThrow("No fetch implementation available");
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });
});

describe("createAiCsSessionManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("reuses persisted app support sessions and can start a new chat", async () => {
    const storage = new Map<string, string>();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_existing" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_new" }, { status: 201 }));
    const session = { appId: "lextract", userId: "user_1", currentPath: "/dashboard" };
    const sessionStore = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: storage.delete.bind(storage),
    };

    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
      { sessionStore },
    );
    await expect(firstManager.getOrCreateSession()).resolves.toEqual({
      sessionId: "sess_existing",
    });

    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
      { sessionStore },
    );

    await expect(secondManager.getOrCreateSession()).resolves.toEqual({
      sessionId: "sess_existing",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await expect(secondManager.startNewChat()).resolves.toEqual({ sessionId: "sess_new" });
    await expect(firstManager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_new" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("clearActiveSession forgets the session lazily so the next get creates a fresh one (V-CS-8)", async () => {
    const storage = new Map<string, string>();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_second" }, { status: 201 }));
    const session = { appId: "lextract", userId: "user_1", currentPath: "/dashboard" };
    const sessionStore = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: storage.delete.bind(storage),
    };

    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
      { sessionStore },
    );

    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_first" });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Clearing must NOT hit the network — it only forgets the cached session.
    manager.clearActiveSession();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(manager.getSessionId()).toBeNull();

    // The next get lazily creates a brand-new session.
    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_second" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent session creation calls on one manager", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_single" }, { status: 201 }));
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_single" },
    );

    await expect(
      Promise.all([manager.getOrCreateSession(), manager.getOrCreateSession()]),
    ).resolves.toEqual([{ sessionId: "sess_single" }, { sessionId: "sess_single" }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent session creation calls across managers", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_shared" }, { status: 201 }));
    const session = { appId: "lextract", userId: "user_shared" };
    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
    );
    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
    );

    await expect(
      Promise.all([firstManager.getOrCreateSession(), secondManager.getOrCreateSession()]),
    ).resolves.toEqual([{ sessionId: "sess_shared" }, { sessionId: "sess_shared" }]);
    expect(firstManager.getSessionId()).toBe("sess_shared");
    expect(secondManager.getSessionId()).toBe("sess_shared");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent new-chat session creation calls", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_new_shared" }, { status: 201 }));
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_new_shared" },
    );

    await expect(Promise.all([manager.startNewChat(), manager.startNewChat()])).resolves.toEqual([
      { sessionId: "sess_new_shared" },
      { sessionId: "sess_new_shared" },
    ]);
    expect(manager.getSessionId()).toBe("sess_new_shared");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce managers with different API config", async () => {
    const firstFetch = fetchMock(jsonResponse({ sessionId: "sess_first" }, { status: 201 }));
    const secondFetch = fetchMock(jsonResponse({ sessionId: "sess_second" }, { status: 201 }));
    const session = { appId: "lextract", userId: "user_config" };
    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support-a.example", fetch: firstFetch },
      session,
    );
    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support-b.example", fetch: secondFetch },
      session,
    );

    await expect(
      Promise.all([firstManager.getOrCreateSession(), secondManager.getOrCreateSession()]),
    ).resolves.toEqual([{ sessionId: "sess_first" }, { sessionId: "sess_second" }]);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce managers with different session request bodies", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_dashboard" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_billing" }, { status: 201 }));
    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      {
        appId: "lextract",
        userId: "user_request",
        currentPath: "/dashboard",
        metadata: { tenant: "one" },
      },
    );
    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      {
        appId: "lextract",
        userId: "user_request",
        currentPath: "/settings/billing",
        metadata: { tenant: "two" },
      },
    );

    await expect(
      Promise.all([firstManager.getOrCreateSession(), secondManager.getOrCreateSession()]),
    ).resolves.toEqual([{ sessionId: "sess_dashboard" }, { sessionId: "sess_billing" }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce session creation calls with different abort signals", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      })
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_second_signal" }, { status: 201 }));
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_signal" },
    );

    const firstPromise = manager.getOrCreateSession({ signal: firstController.signal });
    const secondPromise = manager.getOrCreateSession({ signal: secondController.signal });
    firstController.abort();

    await expect(firstPromise).rejects.toThrow("Aborted");
    await expect(secondPromise).resolves.toEqual({ sessionId: "sess_second_signal" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer chat session when an older create request resolves late", async () => {
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_late" },
    );

    const oldPromise = manager.getOrCreateSession();
    const newPromise = manager.startNewChat();
    resolveNew(jsonResponse({ sessionId: "sess_new" }, { status: 201 }));
    await expect(newPromise).resolves.toEqual({ sessionId: "sess_new" });
    resolveOld(jsonResponse({ sessionId: "sess_old" }, { status: 201 }));
    await expect(oldPromise).resolves.toEqual({ sessionId: "sess_old" });

    expect(manager.getSessionId()).toBe("sess_new");
  });

  it("keeps a newer stored chat session when another manager resolves an older create late", async () => {
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const storage = new Map<string, string>();
    const sessionStore = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: storage.delete.bind(storage),
    };
    const session = { appId: "lextract", userId: "user_late_shared" };
    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
      { sessionStore },
    );
    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
      { sessionStore },
    );

    const oldPromise = firstManager.getOrCreateSession();
    const newPromise = secondManager.startNewChat();
    resolveNew(jsonResponse({ sessionId: "sess_new" }, { status: 201 }));
    await expect(newPromise).resolves.toEqual({ sessionId: "sess_new" });
    resolveOld(jsonResponse({ sessionId: "sess_old" }, { status: 201 }));
    await expect(oldPromise).resolves.toEqual({ sessionId: "sess_old" });

    expect(firstManager.getSessionId()).toBe("sess_new");
    expect(secondManager.getSessionId()).toBe("sess_new");
  });

  it("uses global fetch and tolerates invalid global storage", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_global" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("localStorage", null);
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example" },
      { appId: "lextract", userId: "user_global" },
    );

    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_global" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("preserves the current managed session when starting a new chat fails", async () => {
    const storage = new Map<string, string>();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_existing" }, { status: 201 }))
      .mockRejectedValueOnce(new Error("offline"));
    const sessionStore = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: storage.delete.bind(storage),
    };
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_preserve" },
      { sessionStore },
    );

    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_existing" });
    await expect(manager.startNewChat()).rejects.toThrow("offline");
    expect(manager.getSessionId()).toBe("sess_existing");
    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_existing" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses localStorage by default for app support session continuity", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_local" }, { status: 201 }));
    const session = { appId: "lextract", userId: "user_2", currentPath: "/dashboard" };

    const firstManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
    );
    await expect(firstManager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_local" });

    const secondManager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      session,
    );
    expect(secondManager.getSessionId()).toBe("sess_local");
    await expect(secondManager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_local" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("merges base and per-call options when creating managed sessions", async () => {
    const signal = new AbortController().signal;
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_opts" }, { status: 201 }));
    const manager = createAiCsSessionManager(
      {
        baseUrl: "https://support.example",
        fetch: fetchFn,
        headers: { "X-Config": "config" },
        credentials: "include",
      },
      { appId: "lextract", userId: "user_3" },
      {
        headers: { "X-Base": "base" },
        credentials: "same-origin",
      },
    );

    await expect(
      manager.startNewChat({
        signal,
        credentials: "omit",
        headers: { "X-Base": "override", "X-Trace": "trace_1" },
      }),
    ).resolves.toEqual({ sessionId: "sess_opts" });

    const [, init] = fetchFn.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.signal).toBe(signal);
    expect(init.credentials).toBe("omit");
    expect(headers.get("X-Config")).toBe("config");
    expect(headers.get("X-Base")).toBe("override");
    expect(headers.get("X-Trace")).toBe("trace_1");
  });

  it("continues when session storage operations fail", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_unstored" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_unstored" }, { status: 201 }));
    const sessionStore = {
      getItem: (_key: string) => {
        throw new Error("read denied");
      },
      setItem: (_key: string, _value: string) => {
        throw new Error("write denied");
      },
      removeItem: (_key: string) => {
        throw new Error("remove denied");
      },
    };
    const manager = createAiCsSessionManager(
      { baseUrl: "https://support.example", fetch: fetchFn },
      { appId: "lextract", userId: "user_4" },
      { sessionStore },
    );

    await expect(manager.getOrCreateSession()).resolves.toEqual({ sessionId: "sess_unstored" });
    await expect(manager.startNewChat()).resolves.toEqual({ sessionId: "sess_unstored" });
    expect(manager.getSessionId()).toBe("sess_unstored");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("createAiCsWidget", () => {
  const api = { baseUrl: "https://api.example.com" };
  const session = { appId: "test-app", userId: "u1" };

  // Minimal injectable mount adapter: creates a fake [data-aics-root] inside
  // the host so the guard logic has a real DOM node to detect.
  function makeMockAdapter(): {
    adapter: (host: HTMLElement) => { unmount: () => void };
    unmounted: () => boolean;
  } {
    let _unmounted = false;
    return {
      adapter(host: HTMLElement) {
        const root = document.createElement("div");
        root.setAttribute("data-aics-root", "");
        host.appendChild(root);
        return {
          unmount() {
            _unmounted = true;
            root.remove();
          },
        };
      },
      unmounted: () => _unmounted,
    };
  }

  afterEach(() => {
    // Clean up any mounted roots from previous tests.
    for (const el of Array.from(
      document.querySelectorAll("[data-aics-root],[data-aics-mount-host]"),
    )) {
      el.remove();
    }
  });

  it("returns a handle with a destroy method", () => {
    const handle = createAiCsWidget({ api, session });
    expect(typeof handle.destroy).toBe("function");
    handle.destroy();
  });

  it("mounts a host element into the document body", () => {
    const handle = createAiCsWidget({ api, session });
    expect(document.querySelector("[data-aics-mount-host]")).not.toBeNull();
    handle.destroy();
    expect(document.querySelector("[data-aics-mount-host]")).toBeNull();
  });

  it("calls onMounted after mount adapter resolves", async () => {
    const onMounted = vi.fn();
    const { adapter } = makeMockAdapter();
    const handle = createAiCsWidget({ api, session, onMounted, _mountAdapter: adapter });
    // Wait for the microtask queue to drain.
    await Promise.resolve();
    expect(onMounted).toHaveBeenCalled();
    handle.destroy();
  });

  it("destroy before async microtask fires removes the host without throwing", async () => {
    const onMounted = vi.fn();
    const { adapter } = makeMockAdapter();
    const handle = createAiCsWidget({ api, session, onMounted, _mountAdapter: adapter });
    // Destroy synchronously — before the microtask fires.
    handle.destroy();
    expect(document.querySelector("[data-aics-mount-host]")).toBeNull();
    await Promise.resolve();
    // onMounted was never called because destroyed=true bypassed the render.
    expect(onMounted).not.toHaveBeenCalled();
  });

  it("second concurrent call after async gap is blocked by re-check guard", async () => {
    const onMounted = vi.fn();
    const { adapter } = makeMockAdapter();
    const handle = createAiCsWidget({ api, session, onMounted, _mountAdapter: adapter });
    // Simulate the concurrent race: plant a [data-aics-root] before the microtask fires.
    const raceRoot = document.createElement("div");
    raceRoot.setAttribute("data-aics-root", "");
    document.body.appendChild(raceRoot);
    await Promise.resolve();
    // The re-check in .then() should have removed the mount host and not called onMounted.
    expect(document.querySelector("[data-aics-mount-host]")).toBeNull();
    expect(onMounted).not.toHaveBeenCalled();
    raceRoot.remove();
    handle.destroy();
  });

  it("calls unmount on the react root when destroy is called after mount", async () => {
    const { adapter, unmounted } = makeMockAdapter();
    const handle = createAiCsWidget({ api, session, _mountAdapter: adapter });
    await Promise.resolve();
    expect(document.querySelector("[data-aics-root]")).not.toBeNull();
    handle.destroy();
    expect(unmounted()).toBe(true);
    expect(document.querySelector("[data-aics-mount-host]")).toBeNull();
  });

  it("two createAiCsWidget calls produce ONE root (second is a no-op)", () => {
    // Simulate an already-present [data-aics-root] element (as if the React
    // widget has already been mounted and rendered its root element).
    const fakeRoot = document.createElement("div");
    fakeRoot.setAttribute("data-aics-root", "");
    document.body.appendChild(fakeRoot);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = createAiCsWidget({ api, session });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already mounted"));
    // No new mount host should have been created.
    expect(document.querySelectorAll("[data-aics-mount-host]").length).toBe(0);
    // destroy() on the no-op handle must not throw.
    expect(() => handle.destroy()).not.toThrow();
    warnSpy.mockRestore();
    fakeRoot.remove();
  });

  it("destroy removes the host so a subsequent mount works", () => {
    const handle = createAiCsWidget({ api, session });
    expect(document.querySelector("[data-aics-mount-host]")).not.toBeNull();
    handle.destroy();
    expect(document.querySelector("[data-aics-mount-host]")).toBeNull();
    // A fresh call must succeed now (no existing [data-aics-root]).
    const handle2 = createAiCsWidget({ api, session });
    expect(document.querySelector("[data-aics-mount-host]")).not.toBeNull();
    handle2.destroy();
  });

  it("mounts into a custom container when provided", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handle = createAiCsWidget({ api, session, container });
    expect(container.querySelector("[data-aics-mount-host]")).not.toBeNull();
    handle.destroy();
    container.remove();
  });
});

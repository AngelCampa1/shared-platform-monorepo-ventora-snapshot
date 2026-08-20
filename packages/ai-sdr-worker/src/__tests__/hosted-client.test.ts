// @vitest-environment jsdom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedClientGlobalModule, hostedClientModule } from "../hosted-client.js";

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface WidgetOptions {
  api: {
    baseUrl: string;
    fetch: typeof fetch;
    signRequest?: (input: {
      method: string;
      path: string;
      body: unknown;
      serializedBody: string;
    }) => Promise<{ timestamp: string; nonce: string; signature: string }>;
  };
  session: { productId: string; visitorId?: string };
  target: HTMLElement;
  brand?: Record<string, string>;
  copy?: Record<string, unknown>;
  callbacks?: { onEvent?: (event: SseEvent) => void; onError?: (error: Error) => void };
  sessionStore?: Storage;
  analytics?: {
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void };
  };
}

type ApiConfig = WidgetOptions["api"];

interface Widget {
  open(): Promise<void>;
  close(): void;
  destroy(): void;
  isOpen(): boolean;
  getSessionId(): string | null;
  getLastError(): Error | null;
  startNewChat(): Promise<void>;
  handleEvent(event: SseEvent): void;
  requestHandoff(request?: Record<string, unknown>): Promise<unknown>;
}

interface HostedExports {
  createAiSdrWidget(opts: WidgetOptions): Widget;
  createAiSdrSseParser(opts?: {
    onEvent?: (event: SseEvent) => void;
    onError?: (error: Error) => void;
  }): {
    feed(chunk: string): SseEvent[];
    end(): SseEvent[];
    reset(): void;
  };
  createAiSdrSession(
    config: ApiConfig,
    request: { productId: string; visitorId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ sessionId: string }>;
  sendAiSdrChatMessage(
    config: { baseUrl: string; fetch: typeof fetch },
    request: { sessionId: string; message: string },
    options?: { signal?: AbortSignal; onEvent?: (event: SseEvent) => void },
  ): Promise<SseEvent[]>;
  requestAiSdrHandoff(
    config: { baseUrl: string; fetch: typeof fetch },
    request: { sessionId: string },
  ): Promise<{ handoffId: string; status: string }>;
  aiSdrSessionStoreKey(session: { productId: string; visitorId?: string }): string;
  aiSdrInit(config: Record<string, unknown>): Widget;
  AiSdrApiError: new (message: string, status: number) => Error & { status: number };
}

let hosted: HostedExports;

beforeEach(async () => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.removeAttribute("dir");
  window.localStorage.clear();
  // Default tests to mobile breakpoint so aria-modal=true and sibling inerting
  // behave as the v0.3 contract expects. Individual tests may override.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: typeof query === "string" && query.includes("max-width"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  });
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}`
  )) as unknown as HostedExports;
  hosted = module;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sessionFetch(sessionId: string): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ sessionId }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function sseResponse(events: SseEvent[]): Response {
  const body = events
    .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeWidget(overrides: Partial<WidgetOptions> = {}): {
  widget: Widget;
  target: HTMLElement;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const fetchMock = vi.fn<typeof fetch>() as ReturnType<typeof vi.fn>;
  const widget = hosted.createAiSdrWidget({
    api: { baseUrl: "https://worker.example.com", fetch: fetchMock as unknown as typeof fetch },
    session: { productId: "lextract", visitorId: "v1" },
    target,
    ...overrides,
  });
  return { widget, target, fetchMock };
}

describe("hosted-client module", () => {
  it("exports the expected surface", () => {
    expect(typeof hosted.createAiSdrWidget).toBe("function");
    expect(typeof hosted.createAiSdrSseParser).toBe("function");
    expect(typeof hosted.createAiSdrSession).toBe("function");
    expect(typeof hosted.sendAiSdrChatMessage).toBe("function");
    expect(typeof hosted.requestAiSdrHandoff).toBe("function");
    expect(typeof hosted.aiSdrSessionStoreKey).toBe("function");
    expect(typeof hosted.aiSdrInit).toBe("function");
  });

  it("emits a global module that registers window.AiSdr.init and VentoraAiSdr", async () => {
    const globalScript = hostedClientGlobalModule.replace(
      "globalThis.VentoraAiSdr",
      "globalThis.__VentoraTest__ = globalThis.__VentoraTest__ || {};\nglobalThis.__VentoraTest__.VentoraAiSdr",
    );
    // Just check static content
    expect(hostedClientGlobalModule).toContain("globalThis.AiSdr = { init: aiSdrInit }");
    expect(hostedClientGlobalModule).toContain("aiSdrInit");
    expect(globalScript).toContain("__VentoraTest__");
  });

  it("aiSdrSessionStoreKey preserves the legacy key shape", () => {
    expect(hosted.aiSdrSessionStoreKey({ productId: "Lextract", visitorId: "user-1" })).toBe(
      "ventora:ai-sdr:session:lextract:user-1",
    );
    expect(hosted.aiSdrSessionStoreKey({ productId: "" })).toBe(
      "ventora:ai-sdr:session:ventora:anonymous",
    );
  });

  it("AiSdrApiError carries status", () => {
    const error = new hosted.AiSdrApiError("nope", 503);
    expect(error.status).toBe(503);
    expect(error.name).toBe("AiSdrApiError");
  });

  it("attaches signed assertion headers from api.signRequest", async () => {
    const fetchMock = sessionFetch("sess_signed");
    const signRequest = vi.fn(async () => ({
      timestamp: "2026-05-01T00:00:00Z",
      nonce: "nonce-hosted",
      signature: "sig-hosted",
    }));

    await hosted.createAiSdrSession(
      { baseUrl: "https://worker.example.com", fetch: fetchMock, signRequest },
      { productId: "lextract", visitorId: "v1" },
    );

    expect(signRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/sessions",
      body: { productId: "lextract", visitorId: "v1" },
      serializedBody: JSON.stringify({ productId: "lextract", visitorId: "v1" }),
    });
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Timestamp")).toBe("2026-05-01T00:00:00Z");
    expect(headers.get("X-Ventora-Nonce")).toBe("nonce-hosted");
    expect(headers.get("X-Ventora-Signature")).toBe("sig-hosted");
  });
});

describe("SSE parser", () => {
  it("parses framed events and reports invalid frames", () => {
    const errors: Error[] = [];
    const parser = hosted.createAiSdrSseParser({ onError: (error) => errors.push(error) });
    const ok = parser.feed('event: heartbeat\ndata: {"timestamp":"t"}\n\n');
    expect(ok).toEqual([{ event: "heartbeat", data: { timestamp: "t" } }]);
    parser.feed("event: heartbeat\ndata: not-json\n\n");
    expect(errors[0]?.message).toContain("Invalid SSE JSON");
    parser.feed('event: unknown\ndata: {"a":1}\n\n');
    expect(errors[1]?.message).toContain("Invalid AI-SDR SSE event");
    parser.reset();
    expect(parser.feed("")).toEqual([]);
    expect(parser.end()).toEqual([]);
    const last = hosted.createAiSdrSseParser().feed("");
    expect(last).toEqual([]);
  });

  it("flushes a trailing frame on end()", () => {
    const parser = hosted.createAiSdrSseParser();
    parser.feed('event: heartbeat\ndata: {"timestamp":"t"}');
    const flushed = parser.end();
    expect(flushed).toEqual([{ event: "heartbeat", data: { timestamp: "t" } }]);
  });
});

describe("widget rendering", () => {
  it("mounts a clickable launcher at construction without opening the panel or starting a session", () => {
    const { target, fetchMock } = makeWidget();
    // The launcher is the visitor's only entry point, so it must be in the DOM
    // immediately after init — without anyone calling open() first.
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement | null;
    expect(launcher).not.toBeNull();
    expect(launcher?.hidden).toBe(false);
    expect(launcher?.textContent).toBe("Need help?");
    expect(launcher?.getAttribute("aria-expanded")).toBe("false");
    // The panel exists but stays hidden until the launcher is clicked / open() runs.
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel?.hidden).toBe(true);
    // Mounting the launcher must not trigger any network (no session yet).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the panel when the mounted launcher is clicked", async () => {
    const { target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_click" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    launcher.click();
    await vi.waitFor(() => {
      const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
      expect(panel.hidden).toBe(false);
      expect(launcher.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("renders launcher, panel and ARIA structure with brand palette", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute("role")).toBe("region");
    expect(root.style.getPropertyValue("--ai-sdr-accent")).toBe("#b45309");
    expect(root.style.getPropertyValue("--ai-sdr-surface")).toBe("#fffdfa");
    expect(root.style.getPropertyValue("--ai-sdr-text")).toBe("#1d1712");
    expect(root.style.getPropertyValue("--ai-sdr-accent-text")).toBe("#ffffff");
    const launcher = root.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    expect(launcher.getAttribute("aria-haspopup")).toBe("dialog");
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(launcher.hidden).toBe(true);
    const panel = root.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.hidden).toBe(false);
    const transcript = root.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(transcript.getAttribute("role")).toBe("log");
    expect(transcript.getAttribute("aria-live")).toBe("polite");
    expect(transcript.getAttribute("aria-relevant")).toBeNull();
    expect(transcript.getAttribute("aria-busy")).toBe("false");
    const status = root.querySelector("[data-ai-sdr-status]") as HTMLElement;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("role")).toBe("status");
    expect(document.head.querySelector("[data-ai-sdr-styles]")).not.toBeNull();
    expect(widget.isOpen()).toBe(true);
    expect(widget.getSessionId()).toBe("sess_1");
  });

  it("applies every supplied brand preset", async () => {
    for (const productId of ["camaudit", "capveri", "lextract"]) {
      const target = document.createElement("div");
      document.body.appendChild(target);
      const widget = hosted.createAiSdrWidget({
        api: { baseUrl: "https://w", fetch: sessionFetch("sess") },
        session: { productId, visitorId: "v" },
        target,
      });
      await widget.open();
      const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
      expect(root.dataset.aiSdrProduct).toBe(productId);
      expect(root.style.getPropertyValue("--ai-sdr-accent")).not.toBe("");
      widget.destroy();
    }
  });

  it("falls back to title-cased name for unknown product and honors brand overrides", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess") },
      session: { productId: "new-prod", visitorId: "v" },
      target,
      brand: { accentColor: "#abcdef", productName: "Custom Co" } as Record<string, string>,
    });
    await widget.open();
    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root.style.getPropertyValue("--ai-sdr-accent")).toBe("#abcdef");
    expect(root.getAttribute("aria-label")).toContain("Custom Co");
    widget.destroy();
  });

  it("uses ltr/rtl direction from <html dir> and respects prefers-reduced-motion", async () => {
    document.documentElement.setAttribute("dir", "rtl");
    const mql = { matches: true };
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue(mql),
    });
    const reimported = (await import(
      `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}#rtl`
    )) as unknown as HostedExports;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = reimported.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess") },
      session: { productId: "lextract", visitorId: "v" },
      target,
    });
    await widget.open();
    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root.dataset.aiSdrDir).toBe("rtl");
    expect(root.dataset.aiSdrReducedMotion).toBe("");
    widget.destroy();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });
});

describe("widget messaging", () => {
  it("streams assistant messages and surfaces copy/cta/source/handoff banners", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { event: "message.delta", data: { messageId: "m1", delta: "Hello " } },
        { event: "message.delta", data: { messageId: "m1", delta: "world" } },
        { event: "message.done", data: { messageId: "m1" } },
        {
          event: "trial.cta",
          data: { cta: { label: "Start trial", url: "https://example.com/x" } },
        },
        {
          event: "source",
          data: { source: { id: "s1", title: "Pricing", url: "https://example.com/p" } },
        },
        { event: "handoff.requested", data: { handoffId: "h1" } },
      ]),
    );

    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "tell me more";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const userBubble = target.querySelector('[data-ai-sdr-role="user"]') as HTMLElement;
    expect(userBubble.textContent).toBe("tell me more");
    const assistantBubble = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    expect(assistantBubble.dataset.aiSdrMessageText).toBe("Hello world");
    expect(target.querySelector("[data-ai-sdr-cta]")).not.toBeNull();
    const sources = target.querySelector("[data-ai-sdr-sources]") as HTMLElement;
    expect(sources.hidden).toBe(false);
    expect(sources.querySelector("a")?.getAttribute("href")).toBe("https://example.com/p");
    const banner = target.querySelector("[data-ai-sdr-handoff-banner]") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("requested");

    const copyButton = assistantBubble.querySelector("[data-ai-sdr-copy]") as HTMLButtonElement;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith("Hello world");
    widget.destroy();
  });

  it("disables send when empty and supports Enter to send + ArrowUp to recall", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_3" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m1" } }]),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    composer.value = "first";
    composer.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    composer.dispatchEvent(enter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(composer.value).toBe("");
    // ArrowUp on empty restores last user message
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true, bubbles: true }),
    );
    expect(composer.value).toBe("first");
    // Shift+Enter does not submit (no preventDefault path triggered)
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      }),
    );
    expect(composer.value).toBe("first");
    widget.destroy();
  });

  it("renders markdown tables as <table> elements", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_md" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: {
        messageId: "mt",
        delta:
          "Pricing\n\n| Plan | Price |\n| --- | --- |\n| Pro | $99 |\n| Team | $199 |\n\nThanks!",
      },
    });
    const table = target.querySelector("[data-ai-sdr-table]") as HTMLTableElement;
    expect(table).not.toBeNull();
    expect(table.querySelectorAll("thead th").length).toBe(2);
    expect(table.querySelectorAll("tbody tr").length).toBe(2);
    expect(table.querySelector("tbody td")?.textContent).toBe("Pro");
    widget.destroy();
  });

  it("renders bold/italic/link inline markdown", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_inl" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: {
        messageId: "mi",
        delta: "Hello **bold** and *italic* and [link](https://example.com/x)\n\n- one\n- two",
      },
    });
    const assistant = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    expect(assistant.querySelector("strong")?.textContent).toBe("bold");
    expect(assistant.querySelector("em")?.textContent).toBe("italic");
    expect(assistant.querySelector("a")?.getAttribute("href")).toBe("https://example.com/x");
    expect(assistant.querySelectorAll("li").length).toBe(2);
    widget.destroy();
  });

  it("shows a toast and retry on network error and recovers on retry", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_err" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("oops", { status: 500, statusText: "Server Error" }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.hidden).toBe(false);
    expect(widget.getLastError()).not.toBeNull();
    // Retry
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m2" } }]),
    );
    const retry = toast.querySelector("[data-ai-sdr-toast-retry]") as HTMLButtonElement;
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.hidden).toBe(true);
    widget.destroy();
  });

  it("error toast persists until the user dismisses it", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_to" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("oops", { status: 500, statusText: "Server Error" }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.hidden).toBe(false);
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.dataset.aiSdrToastKind).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 6100));
    expect(toast.hidden).toBe(false);
    const dismiss = toast.querySelector("[data-ai-sdr-toast-dismiss]") as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    dismiss.click();
    expect(toast.hidden).toBe(true);
    widget.destroy();
  }, 15000);
});

describe("widget empty state cleanup", () => {
  // Regression: the greeting + suggestion chips rendered by renderEmptyState()
  // used to remain in the transcript DOM forever once real messages arrived,
  // partially occluded behind the conversation. They must be removed as soon
  // as the first real transcript bubble is appended.
  it("shows the empty state greeting and suggestion chips before any message", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_empty" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const empty = target.querySelector("[data-ai-sdr-empty]");
    expect(empty).not.toBeNull();
    expect(target.querySelector("[data-ai-sdr-suggestions]")).not.toBeNull();
    widget.destroy();
  });

  it("removes the empty state once a user message is appended", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_empty_user" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m1" } }]),
    );
    await widget.open();
    expect(target.querySelector("[data-ai-sdr-empty]")).not.toBeNull();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello there";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.querySelector("[data-ai-sdr-empty]")).toBeNull();
    expect(target.querySelector('[data-ai-sdr-role="user"]')?.textContent).toBe("hello there");
    widget.destroy();
  });

  it("removes the empty state once a restored session replays assistant history", async () => {
    window.localStorage.setItem("ventora:ai-sdr:session:lextract:v1", "sess_restored");
    const { widget, target, fetchMock } = makeWidget();
    await widget.open();
    expect(widget.getSessionId()).toBe("sess_restored");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(target.querySelector("[data-ai-sdr-empty]")).not.toBeNull();
    // Simulate the replayed history of a resumed session arriving as assistant
    // events rather than a fresh send — the same append path a real restore uses.
    widget.handleEvent({
      event: "message.delta",
      data: { messageId: "restored-1", delta: "Welcome back" },
    });
    widget.handleEvent({ event: "message.done", data: { messageId: "restored-1" } });
    expect(target.querySelector("[data-ai-sdr-empty]")).toBeNull();
    expect(target.querySelector('[data-ai-sdr-role="assistant"]')?.textContent).toContain(
      "Welcome back",
    );
    widget.destroy();
  });

  it("is idempotent when the empty-state cleanup path runs more than once", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_empty_twice" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(target.querySelector("[data-ai-sdr-empty]")).not.toBeNull();
    expect(() => {
      widget.handleEvent({ event: "message.delta", data: { messageId: "a", delta: "first" } });
      widget.handleEvent({ event: "message.done", data: { messageId: "a" } });
      // A second real bubble arrives after the empty state is already gone —
      // the cleanup call must be a safe no-op the second time around.
      widget.handleEvent({ event: "message.delta", data: { messageId: "b", delta: "second" } });
      widget.handleEvent({ event: "message.done", data: { messageId: "b" } });
    }).not.toThrow();
    expect(target.querySelector("[data-ai-sdr-empty]")).toBeNull();
    expect(target.querySelectorAll('[data-ai-sdr-role="assistant"]').length).toBe(2);
    widget.destroy();
  });
});

describe("widget focus and lifecycle", () => {
  it("Escape closes the panel and returns focus to the launcher", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_focus" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    expect(panel.hidden).toBe(false);
    panel.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // v0.3 close uses an exit animation: panel enters `exiting` state and is
    // hidden after `transitionend`. Dispatch transitionend to finalize.
    expect(panel.dataset.state).toBe("exiting");
    panel.dispatchEvent(new Event("transitionend"));
    expect(panel.hidden).toBe(true);
    expect(launcher.hidden).toBe(false);
    expect(document.activeElement).toBe(launcher);
    widget.destroy();
  });

  it("Tab/Shift-Tab cycles focusables inside the panel (close is the first focusable)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_tab" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    const close = target.querySelector("[data-ai-sdr-close]") as HTMLButtonElement;
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "x";
    composer.dispatchEvent(new Event("input"));
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    send.focus();
    panel.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(close);
    panel.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(send);
    widget.destroy();
  });

  it("destroy aborts pending fetches and tears down DOM", async () => {
    const { widget, target, fetchMock } = makeWidget();
    const seen: { signal: AbortSignal | null } = { signal: null };
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      seen.signal = init.signal ?? null;
      return new Promise((resolve) => {
        init.signal?.addEventListener("abort", () => {
          resolve(new Response("", { status: 499, statusText: "Aborted" }));
        });
      });
    });
    const opening = widget.open().catch(() => undefined);
    widget.destroy();
    await opening;
    expect(seen.signal?.aborted).toBe(true);
    expect(target.querySelector("[data-ai-sdr-widget]")).toBeNull();
  });

  it("startNewChat resets transcript and clears stored session", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_a" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_b" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(window.localStorage.getItem("ventora:ai-sdr:session:lextract:v1")).toBe("sess_a");
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Hi" } });
    expect(target.querySelector('[data-ai-sdr-role="assistant"]')).not.toBeNull();
    await widget.startNewChat();
    expect(target.querySelector('[data-ai-sdr-role="assistant"]')).toBeNull();
    expect(widget.getSessionId()).toBe("sess_b");
    widget.destroy();
  });

  it("re-opens the panel using the stored sessionId without re-fetching", async () => {
    window.localStorage.setItem("ventora:ai-sdr:session:lextract:v1", "sess_cached");
    const { widget, fetchMock } = makeWidget();
    await widget.open();
    expect(widget.getSessionId()).toBe("sess_cached");
    expect(fetchMock).not.toHaveBeenCalled();
    widget.destroy();
  });

  it("reuses a stored sessionId whose timestamp is within the TTL window", async () => {
    window.localStorage.setItem("ventora:ai-sdr:session:lextract:v1", "sess_fresh");
    window.localStorage.setItem("ventora:ai-sdr:session:lextract:v1:ts", String(Date.now() - 1000));
    const { widget, fetchMock } = makeWidget();
    await widget.open();
    expect(widget.getSessionId()).toBe("sess_fresh");
    expect(fetchMock).not.toHaveBeenCalled();
    widget.destroy();
  });

  it("discards a stored sessionId older than the TTL and mints a fresh one", async () => {
    window.localStorage.setItem("ventora:ai-sdr:session:lextract:v1", "sess_stale");
    window.localStorage.setItem(
      "ventora:ai-sdr:session:lextract:v1:ts",
      String(Date.now() - 86_400_001),
    );
    const { widget, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_new" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(widget.getSessionId()).toBe("sess_new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The stale id and its expired timestamp are cleared, then replaced.
    expect(window.localStorage.getItem("ventora:ai-sdr:session:lextract:v1")).toBe("sess_new");
    expect(window.localStorage.getItem("ventora:ai-sdr:session:lextract:v1:ts")).not.toBeNull();
    widget.destroy();
  });

  it("requestHandoff posts and shows banner; reports error on failure", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_h" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ handoffId: "h1", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const response = (await widget.requestHandoff()) as { handoffId: string; status: string };
    expect(response.status).toBe("queued");
    const banner = target.querySelector("[data-ai-sdr-handoff-banner]") as HTMLElement;
    expect(banner.hidden).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500, statusText: "boom" }));
    const onError = vi.fn();
    const fallback = makeWidget({ callbacks: { onError } });
    fallback.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_h2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fallback.fetchMock.mockResolvedValueOnce(
      new Response("no", { status: 500, statusText: "boom" }),
    );
    await fallback.widget.open();
    const result = await fallback.widget.requestHandoff();
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalled();
    widget.destroy();
    fallback.widget.destroy();
  });

  it("launcher click swallows a failed session-create without an unhandled rejection", async () => {
    // Regression: a floating `void widget.open()` leaked the re-thrown
    // "Failed to fetch" as an unhandled rejection (Sentry CAMAUDIT-WEB-V2-6R).
    const onError = vi.fn();
    const { target, fetchMock } = makeWidget({ callbacks: { onError } });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
      launcher.click();

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalled();
        // open() restores the launcher so the visitor can retry.
        expect(launcher.hidden).toBe(false);
      });
      // Flush any pending unhandled-rejection notification.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("close() before open() removes DOM if any", () => {
    const { widget, target } = makeWidget();
    widget.close();
    expect(target.querySelector("[data-ai-sdr-widget]")).toBeNull();
  });

  it("rejects open() when destroyed", async () => {
    const { widget } = makeWidget();
    widget.destroy();
    await expect(widget.open()).rejects.toThrow(/destroyed/);
    await expect(widget.startNewChat()).rejects.toThrow(/destroyed/);
  });

  it("reports session creation errors via callbacks and shows toast", async () => {
    const onError = vi.fn();
    const { widget, target, fetchMock } = makeWidget({ callbacks: { onError } });
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500, statusText: "Bad" }));
    await expect(widget.open()).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.hidden).toBe(false);
    widget.destroy();
  });
});

describe("aiSdrInit wrapper", () => {
  it("creates a widget bound to document.body when no target", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "init_sess" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const widget = hosted.aiSdrInit({
      baseUrl: "https://w.example.com",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "vv" },
      autoOpen: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.querySelector("[data-ai-sdr-widget]")).not.toBeNull();
    widget.destroy();
  });

  it("resolves string target selectors", () => {
    const div = document.createElement("div");
    div.id = "host";
    document.body.appendChild(div);
    const widget = hosted.aiSdrInit({
      baseUrl: "https://w",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "v" },
      target: "#host",
    });
    expect(widget).toBeTruthy();
    widget.destroy();
  });

  it("throws when config is not an object", () => {
    expect(() => hosted.aiSdrInit(null as unknown as Record<string, unknown>)).toThrow();
  });

  it("double init returns the same widget instance without mounting a second root", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w1 = hosted.aiSdrInit({
      baseUrl: "https://w.example.com",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "vv" },
    });
    const w2 = hosted.aiSdrInit({
      baseUrl: "https://w.example.com",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "vv2" },
    });
    expect(w1).toBe(w2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/init called more than once/));
    const roots = document.querySelectorAll("[data-ai-sdr-widget]");
    expect(roots.length).toBe(1);
    w1.destroy();
  });

  it("teardown via destroy clears the guard so a new init works", () => {
    const w1 = hosted.aiSdrInit({
      baseUrl: "https://w.example.com",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "v1" },
    });
    w1.destroy();
    const w2 = hosted.aiSdrInit({
      baseUrl: "https://w.example.com",
      productId: "lextract",
      session: { productId: "lextract", visitorId: "v2" },
    });
    expect(w2).not.toBe(w1);
    expect(document.querySelectorAll("[data-ai-sdr-widget]").length).toBe(1);
    w2.destroy();
  });
});

describe("session helpers", () => {
  it("createAiSdrSession rejects on bad response shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      hosted.createAiSdrSession(
        { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
        { productId: "p" },
      ),
    ).rejects.toThrow();
  });

  it("sendAiSdrChatMessage throws AiSdrApiError on non-ok responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "no" }), {
        status: 400,
        statusText: "Bad",
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      hosted.sendAiSdrChatMessage(
        { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
        { sessionId: "s", message: "hi" },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("sendAiSdrChatMessage uses HTTP status text when an error body is malformed JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{", {
        status: 500,
        statusText: "Server Error",
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      hosted.sendAiSdrChatMessage(
        { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
        { sessionId: "s", message: "hi" },
      ),
    ).rejects.toMatchObject({
      name: "AiSdrApiError",
      status: 500,
      message: "Server Error",
    });
  });

  it("requestAiSdrHandoff returns parsed response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ handoffId: "h", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const response = await hosted.requestAiSdrHandoff(
      { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      { sessionId: "s" },
    );
    expect(response).toEqual({ handoffId: "h", status: "queued" });
  });
});

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastVsWhite(hex: string): number {
  const lum = relativeLuminance(hex);
  return (1.0 + 0.05) / (lum + 0.05);
}

describe("security and accessibility hardening", () => {
  it("rejects markdown links with non-http(s)/mailto schemes (XSS)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_xss" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: {
        messageId: "x1",
        delta:
          "Click [evil](javascript:alert(1)) and [data](data:text/html,foo) and [ok](https://example.com/safe)",
      },
    });
    const assistant = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    const anchors = assistant.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    const safe = anchors[0] as HTMLAnchorElement;
    expect(safe.getAttribute("href")).toBe("https://example.com/safe");
    expect(safe.getAttribute("target")).toBe("_blank");
    expect(safe.getAttribute("rel")).toBe("noopener noreferrer");
    expect(assistant.textContent).toContain("[evil](javascript:alert(1))");
    expect(assistant.textContent).toContain("[data](data:text/html,foo)");
    widget.destroy();
  });

  it("source links are rejected when scheme is unsafe and carry target/rel when safe", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_src" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "source",
      data: { source: { title: "Bad", url: "javascript:alert(1)" } },
    });
    widget.handleEvent({
      event: "source",
      data: { source: { title: "Pricing", url: "https://example.com/p" } },
    });
    const list = target.querySelector("[data-ai-sdr-sources]") as HTMLElement;
    const links = list.querySelectorAll("a");
    expect(links.length).toBe(1);
    const link = links[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/p");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    widget.destroy();
  });

  it("trial.cta is dropped when url scheme is unsafe", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_cta" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Bad", url: "javascript:alert(1)" } },
    });
    expect(target.querySelector("[data-ai-sdr-cta]")).toBeNull();
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Good", url: "https://example.com/x" } },
    });
    const cta = target.querySelector("[data-ai-sdr-cta]") as HTMLAnchorElement;
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toBe("noopener noreferrer");
    widget.destroy();
  });

  it("panel is a real modal with aria-modal=true and siblings marked inert/aria-hidden", async () => {
    const sibling = document.createElement("section");
    sibling.id = "sibling-content";
    document.body.appendChild(sibling);
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_modal" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(sibling.getAttribute("aria-hidden")).toBe("true");
    expect(sibling.hasAttribute("inert")).toBe(true);
    widget.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
    widget.destroy();
  });

  it("document-level Escape and Tab trap work from outside the panel", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_trap" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    // Escape from document root
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // v0.3: close drives an exit transition. Finalize via transitionend.
    expect(panel.dataset.state).toBe("exiting");
    panel.dispatchEvent(new Event("transitionend"));
    expect(panel.hidden).toBe(true);
    widget.destroy();
  });

  it("Tab on document with focus outside panel pulls focus into the panel", async () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_pull" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    outside.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    // The close button is now the first focusable element in the header, so it
    // is where the trap pulls focus to.
    const close = target.querySelector("[data-ai-sdr-close]") as HTMLButtonElement;
    expect(document.activeElement).toBe(close);
    widget.destroy();
  });

  it("focus is restored to previously focused element on close", async () => {
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);
    const { widget, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_restore" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.close();
    expect(document.activeElement).toBe(before);
    widget.destroy();
  });

  it("focus is restored on destroy when widget was open", async () => {
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.appendChild(before);
    before.focus();
    const { widget, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_destroy_focus" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.destroy();
    expect(document.activeElement).toBe(before);
  });

  it("focus is restored on open() failure", async () => {
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.appendChild(before);
    before.focus();
    const onError = vi.fn();
    const { widget, fetchMock } = makeWidget({ callbacks: { onError } });
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500, statusText: "Bad" }));
    await expect(widget.open()).rejects.toThrow();
    expect(document.activeElement).toBe(before);
    widget.destroy();
  });

  it("keeps the launcher in the DOM but hidden while panel is open", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_launcher" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    expect(launcher.hidden).toBe(true);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    widget.destroy();
  });

  it("CSS uses dvh units and safe-area inset for mobile composer", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    expect(style.textContent).toContain("100dvh");
    expect(style.textContent).toContain("env(safe-area-inset-bottom)");
    expect(style.textContent).toContain("min-width:44px");
    expect(style.textContent).toContain("min-height:44px");
    // The dead `position:relative` duplicate on [data-ai-sdr-panel] was
    // intentionally removed during the v0.3 polish pass — only the
    // `position:fixed` declaration remains.
    expect(style.textContent).not.toContain("position:relative");
    expect(style.textContent).toContain("--ai-sdr-bubble-assistant-bg");
    expect(style.textContent).toContain("--ai-sdr-composer-bg");
    widget.destroy();
  });

  it("composer input background derives from tokens via color-mix when --ai-sdr-composer-bg is unset", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    expect(style.textContent).toContain(
      "background:var(--ai-sdr-composer-bg, color-mix(in srgb, var(--ai-sdr-text) 4%, var(--ai-sdr-surface)))",
    );
    // The hardcoded white fallback must no longer be the default for [data-ai-sdr-input].
    const inputRuleStart = style.textContent?.indexOf("[data-ai-sdr-input]{") ?? -1;
    expect(inputRuleStart).toBeGreaterThan(-1);
    const inputRuleEnd = (style.textContent?.indexOf("}", inputRuleStart) ?? -1) + 1;
    const inputRule = style.textContent?.slice(inputRuleStart, inputRuleEnd) ?? "";
    expect(inputRule).not.toContain("#ffffff");
    widget.destroy();
  });

  it("status region announces only on message.done (not during streaming)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_live" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const status = target.querySelector("[data-ai-sdr-status]") as HTMLElement;
    widget.handleEvent({ event: "message.delta", data: { messageId: "m", delta: "Hello " } });
    expect(status.textContent).toBe("");
    widget.handleEvent({ event: "message.delta", data: { messageId: "m", delta: "world" } });
    expect(status.textContent).toBe("");
    widget.handleEvent({ event: "message.done", data: { messageId: "m" } });
    expect(status.textContent).toContain("Assistant responded");
    widget.destroy();
  });

  it("pending 'Thinking…' bubble is removed on message.delta and not on heartbeat/source", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_pending" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.querySelector("[data-ai-sdr-pending]")).not.toBeNull();
    // heartbeat should not clear pending
    widget.handleEvent({ event: "heartbeat", data: { timestamp: "t" } });
    expect(target.querySelector("[data-ai-sdr-pending]")).not.toBeNull();
    // source arriving first must NOT clear pending (no message bytes yet)
    widget.handleEvent({
      event: "source",
      data: { source: { title: "x", url: "https://example.com/" } },
    });
    expect(target.querySelector("[data-ai-sdr-pending]")).not.toBeNull();
    // handoff.requested also does not clear pending
    widget.handleEvent({ event: "handoff.requested", data: { handoffId: "h1" } });
    expect(target.querySelector("[data-ai-sdr-pending]")).not.toBeNull();
    // message.delta clears pending
    widget.handleEvent({ event: "message.delta", data: { messageId: "m", delta: "Hi" } });
    expect(target.querySelector("[data-ai-sdr-pending]")).toBeNull();
    widget.destroy();
  });

  it("startNewChat clears lastUserMessage so ArrowUp does not leak", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_aa" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m" } }]),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_bb" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "first message";
    composer.dispatchEvent(new Event("input"));
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await widget.startNewChat();
    composer.value = "";
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    );
    expect(composer.value).toBe("");
    widget.destroy();
  });

  it("composer aria-describedby points to a node that always exists", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_desc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const describedById = composer.getAttribute("aria-describedby");
    expect(describedById).not.toBeNull();
    expect(document.getElementById(describedById as string)).not.toBeNull();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m", delta: "hi" } });
    expect(document.getElementById(describedById as string)).not.toBeNull();
    widget.destroy();
  });

  it("empty markdown list items are skipped", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_empty_li" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: { messageId: "ml", delta: "- one\n-   \n- two\n- " },
    });
    const items = target.querySelectorAll('[data-ai-sdr-role="assistant"] li');
    expect(items.length).toBe(2);
    widget.destroy();
  });

  it("two concurrent widgets do not inert each other's roots and share sibling inert state", async () => {
    const sibling = document.createElement("section");
    sibling.id = "shared-sibling";
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_a" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = makeWidget();
    b.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_b" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    await b.widget.open();
    const rootA = a.target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    const rootB = b.target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    // Neither widget's own target/root was inerted by the other
    expect(a.target.hasAttribute("inert")).toBe(false);
    expect(b.target.hasAttribute("inert")).toBe(false);
    expect(rootA.hasAttribute("inert")).toBe(false);
    expect(rootB.hasAttribute("inert")).toBe(false);
    // Shared sibling is inert (acquired twice)
    expect(sibling.hasAttribute("inert")).toBe(true);
    // Both panels are operable (not inert)
    const panelA = a.target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    const panelB = b.target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(panelA.hidden).toBe(false);
    expect(panelB.hidden).toBe(false);
    a.widget.destroy();
    b.widget.destroy();
  });

  it("closing widget A while B is still open leaves B operable and sibling still inert", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "a1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = makeWidget();
    b.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "b1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    await b.widget.open();
    const rootB = b.target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    a.widget.close();
    expect(rootB.hasAttribute("inert")).toBe(false);
    expect(sibling.hasAttribute("inert")).toBe(true);
    b.widget.destroy();
    a.widget.destroy();
  });

  it("after both widgets close in any order, sibling returns to pre-A state", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "a2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = makeWidget();
    b.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "b2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    await b.widget.open();
    b.widget.close();
    a.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
    a.widget.destroy();
    b.widget.destroy();
  });

  it("preserves a sibling that was already inert before any widget opened", async () => {
    const sibling = document.createElement("section");
    sibling.setAttribute("inert", "");
    sibling.setAttribute("aria-hidden", "true");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "a3" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = makeWidget();
    b.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "b3" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    await b.widget.open();
    a.widget.close();
    b.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(sibling.getAttribute("aria-hidden")).toBe("true");
    a.widget.destroy();
    b.widget.destroy();
  });

  it("widget B mounted inside an ancestor that widget A inerted is operable and the ancestor is no longer inert", async () => {
    // Scenario (d) from the inert registry contract: ancestor-clear pass.
    const divX = document.createElement("div");
    divX.id = "divX";
    document.body.appendChild(divX);

    // Widget A mounts directly under document.body (default init target).
    const fetchA = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_a_scd" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const a = hosted.createAiSdrWidget({
      api: { baseUrl: "https://worker.example.com", fetch: fetchA as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "vA" },
      target: document.body,
    });
    await a.open();
    // divX is a body-level sibling of A's root, so A inerts it.
    expect(divX.hasAttribute("inert")).toBe(true);

    // Widget B mounts inside divX.
    const fetchB = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_b_scd" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = hosted.createAiSdrWidget({
      api: { baseUrl: "https://worker.example.com", fetch: fetchB as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "vB" },
      target: divX,
    });
    await b.open();

    // Ancestor-clear pass removed divX from any inert holder.
    expect(divX.hasAttribute("inert")).toBe(false);
    expect(divX.getAttribute("aria-hidden")).toBeNull();
    const rootB = divX.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    const panelB = divX.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(rootB.hasAttribute("inert")).toBe(false);
    expect(panelB.hasAttribute("inert")).toBe(false);
    expect(panelB.hidden).toBe(false);

    // Close B — divX restore is a no-op because it was force-uninerted from A's holder.
    b.close();
    expect(divX.hasAttribute("inert")).toBe(false);
    expect(divX.getAttribute("aria-hidden")).toBeNull();

    // Close A — divX returns to its pre-A state (was not inert, no aria-hidden).
    a.close();
    expect(divX.hasAttribute("inert")).toBe(false);
    expect(divX.getAttribute("aria-hidden")).toBeNull();

    a.destroy();
    b.destroy();
  });

  it("pins modality-weakening tradeoff: an unrelated child of divX is not inert while B is open", async () => {
    const divX = document.createElement("div");
    document.body.appendChild(divX);
    const unrelated = document.createElement("button");
    unrelated.type = "button";
    unrelated.textContent = "unrelated";
    divX.appendChild(unrelated);

    const fetchA = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_a_pin" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const a = hosted.createAiSdrWidget({
      api: { baseUrl: "https://worker.example.com", fetch: fetchA as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "vAp" },
      target: document.body,
    });
    await a.open();
    expect(divX.hasAttribute("inert")).toBe(true);

    const fetchB = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_b_pin" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = hosted.createAiSdrWidget({
      api: { baseUrl: "https://worker.example.com", fetch: fetchB as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "vBp" },
      target: divX,
    });
    await b.open();

    // Contract: ancestor-clear drops divX's inert entirely, so the unrelated
    // child of divX (NOT part of B's subtree) is operable. This documents the
    // deliberate modality-weakening tradeoff in aiSdrClearInertOnAncestors.
    expect(divX.hasAttribute("inert")).toBe(false);
    expect(unrelated.hasAttribute("inert")).toBe(false);
    expect(unrelated.closest("[inert]")).toBeNull();

    a.destroy();
    b.destroy();
  });

  it("three-widget shuffle (open A, B, C; close in mixed order) leaves DOM clean", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sa" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const b = makeWidget();
    b.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sb" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const c = makeWidget();
    c.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    await b.widget.open();
    await c.widget.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    // Close in mixed order: B, A, C.
    b.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(true);
    c.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
    a.widget.destroy();
    b.widget.destroy();
    c.widget.destroy();
  });

  it("re-opening the same widget does not leak inert state", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ro1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ro2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await a.widget.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
    await a.widget.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
    a.widget.destroy();
  });

  it("destroy() called while panel is open restores inert siblings", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sd" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.destroy();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
  });

  it("re-applies the inert attribute on close when the sibling was originally inert", async () => {
    // Regression: SDR previously dropped inert on release when prevInert was true,
    // leaving an originally-inert sibling exposed after the widget closed.
    const sibling = document.createElement("section");
    sibling.setAttribute("inert", "");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "preserve-inert" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.close();
    expect(sibling.hasAttribute("inert")).toBe(true);
    a.widget.destroy();
    expect(sibling.hasAttribute("inert")).toBe(true);
  });

  it("populates the shared inertHolders Set with Element instances (not arrays)", async () => {
    // Regression: SDR used to add Array<Element> entries to the cross-widget
    // Symbol.for("ventora.chat.inertHolders") Set, which mismatched the CS
    // widget's Element-typed entries and crashed cross-widget iteration.
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "holders-shape" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    const holders = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("ventora.chat.inertHolders")
    ];
    expect(holders instanceof Set).toBe(true);
    const holderSet = holders as Set<unknown>;
    expect(holderSet.size).toBeGreaterThan(0);
    expect(Array.from(holderSet).every((entry) => entry instanceof Element)).toBe(true);
    expect(holderSet.has(sibling)).toBe(true);
    a.widget.destroy();
    expect((holders as Set<unknown>).has(sibling)).toBe(false);
  });

  it("opens with panel data-state=open after rAF and exits with data-state=exiting", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "anim_sess" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(panel.dataset.state).toBe("open");
    widget.close();
    expect(panel.dataset.state).toBe("exiting");
    panel.dispatchEvent(new Event("transitionend"));
    expect(panel.hidden).toBe(true);
    expect(panel.dataset.state).toBeUndefined();
    widget.destroy();
  });

  it("renders the typing indicator (three bouncing dots) while a send is pending", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "typ" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const typing = target.querySelector("[data-ai-sdr-typing]") as HTMLElement;
    expect(typing).not.toBeNull();
    expect(typing.querySelectorAll("span").length).toBe(3);
    expect(typing.getAttribute("aria-label")).toBe("Assistant is typing");
    widget.destroy();
  });

  it("IME composition Enter does not submit", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "ime" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "こんにちは";
    composer.dispatchEvent(new Event("input"));
    composer.dispatchEvent(new CompositionEvent("compositionstart"));
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(composer.value).toBe("こんにちは");
    composer.dispatchEvent(new CompositionEvent("compositionend"));
    // After composition ends, isComposing=false; Enter now submits
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m" } }]),
    );
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(composer.value).toBe("");
    widget.destroy();
  });

  it("Enter while keyCode=229 (IME) is a no-op", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "ime229" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello";
    composer.dispatchEvent(new Event("input"));
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }),
    );
    expect(composer.value).toBe("hello");
    widget.destroy();
  });

  it("disabled-while-sending: composer is readOnly, aria-busy, send shows spinner+label", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "rdo" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(composer.readOnly).toBe(true);
    expect(composer.getAttribute("aria-busy")).toBe("true");
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send.textContent).toContain("Sending");
    widget.destroy();
  });

  it("status-branched errors: 429 message and no retry button", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "429s" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "rate" }), {
        status: 429,
        statusText: "Too Many",
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "ping";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.textContent).toContain("too quickly");
    expect(toast.querySelector("[data-ai-sdr-toast-retry]")).toBeNull();
    widget.destroy();
  });

  it("status-branched errors: 401 offers Start new chat action", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "401s" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "exp" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "401s_new" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "ping";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.textContent).toContain("session expired");
    const action = toast.querySelector("[data-ai-sdr-toast-action]") as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(action.textContent).toBe("Start new chat");
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(widget.getSessionId()).toBe("401s_new");
    widget.destroy();
  });

  it.each([403, 410])(
    "status-branched errors: %i also classifies as session-expired with Start new chat",
    async (status) => {
      const { widget, target, fetchMock } = makeWidget();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: `s_${status}` }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "gone" }), {
          status,
          statusText: "Gone",
          headers: { "Content-Type": "application/json" },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: `s_${status}_new` }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await widget.open();
      const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
      composer.value = "ping";
      composer.dispatchEvent(new Event("input"));
      const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
      expect(toast.textContent).toContain("session expired");
      expect(toast.querySelector("[data-ai-sdr-toast-retry]")).toBeNull();
      const action = toast.querySelector("[data-ai-sdr-toast-action]") as HTMLButtonElement;
      expect(action).not.toBeNull();
      expect(action.textContent).toBe("Start new chat");
      action.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(widget.getSessionId()).toBe(`s_${status}_new`);
      widget.destroy();
    },
  );

  it("session-expired Start new chat resets the transcript (distinct from silent 404 recovery)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "exp_old" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // First send succeeds and leaves an assistant bubble in the transcript.
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { event: "message.delta", data: { messageId: "m1", delta: "hello" } },
        { event: "message.done", data: { messageId: "m1" } },
      ]),
    );
    // Second send returns 401 — session expired.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "exp" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      }),
    );
    // startNewChat mints a fresh session.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "exp_new" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    composer.value = "first";
    composer.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(transcript.querySelectorAll("[data-ai-sdr-bubble]").length).toBeGreaterThan(0);

    composer.value = "second";
    composer.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    const action = toast.querySelector("[data-ai-sdr-toast-action]") as HTMLButtonElement;
    expect(action.textContent).toBe("Start new chat");
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A fresh session AND an emptied transcript — not the silent 404 path that
    // preserves the conversation.
    expect(widget.getSessionId()).toBe("exp_new");
    const after = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(after.querySelectorAll("[data-ai-sdr-bubble]").length).toBe(0);
    widget.destroy();
  });

  it("malformed SSE mid-stream: reports via onError, no crash, stream ends, composer re-enabled", async () => {
    const onError = vi.fn();
    const { widget, target, fetchMock } = makeWidget({ callbacks: { onError } });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "mal" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // A valid delta, then a malformed-JSON frame, then a structurally-invalid
    // event that fails isAiSdrSseEvent — all in one stream body.
    const body =
      `event: message.delta\ndata: {"messageId":"m1","delta":"hi"}\n\n` +
      "event: message.delta\ndata: {bad json\n\n" +
      `event: unknown\ndata: {"a":1}\n\n`;
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "ping";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The parser surfaced the malformed frame as an error.
    expect(onError).toHaveBeenCalled();
    // The widget did not crash: the panel is still mounted and the composer is
    // re-enabled (not wedged in a disabled/sending state).
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(transcript).not.toBeNull();
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(false);
    expect(transcript.getAttribute("aria-busy")).toBe("false");
    // No assistant bubble is left stuck in the streaming state.
    expect(transcript.querySelector("[data-ai-sdr-streaming]")).toBeNull();
    // The user can send again afterwards (state is not wedged).
    expect(widget.getSessionId()).toBe("mal");
    widget.destroy();
  });

  it("status-branched errors: TypeError fetch surfaces offline message", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "off" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => {
      throw new TypeError("Failed to fetch");
    });
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "ping";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.textContent).toContain("offline");
    widget.destroy();
  });

  it("empty state renders title, body, and two suggestion chips; chip click sends", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "em" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "message.done", data: { messageId: "m" } }]),
    );
    await widget.open();
    expect(target.querySelector("[data-ai-sdr-empty-title]")).not.toBeNull();
    expect(target.querySelector("[data-ai-sdr-empty-body]")).not.toBeNull();
    const chips = target.querySelectorAll("[data-ai-sdr-suggestion]");
    expect(chips.length).toBe(2);
    (chips[0] as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const userBubble = target.querySelector('[data-ai-sdr-role="user"]') as HTMLElement;
    expect(userBubble.textContent).toBe("What does it cost?");
    widget.destroy();
  });

  it("retired GrantPipe uses generic suggestions", async () => {
    const { widget, target, fetchMock } = makeWidget({
      session: { productId: "grantpipe", visitorId: "v1" },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "gp_suggestions" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await widget.open();

    const chips = Array.from(target.querySelectorAll("[data-ai-sdr-suggestion]")).map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["What does it cost?", "How do I get started?"]);
    widget.destroy();
  });

  it("retired GrantPipe uses the generic brand fallback", async () => {
    const { widget, target, fetchMock } = makeWidget({
      session: { productId: "grantpipe", visitorId: "v1" },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "gp_generic_brand" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await widget.open();

    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root.dataset.aiSdrProduct).toBe("grantpipe");
    expect(root.style.getPropertyValue("--ai-sdr-accent")).toBe("#0f172a");
    expect(root.style.getPropertyValue("--ai-sdr-surface")).toBe("#f8fafc");
    expect(root.getAttribute("aria-label")).toContain("Grantpipe");
    widget.destroy();
  });

  it("lead.captured records privacy-safe analytics, shows no UI, and forwards the full event", async () => {
    const capture = vi.fn();
    const onEvent = vi.fn();
    const { widget, target } = makeWidget({
      analytics: { posthog: { capture } },
      callbacks: { onEvent },
    });
    const before = target.innerHTML;
    widget.handleEvent({
      event: "lead.captured",
      data: { leadId: "lead-123", status: "qualified" },
    });
    // Analytics fires with the status enum only — never the lead id or any PII.
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_lead_captured",
      expect.objectContaining({ status: "qualified" }),
    );
    const props = capture.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(props).not.toHaveProperty("leadId");
    expect(props).not.toHaveProperty("name");
    expect(props).not.toHaveProperty("email");
    expect(props).not.toHaveProperty("company");
    expect(JSON.stringify(props)).not.toContain("lead-123");
    // visitorId IS expected here — it is the anonymous session identifier that
    // rides on every widget analytics event, not lead PII. Do not add a
    // not.toHaveProperty("visitorId") assertion: it is allowed by design.
    expect(props.visitorId).toBe("v1");
    // No visible UI changes — the visitor never asked to be saved.
    expect(target.innerHTML).toBe(before);
    // Embedders still receive the full event verbatim.
    expect(onEvent).toHaveBeenCalledWith({
      event: "lead.captured",
      data: { leadId: "lead-123", status: "qualified" },
    });
    widget.destroy();
  });

  it("sticky-bottom: when user has scrolled up, new assistant message renders the new-messages pill", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "stk" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    // Force a "scrolled up" geometry: scrollHeight > scrollTop + clientHeight + 24
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.dispatchEvent(new Event("scroll"));
    widget.handleEvent({ event: "message.delta", data: { messageId: "n", delta: "Hi there" } });
    const pill = target.querySelector("[data-ai-sdr-new-messages]") as HTMLButtonElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain("new");
    expect(pill.getAttribute("aria-label")).toBe("Jump to latest messages");
    pill.click();
    expect(target.querySelector("[data-ai-sdr-new-messages]")).toBeNull();
    widget.destroy();
  });

  it("close button renders an inline SVG cross icon (not a text glyph)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "svg" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const close = target.querySelector("[data-ai-sdr-close]") as HTMLButtonElement;
    expect(close.querySelector("svg")).not.toBeNull();
    widget.destroy();
  });

  it("stylesheet contains v0.3 design tokens, dark-mode, forced-colors, suggestion chip styling", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    expect(css).toContain("--ai-sdr-space-1");
    expect(css).toContain("--ai-sdr-radius-pill");
    expect(css).toContain("--ai-sdr-motion-base");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("data-ai-sdr-suggestion");
    expect(css).toContain("data-ai-sdr-typing");
    expect(css).toContain("@keyframes ai-sdr-bubble-in");
    expect(css).toContain("@keyframes ai-sdr-typing");
    expect(css).toContain("@media (max-width:640px)");
    expect(css).toContain("env(safe-area-inset-top)");
    expect(css).toContain("font-size:16px");
    // Scoped reduced-motion only nukes transform+animation (not color transitions)
    expect(css).toContain(
      "[data-ai-sdr-widget][data-ai-sdr-reduced-motion] *{transform:none !important;animation:none !important;}",
    );
    // The only allowed transition:none is the stop-button reduced-motion override
    expect(css).toContain(
      "[data-ai-sdr-widget][data-ai-sdr-reduced-motion] [data-ai-sdr-stop-generating]{transition:none !important;}",
    );
    widget.destroy();
  });

  it("stylesheet guards every [hidden]-toggled element whose rule sets display, so native [hidden] hiding is not overridden by author CSS", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    expect(css).toContain("[data-ai-sdr-launcher][hidden]{display:none;}");
    expect(css).toContain("[data-ai-sdr-panel][hidden]{display:none;}");
    expect(css).toContain("[data-ai-sdr-transcript][hidden]{display:none;}");
    expect(css).toContain("[data-ai-sdr-sources][hidden]{display:none;}");
    expect(css).toContain("[data-ai-sdr-loading][hidden]{display:none;}");
    widget.destroy();
  });

  it("stylesheet renders sources list as flex-wrap pill chips (no disc bullets)", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    // sources container: no disc, flex layout
    expect(css).toContain("[data-ai-sdr-sources]");
    expect(css).toContain("list-style:none");
    expect(css).toContain("display:flex");
    expect(css).toContain("flex-wrap:wrap");
    // source item: inline-flex
    expect(css).toContain("[data-ai-sdr-source-item]");
    expect(css).toContain("display:inline-flex");
    // chip anchor: pill shape + no underline
    expect(css).toContain("border-radius:9999px");
    expect(css).toContain("text-decoration:none");
    // chip anchor: color via accent
    expect(css).toContain("color:var(--ai-sdr-accent)");
    widget.destroy();
  });

  it("source event with safe url renders anchor with pill chip; unsafe url renders plain text", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_src_pill" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "source",
      data: { source: { title: "Docs", url: "https://example.com/docs" } },
    });
    widget.handleEvent({
      event: "source",
      data: { source: { title: "Plain item", url: "javascript:void(0)" } },
    });
    const list = target.querySelector("[data-ai-sdr-sources]") as HTMLElement;
    expect(list.hidden).toBe(false);
    // safe url → anchor with correct href/rel/target
    const anchor = list.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://example.com/docs");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor.textContent).toBe("Docs");
    // unsafe url → plain text inside li, no anchor
    const items = list.querySelectorAll("[data-ai-sdr-source-item]");
    expect(items.length).toBe(2);
    const plainItem = items[1] as HTMLElement;
    expect(plainItem.querySelector("a")).toBeNull();
    expect(plainItem.textContent).toBe("Plain item");
    widget.destroy();
  });

  it("transcript aria-live toggles to off during streaming and back to polite on message.done", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_live_toggle" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(transcript.getAttribute("aria-live")).toBe("polite");
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Hi" } });
    expect(transcript.getAttribute("aria-live")).toBe("off");
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: " there" } });
    expect(transcript.getAttribute("aria-live")).toBe("off");
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    expect(transcript.getAttribute("aria-live")).toBe("polite");
    widget.destroy();
  });

  it("streaming bubble carries data-ai-sdr-streaming attribute that is removed on message.done", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_caret" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "mc", delta: "Hi" } });
    const bubble = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    expect(bubble.hasAttribute("data-ai-sdr-streaming")).toBe(true);
    widget.handleEvent({ event: "message.done", data: { messageId: "mc" } });
    expect(bubble.hasAttribute("data-ai-sdr-streaming")).toBe(false);
    widget.destroy();
  });

  it("incremental delta appends a text node without rebuilding the prior DOM", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_inc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "mi", delta: "Hello" } });
    const body = target.querySelector("[data-ai-sdr-bubble-body]") as HTMLElement;
    const firstChild = body.firstChild;
    widget.handleEvent({ event: "message.delta", data: { messageId: "mi", delta: " world" } });
    expect(body.firstChild).toBe(firstChild);
    expect(body.textContent).toBe("Hello world");
    widget.destroy();
  });

  it("first delta rebuilds (empty oldText) and message.done renders the final block-level markdown", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_rebuild" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: { messageId: "mr", delta: "- a\n- b" },
    });
    widget.handleEvent({ event: "message.done", data: { messageId: "mr" } });
    const bubble = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    expect(bubble.querySelectorAll("li").length).toBe(2);
    widget.destroy();
  });

  it("mid-stream pill renders on delta when user has scrolled away", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_pill" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.dispatchEvent(new Event("scroll"));
    widget.handleEvent({ event: "message.delta", data: { messageId: "mp", delta: "Hi" } });
    expect(target.querySelector("[data-ai-sdr-new-messages]")).not.toBeNull();
    // Second delta should NOT duplicate the pill
    widget.handleEvent({ event: "message.delta", data: { messageId: "mp", delta: " there" } });
    expect(target.querySelectorAll("[data-ai-sdr-new-messages]").length).toBe(1);
    widget.destroy();
  });

  it("copy action announces 'Copied to clipboard' on the status region", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_copy_announce" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "cm", delta: "Hi" } });
    widget.handleEvent({ event: "message.done", data: { messageId: "cm" } });
    const bubble = target.querySelector('[data-ai-sdr-role="assistant"]') as HTMLElement;
    const copy = bubble.querySelector("[data-ai-sdr-copy]") as HTMLButtonElement;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    copy.click();
    await new Promise((r) => setTimeout(r, 0));
    const status = target.querySelector("[data-ai-sdr-status]") as HTMLElement;
    expect(status.textContent).toBe("Copied to clipboard");
    widget.destroy();
  });

  it("header shows the v0.3 subtitle by default and respects an empty override", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_sub" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const subtitle = target.querySelector("[data-ai-sdr-subtitle]");
    expect(subtitle?.textContent).toContain("Replies in seconds");
    widget.destroy();

    const override = document.createElement("div");
    document.body.appendChild(override);
    const w2 = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess_no") },
      session: { productId: "lextract", visitorId: "v" },
      target: override,
      subtitle: "",
    } as unknown as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await w2.open();
    expect(override.querySelector("[data-ai-sdr-subtitle]")).toBeNull();
    w2.destroy();
  });

  it("suggestions group has role=group and aria-label", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_grp" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const group = target.querySelector("[data-ai-sdr-suggestions]") as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Suggested questions");
    widget.destroy();
  });

  it("typing dots indicator does not carry role=status (no double-announce with statusRegion)", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_typ_aria" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const typing = target.querySelector("[data-ai-sdr-typing]") as HTMLElement;
    expect(typing.getAttribute("role")).toBeNull();
    expect(typing.getAttribute("aria-live")).toBe("off");
    widget.destroy();
  });

  it("offline banner appears on offline event and clears on online; send disabled while offline", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_off" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    expect(target.querySelector("[data-ai-sdr-offline-banner]")).not.toBeNull();
    expect(send.disabled).toBe(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
    expect(target.querySelector("[data-ai-sdr-offline-banner]")).toBeNull();
    expect(send.disabled).toBe(false);
    widget.destroy();
  });

  it("offline listeners are removed on close (no leak after teardown)", async () => {
    const { widget, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_off2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.close();
    // After close, offline event should not produce a banner on the now-detached root.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    expect(document.querySelector("[data-ai-sdr-offline-banner]")).toBeNull();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    widget.destroy();
  });

  it("aria-modal is false on desktop when sibling inerting is skipped", async () => {
    // Override matchMedia to never match max-width (desktop viewport)
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      })),
    });
    const reimported = (await import(
      `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}#desktop`
    )) as unknown as HostedExports;
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_desk" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const widget = reimported.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target,
    });
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    // Desktop keeps the panel non-modal because sibling inerting is not applied.
    expect(panel.getAttribute("aria-modal")).toBe("false");
    // Sibling inerting is still only applied on mobile breakpoint
    expect(sibling.hasAttribute("inert")).toBe(false);
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    outside.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const dispatched = outside.dispatchEvent(event);
    expect(dispatched).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
    widget.destroy();
  });

  it("updates modal and inert state when the viewport crosses the mobile breakpoint", async () => {
    let mobile = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: mobile && query.includes("max-width"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      })),
    });
    const reimported = (await import(
      `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}#responsive-modal`
    )) as unknown as HostedExports;
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_resize_modal" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const widget = reimported.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target,
    });

    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(sibling.hasAttribute("inert")).toBe(false);

    mobile = true;
    window.dispatchEvent(new Event("resize"));
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(sibling.getAttribute("aria-hidden")).toBe("true");

    mobile = false;
    window.dispatchEvent(new Event("resize"));
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.getAttribute("aria-hidden")).toBeNull();
    widget.destroy();
  });

  it("shared inert registry ref-counts across symbol-shared scope (simulated cross-widget)", async () => {
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const registry = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("ventora.chat.inertRegistry")
    ];
    // Pre-condition: a fresh suite begins with an empty (or absent) registry
    expect(registry === undefined || registry instanceof WeakMap).toBe(true);
    const a = makeWidget();
    a.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "regA" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await a.widget.open();
    // Now the registry is populated; verify the ref-count entry exists.
    const sharedRegistry = (
      globalThis as unknown as Record<
        symbol,
        | WeakMap<
            Element,
            { refCount: number; prevInert: boolean | null; prevAriaHidden: string | null }
          >
        | undefined
      >
    )[Symbol.for("ventora.chat.inertRegistry")];
    expect(sharedRegistry).toBeDefined();
    expect(sharedRegistry instanceof WeakMap).toBe(true);
    const entry = sharedRegistry?.get(sibling);
    expect(entry?.refCount).toBe(1);
    expect(entry).toHaveProperty("prevInert");
    expect(entry).toHaveProperty("prevAriaHidden");
    expect(entry?.prevInert).toBe(false);
    expect(entry?.prevAriaHidden).toBeNull();
    a.widget.destroy();
    // After destroy the entry is cleared
    const after = sharedRegistry?.get(sibling);
    expect(after).toBeUndefined();
  });

  it("widget styles emit v0.3-polish tokens, classes, and feature blocks", async () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    expect(css).toContain("box-sizing:border-box");
    expect(css).toContain("--ai-sdr-stick-threshold");
    expect(css).toContain("--ai-sdr-focus-ring");
    expect(css).toContain("--ai-sdr-focus-outline");
    expect(css).toContain(".ai-sdr-sr-only");
    expect(css).toContain("data-ai-sdr-pill");
    expect(css).toContain("data-ai-sdr-subtitle");
    expect(css).toContain("data-ai-sdr-streaming");
    expect(css).toContain("@keyframes ai-sdr-caret");
    expect(css).toContain("@supports not (background: color-mix(in srgb, red, blue))");
    expect(css).toContain("scrollbar-width:thin");
    expect(css).toContain("overflow-wrap:anywhere");
    widget.destroy();
  });

  it("brand palette accents meet WCAG AA 4.5:1 against white", () => {
    const palette: Record<string, string> = {
      camaudit: "#1f5a52",
      capveri: "#4f46e5",
      lextract: "#b45309",
    };
    for (const [name, hex] of Object.entries(palette)) {
      const ratio = contrastVsWhite(hex);
      expect(ratio, `${name} (${hex}) contrast`).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set(Object.values(palette)).size).toBe(Object.keys(palette).length);
  });
});

describe("Cycle-1 UI/UX fixes", () => {
  it("copy override: missing keys fall back to defaults, extra keys are ignored", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess_copy") },
      session: { productId: "lextract", visitorId: "v" },
      target,
      copy: { send: "Enviar", extraKey: "ignored" } as Record<string, unknown>,
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await widget.open();
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(send.textContent).toBe("Enviar");
    const placeholder = (target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement)
      .placeholder;
    expect(placeholder).toContain("Lextract");
    const hintEl = target.querySelector("[data-ai-sdr-composer-hint]") as HTMLElement;
    expect(hintEl).not.toBeNull();
    expect(hintEl.textContent).toContain("Press Enter");
    widget.destroy();
  });

  it("copy override: custom subtitle, composerHint, offlineBanner, emptyHeading, emptySuggestions", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess_copy2") },
      session: { productId: "lextract", visitorId: "v2" },
      target,
      copy: {
        subtitle: "Custom subtitle",
        composerHint: "Type and press Enter",
        offlineBanner: "No connection",
        emptyHeading: "Hello from {productName}",
        emptySuggestions: ["Option A", "Option B"],
      },
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await widget.open();
    const subtitleEl = target.querySelector("[data-ai-sdr-subtitle]") as HTMLElement;
    expect(subtitleEl.textContent).toBe("Custom subtitle");
    const hintEl = target.querySelector("[data-ai-sdr-composer-hint]") as HTMLElement;
    expect(hintEl.textContent).toBe("Type and press Enter");
    const chips = target.querySelectorAll("[data-ai-sdr-suggestion]");
    expect(chips.length).toBe(2);
    expect((chips[0] as HTMLButtonElement).textContent).toBe("Option A");
    const titleEl = target.querySelector("[data-ai-sdr-empty-title]") as HTMLElement;
    expect(titleEl.textContent).toBe("Hello from Lextract");
    widget.destroy();
  });

  it("copy override: null/non-object copy falls back to all defaults", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess_copy3") },
      session: { productId: "lextract", visitorId: "v3" },
      target,
      copy: null as unknown as Record<string, unknown>,
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await widget.open();
    const send = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(send.textContent).toBe("Send");
    widget.destroy();
  });

  it("jump-to-latest pill has data attribute set and RTL widget has dir attribute", async () => {
    document.documentElement.setAttribute("dir", "rtl");
    const reimported = (await import(
      `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}#rtl-pill`
    )) as unknown as HostedExports;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = reimported.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("sess_pill") },
      session: { productId: "lextract", visitorId: "vp" },
      target,
    });
    await widget.open();
    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root.dataset.aiSdrDir).toBe("rtl");
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.dispatchEvent(new Event("scroll"));
    widget.handleEvent({ event: "message.delta", data: { messageId: "pm", delta: "hi" } });
    const pill = target.querySelector("[data-ai-sdr-new-messages]") as HTMLButtonElement;
    expect(pill).not.toBeNull();
    widget.destroy();
    document.documentElement.removeAttribute("dir");
  });

  it("CSS: new status color vars present, dark override scoped, reduced-motion block present", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    expect(css).toContain("--ai-sdr-error-bg:#7f1d1d");
    expect(css).toContain("--ai-sdr-error-text:#ffffff");
    expect(css).toContain("--ai-sdr-warning-bg:rgba(245,158,11,.15)");
    expect(css).toContain("--ai-sdr-warning-text:#92400e");
    expect(css).toContain("--ai-sdr-offline-bg:color-mix");
    expect(css).toContain("--ai-sdr-offline-text:var(--ai-sdr-text)");
    expect(css).toContain("--ai-sdr-composer-max-height:120px");
    expect(css).toContain(":not([data-ai-sdr-theme])");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(
      "[data-ai-sdr-send] svg,[data-ai-sdr-typing] span{animation:none !important;}",
    );
    expect(css).toContain("[data-ai-sdr-streaming]::after{animation:none !important;}");
    expect(css).toContain("[data-ai-sdr-bubble-actions]{display:flex");
    expect(css).toContain("opacity:0.35");
    expect(css).toContain("[data-ai-sdr-composer-hint]");
    expect(css).toContain("font-size:11px");
    expect(css).toContain("inset-inline-end:var(--ai-sdr-space-3)");
    expect(css).toContain("max-height:var(--ai-sdr-composer-max-height,120px)");
    widget.destroy();
  });

  it("error type → copy key: network error uses errorNetwork, session expired uses errorSessionExpired, generic uses errorGeneric", async () => {
    const target1 = document.createElement("div");
    document.body.appendChild(target1);
    const fetchNetwork = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "en" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockImplementationOnce(() => {
        throw new TypeError("Failed to fetch");
      });
    const wNet = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchNetwork as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "en" },
      target: target1,
      copy: { errorNetwork: "Offline custom" },
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await wNet.open();
    const comp1 = target1.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    comp1.value = "hi";
    comp1.dispatchEvent(new Event("input"));
    (target1.querySelector("[data-ai-sdr-composer]") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const toastNet = target1.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toastNet.textContent).toContain("Offline custom");
    wNet.destroy();

    const target2 = document.createElement("div");
    document.body.appendChild(target2);
    const fetchSession = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "es" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("exp", { status: 401, statusText: "Unauth" }));
    const wSess = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchSession as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "es" },
      target: target2,
      copy: { errorSessionExpired: "Session custom" },
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await wSess.open();
    const comp2 = target2.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    comp2.value = "hi";
    comp2.dispatchEvent(new Event("input"));
    (target2.querySelector("[data-ai-sdr-composer]") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const toastSess = target2.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toastSess.textContent).toContain("Session custom");
    wSess.destroy();

    const target3 = document.createElement("div");
    document.body.appendChild(target3);
    const fetchGeneric = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "eg" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("err", { status: 500, statusText: "Server Error" }));
    const wGen = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchGeneric as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "eg" },
      target: target3,
      copy: { errorGeneric: "Generic custom" },
    } as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await wGen.open();
    const comp3 = target3.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    comp3.value = "hi";
    comp3.dispatchEvent(new Event("input"));
    (target3.querySelector("[data-ai-sdr-composer]") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const toastGen = target3.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toastGen.textContent).toContain("Generic custom");
    wGen.destroy();
  });
});

describe("Cycle-2 UI/UX fixes", () => {
  it("z-index is 2147483646", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    expect(style.textContent).toContain("z-index:2147483646");
    widget.destroy();
  });

  it("panel open animation uses cubic-bezier(.18,.95,.32,1) at 200ms", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    const css = style.textContent ?? "";
    expect(css).toContain("cubic-bezier(.18,.95,.32,1)");
    expect(css).toContain("200ms cubic-bezier(.18,.95,.32,1)");
    widget.destroy();
  });

  it("bubble-in animation is 170ms ease-out", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const style = document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement;
    expect(style.textContent).toContain("animation:ai-sdr-bubble-in 170ms ease-out");
    widget.destroy();
  });

  it("reduced-motion block includes streaming caret suppression separately", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("[data-ai-sdr-streaming]::after{animation:none !important;}");
    widget.destroy();
  });

  it("stop-generating button is hidden initially and shown while streaming, then hidden again", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sg1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    await widget.open();
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    expect(stopBtn).not.toBeNull();
    expect(stopBtn.dataset.visible).toBeUndefined();
    expect(stopBtn.getAttribute("aria-hidden")).toBe("true");
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopBtn.dataset.visible).toBe("");
    expect(stopBtn.getAttribute("aria-hidden")).toBe("false");
    widget.destroy();
  });

  it("stop-generating button click aborts in-flight stream and re-enables composer without error toast", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sg2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let abortCalled = false;
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          abortCalled = true;
          const err = new DOMException("AbortError", "AbortError");
          reject(err);
        });
      });
    });
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopBtn.dataset.visible).toBe("");
    stopBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abortCalled).toBe(true);
    expect(composer.readOnly).toBe(false);
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.hidden).toBe(true);
    expect(stopBtn.dataset.visible).toBeUndefined();
    expect(stopBtn.getAttribute("aria-hidden")).toBe("true");
    widget.destroy();
  });

  it("loading state shown before session ready, hidden after session resolves", async () => {
    const { widget, target, fetchMock } = makeWidget();
    let resolveSession!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        }),
    );
    const opening = widget.open().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const loadingEl = target.querySelector("[data-ai-sdr-loading]") as HTMLElement;
    expect(loadingEl).not.toBeNull();
    expect(loadingEl.hidden).toBe(false);
    expect(loadingEl.getAttribute("role")).toBe("status");
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    expect(transcript.hidden).toBe(true);
    resolveSession(
      new Response(JSON.stringify({ sessionId: "ld1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await opening;
    expect(loadingEl.hidden).toBe(true);
    expect(transcript.hidden).toBe(false);
    widget.destroy();
  });

  it("unread count increments with each new message when scrolled away, reset on reaching bottom", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "uc1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.dispatchEvent(new Event("scroll"));
    widget.handleEvent({ event: "message.delta", data: { messageId: "u1", delta: "msg1" } });
    let pill = target.querySelector("[data-ai-sdr-new-messages]") as HTMLButtonElement;
    expect(pill.textContent).toContain("1");
    widget.handleEvent({ event: "message.delta", data: { messageId: "u2", delta: "msg2" } });
    pill = target.querySelector("[data-ai-sdr-new-messages]") as HTMLButtonElement;
    expect(pill.textContent).toContain("2");
    pill.click();
    expect(target.querySelector("[data-ai-sdr-new-messages]")).toBeNull();
    widget.destroy();
  });

  it("empty suggestions array renders no suggestions container", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("es1") },
      session: { productId: "lextract", visitorId: "v" },
      target,
      copy: { emptySuggestions: [] },
    } as unknown as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await widget.open();
    expect(target.querySelector("[data-ai-sdr-suggestions]")).toBeNull();
    widget.destroy();
  });

  it("suggestion chips CSS has white-space:nowrap and text-overflow:ellipsis", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("white-space:nowrap");
    expect(css).toContain("text-overflow:ellipsis");
    widget.destroy();
  });

  it("bubble max-width uses min(88%,34rem) and overflow-wrap:anywhere", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("max-width:min(88%,34rem)");
    expect(css).toContain("overflow-wrap:anywhere");
    widget.destroy();
  });

  it("failed bubble gets data-ai-sdr-failed and inline retry; retry re-sends without duplicating bubble", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "fb1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("err", { status: 500, statusText: "Server Error" }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const userBubbles = target.querySelectorAll('[data-ai-sdr-role="user"]');
    expect(userBubbles.length).toBe(1);
    const failedBubble = userBubbles[0] as HTMLElement;
    expect(failedBubble.hasAttribute("data-ai-sdr-failed")).toBe(true);
    const inlineRetry = failedBubble.querySelector(
      "[data-ai-sdr-inline-retry]",
    ) as HTMLButtonElement;
    expect(inlineRetry).not.toBeNull();
    // Now retry succeeds
    fetchMock.mockResolvedValueOnce(
      new Response(`${JSON.stringify({ event: "message.done", data: { messageId: "mr" } })}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(`event: message.done\ndata: ${JSON.stringify({ messageId: "mr" })}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    inlineRetry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No duplicate bubble
    expect(target.querySelectorAll('[data-ai-sdr-role="user"]').length).toBe(1);
    widget.destroy();
  });

  it("copy keys stopGenerating, loading, newMessages with {count} merge with defaults", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: sessionFetch("ck1") },
      session: { productId: "lextract", visitorId: "v" },
      target,
      copy: {
        stopGenerating: "Custom stop",
        loading: "Custom loading",
        newMessages: "{count} unread",
        send: "Custom send",
      },
    } as unknown as Parameters<typeof hosted.createAiSdrWidget>[0]);
    await widget.open();
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    expect(stopBtn.textContent).toBe("Custom stop");
    const loadingEl = target.querySelector("[data-ai-sdr-loading]") as HTMLElement;
    expect(loadingEl.getAttribute("aria-label")).toBe("Custom loading");
    // Verify send copy was also merged
    const sendBtn = target.querySelector("[data-ai-sdr-send]") as HTMLButtonElement;
    expect(sendBtn.textContent).toBe("Custom send");
    widget.destroy();
  });

  it("loading state CSS present and stop-generating CSS has correct touch target", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("[data-ai-sdr-loading]");
    expect(css).toContain("[data-ai-sdr-stop-generating]");
    expect(css).toContain("[data-ai-sdr-bubble][data-ai-sdr-failed]");
    expect(css).toContain("[data-ai-sdr-inline-retry]");
    widget.destroy();
  });
});

describe("Cycle 3 polish — panel exit animation", () => {
  it("exiting state CSS is present with canonical cubic-bezier timing and correct terminal transform", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain('[data-ai-sdr-panel][data-state="exiting"]');
    expect(css).toContain("translateY(8px) scale(.98)");
    expect(css).toContain("cubic-bezier(.18,.95,.32,1)");
    widget.destroy();
  });

  it("hidden (closed) panel is non-interactive and removed from layout/a11y so it cannot overlay the launcher or page", () => {
    // Regression: the closed panel kept display:flex (author style beats the UA
    // [hidden]{display:none}) and was hidden only via opacity:0. With the
    // launcher mounted eagerly at construction, that invisible but still
    // pointer-interactive fixed panel overlaid the launcher and page content,
    // silently swallowing clicks. The closed state must be pointer-events:none
    // and visibility:hidden; the open state restores both.
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    // Base (closed) rule: non-interactive and visually/a11y hidden.
    expect(css).toMatch(/\[data-ai-sdr-panel\]\{[^}]*pointer-events:none;[^}]*\}/);
    expect(css).toMatch(/\[data-ai-sdr-panel\]\{[^}]*visibility:hidden;[^}]*\}/);
    // Open state restores interactivity and visibility.
    expect(css).toContain(
      '[data-ai-sdr-panel][data-state="open"]{transform:none;opacity:1;visibility:visible;pointer-events:auto;}',
    );
    // Exiting state stays visible to fade out but must not capture clicks.
    expect(css).toContain(
      '[data-ai-sdr-panel][data-state="exiting"]{transform:translateY(8px) scale(.98);opacity:0;visibility:visible;pointer-events:none;}',
    );
    widget.destroy();
  });

  it("close() sets dataset.state=exiting then finalizes after transitionend", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "exit_anim" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    widget.close();
    expect(panel.dataset.state).toBe("exiting");
    expect(panel.hidden).toBe(false);
    panel.dispatchEvent(new Event("transitionend"));
    expect(panel.hidden).toBe(true);
    widget.destroy();
  });

  it("close() finalizes after timeout fallback when transitionend never fires", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "exit_timeout" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    widget.close();
    expect(panel.dataset.state).toBe("exiting");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(panel.hidden).toBe(true);
    widget.destroy();
  }, 10000);

  it("reduced-motion: close() hides panel immediately without waiting for transitionend", async () => {
    const mql = { matches: true };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue(mql),
    });
    const reimported = (await import(
      `data:text/javascript;base64,${Buffer.from(hostedClientModule).toString("base64")}#exit-rm`
    )) as unknown as HostedExports;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "exit_rm" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const widget = reimported.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target,
    });
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    widget.close();
    // reduced-motion: panel hidden immediately, no exiting state
    expect(panel.hidden).toBe(true);
    widget.destroy();
  });
});

describe("Cycle 3 polish — stop-button transition CSS", () => {
  it("stop-button CSS uses opacity+transform transition with canonical timing", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("[data-ai-sdr-stop-generating]");
    expect(css).toContain("opacity");
    expect(css).toContain("cubic-bezier(.18,.95,.32,1)");
    expect(css).toContain("[data-ai-sdr-stop-generating][data-visible]");
    widget.destroy();
  });

  it("reduced-motion removes stop-button opacity/transform transition", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain(
      "[data-ai-sdr-widget][data-ai-sdr-reduced-motion] [data-ai-sdr-stop-generating]{transition:none !important;}",
    );
    widget.destroy();
  });
});

describe("Cycle 3 polish — stop-button focus handling", () => {
  it("focus moves to composer when stream ends while stop-button is focused", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "stop_focus" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let abortCalled = false;
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          abortCalled = true;
          reject(new DOMException("AbortError", "AbortError"));
        });
      });
    });
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Simulate stop button having focus
    stopBtn.focus();
    expect(document.activeElement).toBe(stopBtn);
    stopBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abortCalled).toBe(true);
    // Focus should have moved to composer, not lost to body
    expect(document.activeElement).toBe(composer);
    widget.destroy();
  });

  it("focus stays on composer if stop button is not focused when stream ends", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "stop_nofocus" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("AbortError", "AbortError"));
        });
      });
    });
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Focus is on composer (not stop button)
    composer.focus();
    stopBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Focus should still be on composer
    expect(document.activeElement).toBe(composer);
    widget.destroy();
  });
});

describe("Cycle 3 polish — abort controller cleanup", () => {
  it("close() aborts in-flight stream and resets stop+loading state for clean reopen", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "abort_close" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let abortSignal: AbortSignal | null = null;
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      abortSignal = init.signal ?? null;
      return new Promise(() => undefined);
    });
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopBtn.dataset.visible).toBe("");
    widget.close();
    expect((abortSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(stopBtn.dataset.visible).toBeUndefined();
    widget.destroy();
  });

  it("destroy() aborts in-flight stream and is idempotent when no stream active", async () => {
    const { widget, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "abort_destroy" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let abortSignal: AbortSignal | null = null;
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      abortSignal = init.signal ?? null;
      return new Promise(() => undefined);
    });
    await widget.open();
    const composer = document.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    if (composer !== null) {
      composer.value = "hi";
      composer.dispatchEvent(new Event("input"));
      const form = document.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
      if (form !== null) {
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    widget.destroy();
    expect((abortSignal as AbortSignal | null)?.aborted).toBe(true);
    // destroy again should not throw
    expect(() => widget.destroy()).not.toThrow();
  });

  it("reopen after close() starts clean: unreadCount is reset, stopButton not visible", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "reopen1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const panel = target.querySelector("[data-ai-sdr-panel]") as HTMLElement;
    widget.close();
    panel.dispatchEvent(new Event("transitionend"));
    // Reopen
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "reopen2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    expect(stopBtn.dataset.visible).toBeUndefined();
    expect(stopBtn.getAttribute("aria-hidden")).toBe("true");
    widget.destroy();
  });
});

describe("Cycle 3 polish — structural neutrals use color-mix from --ai-sdr-text", () => {
  it("no stray rgba(15,23,42) in structural border/shadow/surface rules", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    // These structural rules must use color-mix, not hardcoded rgba(15,23,42,...)
    expect(css).toContain(
      "box-shadow:0 8px 24px color-mix(in srgb, var(--ai-sdr-text) 18%, transparent)",
    );
    expect(css).toContain(
      "box-shadow:0 12px 30px color-mix(in srgb, var(--ai-sdr-text) 22%, transparent)",
    );
    expect(css).toContain(
      "box-shadow:0 24px 60px color-mix(in srgb, var(--ai-sdr-text) 24%, transparent)",
    );
    expect(css).toContain(
      "border:1px solid color-mix(in srgb, var(--ai-sdr-text) 20%, transparent)",
    );
    expect(css).toContain("background:color-mix(in srgb, var(--ai-sdr-text) 5%, transparent)");
    expect(css).toContain(
      "border-top:1px solid color-mix(in srgb, var(--ai-sdr-text) 8%, transparent)",
    );
    expect(css).toContain(
      "border:1px solid color-mix(in srgb, var(--ai-sdr-text) 15%, transparent)",
    );
    // Fallback @supports block and var() fallbacks are exempt — verify they remain
    expect(css).toContain("rgba(15,23,42,.06)");
    widget.destroy();
  });

  it("dark-mode block uses color-mix for border/divider rules", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain("border-color:color-mix(in srgb, var(--ai-sdr-text) 14%, transparent)");
    expect(css).toContain(
      "border-top-color:color-mix(in srgb, var(--ai-sdr-text) 8%, transparent)",
    );
    widget.destroy();
  });
});

describe("Cycle 3 polish — assistant bubble accent tint", () => {
  it("default assistant bubble bg uses accent-tinted derivation", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain(
      "--ai-sdr-bubble-assistant-bg:color-mix(in srgb, var(--ai-sdr-accent) 6%, var(--ai-sdr-surface))",
    );
    widget.destroy();
  });

  it("dark-mode assistant bubble bg is accent-tinted", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    // Dark-mode block should also set the accent tint formula
    const darkIdx = css.indexOf("prefers-color-scheme: dark");
    const darkBlock = css.slice(darkIdx, darkIdx + 400);
    expect(darkBlock).toContain(
      "color-mix(in srgb, var(--ai-sdr-accent) 6%, var(--ai-sdr-surface))",
    );
    widget.destroy();
  });

  it("assistant bubble has a subtle card border (sibling parity with AI-CS)", () => {
    const { widget } = makeWidget();
    void widget.open().catch(() => undefined);
    const css =
      (document.head.querySelector("[data-ai-sdr-styles]") as HTMLStyleElement).textContent ?? "";
    expect(css).toContain(
      "border:1px solid color-mix(in srgb, var(--ai-sdr-text) 8%, transparent)",
    );
    widget.destroy();
  });
});

describe("Cycle 3 polish — iconUrl launcher slot", () => {
  it("renders default SVG text when no iconUrl is provided", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "icon_default" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    expect(launcher.querySelector("img")).toBeNull();
    expect(launcher.textContent).toContain("Need help?");
    widget.destroy();
  });

  it("renders <img> in launcher when iconUrl is provided", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "icon_url" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target,
      brand: { iconUrl: "https://example.com/logo.svg" } as Record<string, string>,
    });
    await widget.open();
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    const img = launcher.querySelector("img[data-ai-sdr-launcher-icon]") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain("logo.svg");
    expect(img.alt).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(launcher.textContent?.trim()).toBe("Need help?");
    widget.destroy();
  });

  it("ignores empty string iconUrl and falls back to text", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "icon_empty" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const widget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: fetchMock as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target,
      brand: { iconUrl: "" } as Record<string, string>,
    });
    await widget.open();
    const launcher = target.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    expect(launcher.querySelector("img")).toBeNull();
    expect(launcher.textContent).toContain("Need help?");
    widget.destroy();
  });

  it("blocks unsafe iconUrl schemes (javascript:, data:) and accepts https", async () => {
    for (const unsafeUrl of ["javascript:alert(1)", "data:image/svg+xml,<svg/>"]) {
      const t = document.createElement("div");
      document.body.appendChild(t);
      const fm = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "icon_unsafe" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const w = hosted.createAiSdrWidget({
        api: { baseUrl: "https://w", fetch: fm as unknown as typeof fetch },
        session: { productId: "lextract", visitorId: "v" },
        target: t,
        brand: { iconUrl: unsafeUrl } as Record<string, string>,
      });
      await w.open();
      const launcher = t.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
      expect(launcher.querySelector("img"), `img must not be rendered for ${unsafeUrl}`).toBeNull();
      expect(launcher.textContent).toContain("Need help?");
      w.destroy();
    }

    // Safe https URL must render the img
    const safeTarget = document.createElement("div");
    document.body.appendChild(safeTarget);
    const safeFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "icon_safe_https" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const safeWidget = hosted.createAiSdrWidget({
      api: { baseUrl: "https://w", fetch: safeFetch as unknown as typeof fetch },
      session: { productId: "lextract", visitorId: "v" },
      target: safeTarget,
      brand: { iconUrl: "https://cdn.example.com/icon.png" } as Record<string, string>,
    });
    await safeWidget.open();
    const safeLauncher = safeTarget.querySelector("[data-ai-sdr-launcher]") as HTMLButtonElement;
    const safeImg = safeLauncher.querySelector(
      "img[data-ai-sdr-launcher-icon]",
    ) as HTMLImageElement;
    expect(safeImg).not.toBeNull();
    expect(safeImg.src).toContain("icon.png");
    safeWidget.destroy();
  });
});

describe("Cycle 4 polish — failed-retry bubble persistence", () => {
  it("composerHint element carries aria-hidden=true so screen readers skip the decorative hint", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "hint_aria" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const hint = target.querySelector("[data-ai-sdr-composer-hint]") as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    widget.destroy();
  });

  it("data-ai-sdr-theme is set on root so branded instances opt out of dark-mode block", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "theme_attr" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    const root = target.querySelector("[data-ai-sdr-widget]") as HTMLElement;
    expect(root.hasAttribute("data-ai-sdr-theme")).toBe(true);
    widget.destroy();
  });

  it("on repeat send failure, the SAME user bubble retains data-ai-sdr-failed and inline retry", async () => {
    const { widget, target, fetchMock } = makeWidget();
    // Session creation
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "retry_persist" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // First send fails
    fetchMock.mockResolvedValueOnce(
      new Response("err", { status: 500, statusText: "Server Error" }),
    );
    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello retry";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One user bubble exists and is marked failed with inline retry
    const userBubbles = target.querySelectorAll('[data-ai-sdr-role="user"]');
    expect(userBubbles.length).toBe(1);
    const originalBubble = userBubbles[0] as HTMLElement;
    expect(originalBubble.hasAttribute("data-ai-sdr-failed")).toBe(true);
    const firstInlineRetry = originalBubble.querySelector(
      "[data-ai-sdr-inline-retry]",
    ) as HTMLButtonElement;
    expect(firstInlineRetry).not.toBeNull();

    // Second send (via inline retry click) also fails
    fetchMock.mockResolvedValueOnce(
      new Response("err2", { status: 500, statusText: "Server Error" }),
    );
    firstInlineRetry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still exactly one user bubble (the original, no duplicate)
    const bubblesAfterRetry = target.querySelectorAll('[data-ai-sdr-role="user"]');
    expect(bubblesAfterRetry.length).toBe(1);

    // The same original bubble still has the failed decoration (the bug: previously it was lost)
    expect(originalBubble.hasAttribute("data-ai-sdr-failed")).toBe(true);
    const secondInlineRetry = originalBubble.querySelector(
      "[data-ai-sdr-inline-retry]",
    ) as HTMLButtonElement;
    expect(secondInlineRetry).not.toBeNull();

    widget.destroy();
  });
});

describe("plan.recommendation event rendering", () => {
  it("renders reason and priceSummary into the transcript when both are present", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_plan_1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();

    widget.handleEvent({
      event: "plan.recommendation",
      data: {
        recommendation: {
          planId: "pro",
          reason: "Best fit for your team size",
          confidence: 0.92,
          priceSummary: "$99/mo per seat",
        },
      },
    });

    const card = target.querySelector("[data-ai-sdr-plan-recommendation]") as HTMLElement;
    expect(card).not.toBeNull();
    const reasonEl = card.querySelector("[data-ai-sdr-plan-reason]") as HTMLElement;
    expect(reasonEl).not.toBeNull();
    expect(reasonEl.textContent).toBe("Best fit for your team size");
    const priceEl = card.querySelector("[data-ai-sdr-plan-price]") as HTMLElement;
    expect(priceEl).not.toBeNull();
    expect(priceEl.textContent).toBe("$99/mo per seat");

    widget.destroy();
  });

  it("renders only reason when priceSummary is absent", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_plan_2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();

    widget.handleEvent({
      event: "plan.recommendation",
      data: {
        recommendation: {
          planId: "starter",
          reason: "Good entry point for solo users",
        },
      },
    });

    const card = target.querySelector("[data-ai-sdr-plan-recommendation]") as HTMLElement;
    expect(card).not.toBeNull();
    const reasonEl = card.querySelector("[data-ai-sdr-plan-reason]") as HTMLElement;
    expect(reasonEl).not.toBeNull();
    expect(reasonEl.textContent).toBe("Good entry point for solo users");
    const priceEl = card.querySelector("[data-ai-sdr-plan-price]");
    expect(priceEl).toBeNull();

    widget.destroy();
  });

  it("renders plan.recommendation via SSE stream alongside other events", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_plan_3" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { event: "message.delta", data: { messageId: "mp1", delta: "Here is a plan for you." } },
        { event: "message.done", data: { messageId: "mp1" } },
        {
          event: "plan.recommendation",
          data: {
            recommendation: {
              planId: "team",
              reason: "Scales well for growing teams",
              priceSummary: "$199/mo",
            },
          },
        },
      ]),
    );

    await widget.open();
    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "which plan suits me?";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = target.querySelector("[data-ai-sdr-plan-recommendation]") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-ai-sdr-plan-reason]")?.textContent).toBe(
      "Scales well for growing teams",
    );
    expect(card.querySelector("[data-ai-sdr-plan-price]")?.textContent).toBe("$199/mo");

    widget.destroy();
  });
});

describe("session recovery on 404", () => {
  it("transparently recovers when first /v1/chat 404s: mints new session and retries", async () => {
    const onError = vi.fn();
    const { widget, target, fetchMock } = makeWidget({ callbacks: { onError } });

    // 1. Widget open: session creation succeeds with a stale id.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "stale_sess" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(widget.getSessionId()).toBe("stale_sess");

    // 2. First /v1/chat call: worker has evicted the session, returns 404.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      }),
    );

    // 3. Recovery: new session creation returns a fresh id.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "fresh_sess" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // 4. Retried /v1/chat with the new id: succeeds.
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { event: "message.delta", data: { messageId: "r1", delta: "Recovered reply" } },
        { event: "message.done", data: { messageId: "r1" } },
      ]),
    );

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => {
      const assistant = target.querySelector(
        '[data-ai-sdr-role="assistant"]',
      ) as HTMLElement | null;
      expect(assistant).not.toBeNull();
      expect(assistant?.dataset.aiSdrMessageText).toBe("Recovered reply");
    });

    // Widget should now carry the new session id, not the stale one.
    expect(widget.getSessionId()).toBe("fresh_sess");
    // No error toast or onError callback — recovery was transparent.
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement | null;
    expect(toast?.hidden).not.toBe(false);
    expect(onError).not.toHaveBeenCalled();

    widget.destroy();
  });

  it("surfaces error after exactly one recovery attempt when the retried /v1/chat also 404s", async () => {
    const onError = vi.fn();
    const { widget, target, fetchMock } = makeWidget({ callbacks: { onError } });

    // Session open succeeds.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "stale_sess_2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();

    // First /v1/chat: 404.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Recovery session creation: succeeds.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "also_stale" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Retried /v1/chat also 404s — no further recovery attempt.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello again";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });

    // Exactly 4 fetch calls: open-session + first-chat + recovery-session + retry-chat.
    expect(fetchMock).toHaveBeenCalledTimes(4);

    widget.destroy();
  });
});

describe("offline send guard and send-path edge cases", () => {
  afterEach(() => {
    // Keep navigator.onLine truthy for the rest of the suite; offline tests flip it.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("Enter-to-send while offline issues no chat request, appends no user bubble, shows offline banner", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_off_enter" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    // Session create is the only fetch so far.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "are you there";
    composer.dispatchEvent(new Event("input"));

    // Go offline (mirror the production connectivity listener path).
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));

    // Enter key on the composer should NOT fire a chat POST.
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No second fetch — chat request was suppressed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No optimistic user bubble was appended.
    expect(target.querySelector('[data-ai-sdr-role="user"]')).toBeNull();
    // Offline banner is visible.
    expect(target.querySelector("[data-ai-sdr-offline-banner]")).not.toBeNull();

    widget.destroy();
  });

  it("programmatic submit while offline issues no chat request and shows offline banner", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_off_submit" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "hello while offline";
    composer.dispatchEvent(new Event("input"));

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));

    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-ai-sdr-role="user"]')).toBeNull();
    expect(target.querySelector("[data-ai-sdr-offline-banner]")).not.toBeNull();

    widget.destroy();
  });

  it("concurrent send: a second submit while one is in-flight does not start a second chat request", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_concurrent" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // First chat: never resolves so the send stays in-flight.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    await widget.open();

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;

    composer.value = "first";
    composer.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One chat request is in-flight (open + chat = 2 fetches).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Attempt a second send while the first is still pending.
    composer.value = "second";
    composer.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The `sending` guard holds: still only 2 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    widget.destroy();
  });

  it("double-destroy is a safe no-op", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_double_destroy" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    widget.destroy();
    // Second destroy must not throw.
    expect(() => widget.destroy()).not.toThrow();
    expect(target.querySelector("[data-ai-sdr-widget]")).toBeNull();
  });

  it("empty/whitespace message submit issues no chat request", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_empty" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await widget.open();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    composer.value = "   \n  ";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Whitespace-only message is trimmed away — no chat POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-ai-sdr-role="user"]')).toBeNull();

    widget.destroy();
  });

  it("user-abort of an in-flight send shows no error toast, re-enables composer, and clears aria-busy", async () => {
    const { widget, target, fetchMock } = makeWidget();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "sess_abort" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let abortCalled = false;
    fetchMock.mockImplementationOnce((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          abortCalled = true;
          reject(new DOMException("AbortError", "AbortError"));
        });
      });
    });
    await widget.open();

    const composer = target.querySelector("[data-ai-sdr-input]") as HTMLTextAreaElement;
    const stopBtn = target.querySelector("[data-ai-sdr-stop-generating]") as HTMLButtonElement;
    const transcript = target.querySelector("[data-ai-sdr-transcript]") as HTMLElement;
    composer.value = "stop me";
    composer.dispatchEvent(new Event("input"));
    const form = target.querySelector("[data-ai-sdr-composer]") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transcript.getAttribute("aria-busy")).toBe("true");

    stopBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortCalled).toBe(true);
    const toast = target.querySelector("[data-ai-sdr-toast]") as HTMLElement;
    expect(toast.hidden).toBe(true);
    expect(composer.readOnly).toBe(false);
    expect(transcript.getAttribute("aria-busy")).toBe("false");

    widget.destroy();
  });
});

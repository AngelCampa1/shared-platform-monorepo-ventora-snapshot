// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedClientGlobalModule, hostedClientModule } from "../hosted-client.js";

declare global {
  // eslint-disable-next-line no-var
  var __ventoraAiCsWidget: unknown;
}

type WidgetCallbacks = {
  onOpen?: () => void;
  onClose?: () => void;
  onEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
  onEscalate?: (receipt: unknown) => void;
  onNavigate?: (target: unknown) => void;
};

type WidgetConfig = {
  baseUrl: string;
  brand?: Record<string, string>;
  copy?: Record<string, string>;
  locale?: string;
  position?: "bottom-right" | "bottom-left";
  session?: { sessionId: string } | null;
  clientAssertion: { body: Record<string, unknown> };
  signRequest: (input: {
    path: string;
    body: unknown;
  }) => Promise<{ body: unknown; headers: Record<string, string> }>;
  callbacks?: WidgetCallbacks;
  negativeTriggers?: RegExp;
  debug?: boolean;
};

type Widget = {
  open(): Promise<void>;
  close(): void;
  destroy(): void;
  isOpen(): boolean;
  getSessionId(): string | null;
  escalate(detail?: Record<string, unknown>): Promise<unknown>;
  retry(): Promise<void>;
  stopGenerating(): void;
  handleEvent(event: { event: string; data: Record<string, unknown> }): void;
};

type HostedClientApi = {
  AiCs: {
    init: (config: WidgetConfig) => Widget;
    createAiCsWidget: (config: WidgetConfig) => Widget;
  };
};

function evalHostedClient(): HostedClientApi {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(hostedClientGlobalModule)();
  const api = (globalThis as unknown as HostedClientApi).AiCs;
  return { AiCs: api };
}

function sseStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function requestBodyAt(mock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = mock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

function fakeSign(): WidgetConfig["signRequest"] {
  return async (input) => ({
    body: input.body,
    headers: {
      "X-Ventora-Timestamp": "2026-01-01T00:00:00Z",
      "X-Ventora-Nonce": "nonce",
      "X-Ventora-Signature": "sig",
    },
  });
}

function baseConfig(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    baseUrl: "https://worker.example.com",
    brand: { id: "lextract" },
    clientAssertion: { body: { appId: "lextract", userId: "u1" } },
    signRequest: fakeSign(),
    ...overrides,
  };
}

describe("hosted ai-cs widget", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    // Clear the double-mount guard between tests so each test gets a fresh widget.
    globalThis.__ventoraAiCsWidget = undefined;
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes window.AiCs.init returning a widget", () => {
    expect(typeof api.AiCs.init).toBe("function");
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" } }));
    expect(typeof widget.open).toBe("function");
    expect(widget.getSessionId()).toBe("sess_1");
  });

  it("renders launcher with brand colors and ARIA attributes on open", async () => {
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" } }));
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    await widget.open();
    const root = document.querySelector("[data-aics-root]");
    expect(root).not.toBeNull();
    const launcher = document.querySelector<HTMLButtonElement>("[data-aics-launcher]");
    expect(launcher?.getAttribute("aria-expanded")).toBe("true");
    expect(launcher?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(launcher?.textContent).toContain("Need help?");
    expect(launcher?.hidden).toBe(true);
    const panel = document.querySelector("[data-aics-panel]");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(widget.isOpen()).toBe(true);
  });

  it("creates a session via signed request when no session provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "new_sess" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    expect(widget.getSessionId()).toBe("new_sess");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.com/v1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Ventora-Signature"]).toBe("sig");
  });

  it("shows error banner when session creation fails", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const onError = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onError } }));
    await widget.open();
    const banner = document.querySelector("[data-aics-banner]");
    expect(banner?.getAttribute("data-aics-status")).toBe("error");
    expect(onError).toHaveBeenCalled();
  });

  it("sends a chat message and renders SSE deltas", async () => {
    const signRequest = vi.fn(fakeSign());
    const ownerBoundWidget = api.AiCs.init(
      baseConfig({ session: { sessionId: "sess_1" }, signRequest }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream([
          'event: message.delta\ndata: {"messageId":"m1","delta":"Hello"}\n\n',
          'event: message.delta\ndata: {"messageId":"m1","delta":" world"}\n\n',
          'event: message.done\ndata: {"messageId":"m1"}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    await ownerBoundWidget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    const form = document.querySelector<HTMLFormElement>("[data-aics-composer]");
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const assistant = document.querySelector("[data-aics-role='assistant']");
    expect(assistant?.textContent).toContain("Hello world");
    expect(signRequest).toHaveBeenCalledWith({
      path: "/v1/chat",
      body: {
        appId: "lextract",
        userId: "u1",
        sessionId: "sess_1",
        message: "hi",
      },
    });
    expect(requestBodyAt(fetchMock, 0)).toEqual({
      appId: "lextract",
      userId: "u1",
      sessionId: "sess_1",
      message: "hi",
    });
  });

  it("renders navigation suggestion chip and dispatches aics:navigate", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const onNavigate = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onNavigate } }));
    await widget.open();
    const navListener = vi.fn();
    window.addEventListener("aics:navigate", navListener as EventListener);
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Billing", path: "/billing" } },
    });
    const chip = document.querySelector<HTMLButtonElement>("[data-aics-navigation-chip]");
    expect(chip?.textContent).toBe("Billing");
    expect(chip?.dataset.aicsPath).toBe("/billing");
    chip?.click();
    expect(navListener).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith({
      url: "/billing",
      path: "/billing",
      label: "Billing",
    });
  });

  it("renders workflow steps in a collapsible stepper", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "workflow.step",
      data: { step: { id: "s1", label: "Upload doc", status: "current" } },
    });
    widget.handleEvent({
      event: "workflow.step",
      data: { step: { id: "s2", label: "Confirm", status: "pending" } },
    });
    const items = document.querySelectorAll("[data-aics-workflow] li");
    expect(items.length).toBe(2);
    expect(items[0]?.getAttribute("data-aics-status")).toBe("current");
  });

  it("renders source accordion attached to last assistant bubble", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Hi" } });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s1", title: "Docs", url: "https://docs.example.com" } },
    });
    const link = document.querySelector("[data-aics-sources] a");
    expect(link?.getAttribute("href")).toBe("https://docs.example.com");
    expect(link?.textContent).toContain("Docs");
  });

  it("escalation CTA opens booking without posting escalation", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const signRequest = vi.fn(fakeSign());
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(jsonResponse({ escalationId: "esc_1", status: "queued" }));
    const onEscalate = vi.fn();
    const onEvent = vi.fn();
    const widget = api.AiCs.init(baseConfig({ signRequest, callbacks: { onEscalate, onEvent } }));
    await widget.open();
    const overflow = document.querySelector<HTMLButtonElement>("[data-aics-overflow-button]");
    overflow?.click();
    expect(overflow?.getAttribute("aria-expanded")).toBe("true");
    const escalateBtn = document.querySelector<HTMLButtonElement>(
      "[data-aics-overflow-menu] button",
    );
    expect(escalateBtn?.textContent).toBe("Talk to a person");
    escalateBtn?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "https://cal.com/demo-team-lextract/15min",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onEscalate).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "support.escalation.requested" }),
    );
    expect(signRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/escalations" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("escalation CTA falls back to client assertion app id when brand is omitted", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init({
      baseUrl: "https://worker.example.com",
      clientAssertion: { body: { appId: "capveri", userId: "u1" } },
      signRequest: fakeSign(),
    });
    await widget.open();
    const escalateBtn = document.querySelector<HTMLButtonElement>("[data-aics-escalate]");
    escalateBtn?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "https://cal.com/demo-team-capveri/15min",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("rebounds escalation details to the configured session owner", async () => {
    const signRequest = vi.fn(fakeSign());
    fetchMock.mockResolvedValueOnce(jsonResponse({ escalationId: "esc_1", status: "queued" }));
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" }, signRequest }));

    await widget.escalate({
      appId: "forged",
      userId: "attacker",
      sessionId: "other-session",
      reason: "billing",
    });

    expect(signRequest).toHaveBeenCalledWith({
      path: "/v1/escalations",
      body: {
        appId: "lextract",
        userId: "u1",
        sessionId: "sess_1",
        reason: "billing",
      },
    });
    expect(requestBodyAt(fetchMock, 0)).toEqual({
      appId: "lextract",
      userId: "u1",
      sessionId: "sess_1",
      reason: "billing",
    });
  });

  it("shows error banner when escalation fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const result = await widget.escalate({ reason: "billing" });
    expect(result).toBeNull();
    expect(document.querySelector("[data-aics-banner][data-aics-status='error']")).not.toBeNull();
  });

  it("supports Enter to send and Shift+Enter newline", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockResolvedValueOnce(
      new Response(sseStream(['event: message.done\ndata: {"messageId":"m1"}\n\n']), {
        status: 200,
      }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      cancelable: true,
    });
    input.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
  });

  it("close removes panel, restores focus, aborts in-flight chat", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            100,
          );
        }),
    );
    const external = document.createElement("button");
    document.body.appendChild(external);
    external.focus();
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    const form = document.querySelector<HTMLFormElement>("[data-aics-composer]");
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    widget.close();
    expect(document.querySelector("[data-aics-panel]")).toBeNull();
    expect(widget.isOpen()).toBe(false);
    expect(document.activeElement).toBe(external);
  });

  it("destroy removes root and prevents future open", async () => {
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" } }));
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    await widget.open();
    widget.destroy();
    expect(document.querySelector("[data-aics-root]")).toBeNull();
    await expect(widget.open()).rejects.toThrow("destroyed");
  });

  it("applies theme tokens and respects bottom-left position", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(
      baseConfig({
        position: "bottom-left",
        brand: { id: "camaudit", accentColor: "#123456" },
      }),
    );
    await widget.open();
    const root = document.querySelector<HTMLElement>("[data-aics-root]");
    expect(root?.dataset.aicsPosition).toBe("bottom-left");
    expect(root?.style.getPropertyValue("--aics-accent")).toBe("#123456");
  });

  it("applies RTL via locale attribute setting", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    document.documentElement.dir = "rtl";
    const widget = api.AiCs.init(baseConfig({ locale: "ar" }));
    await widget.open();
    const root = document.querySelector<HTMLElement>("[data-aics-root]");
    expect(root?.getAttribute("lang")).toBe("ar");
    document.documentElement.dir = "";
  });

  it("injects style tag only once per document", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget1 = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" } }));
    await widget1.open();
    const widget2 = api.AiCs.init(baseConfig({ session: { sessionId: "sess_2" } }));
    await widget2.open();
    expect(document.querySelectorAll("#ventora-ai-cs-styles").length).toBe(1);
    expect(document.querySelector("#ventora-ai-cs-styles")?.textContent).toContain(
      "prefers-reduced-motion",
    );
  });

  it("retry button resubmits last user message", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(sseStream(['event: message.done\ndata: {"messageId":"m1"}\n\n']), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(sseStream(['event: message.done\ndata: {"messageId":"m2"}\n\n']), {
          status: 200,
        }),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await widget.retry();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("copy button copies assistant text and shows toast", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "answer" } });
    const copyBtn = document.querySelector<HTMLButtonElement>("[data-aics-actions] button");
    copyBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writeText).toHaveBeenCalledWith("answer");
    expect(document.querySelector("[data-aics-toast]")).not.toBeNull();
  });

  it("ignores unknown events but forwards them to callback", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const onEvent = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onEvent } }));
    await widget.open();
    widget.handleEvent({ event: "unknown.event", data: { x: 1 } });
    expect(onEvent).toHaveBeenCalled();
  });

  it("handleEvent is no-op after destroy", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.destroy();
    expect(() =>
      widget.handleEvent({ event: "message.done", data: { messageId: "m1" } }),
    ).not.toThrow();
  });

  it("escalate returns null when no session", async () => {
    const widget = api.AiCs.init(baseConfig());
    const result = await widget.escalate();
    expect(result).toBeNull();
  });

  it("retry no-ops when there is no last user message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    await expect(widget.retry()).resolves.toBeUndefined();
  });

  it("module export build contains expected named exports", () => {
    expect(hostedClientModule).toContain("createAiCsWidget");
    expect(hostedClientModule).toContain("export {");
    expect(hostedClientModule).toContain("AiCsApiError");
    expect(hostedClientModule).toContain("requestAiCsEscalation");
  });

  it("served hosted-client modules parse without SyntaxError", () => {
    for (const moduleSource of [hostedClientModule, hostedClientGlobalModule]) {
      // Strip ESM `export` and `import` keywords so we can validate the
      // body inside `new Function`, which does not permit ES module syntax.
      const stripped = moduleSource
        .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, "")
        .replace(/^\s*import\s+.+;\s*$/gm, "");
      expect(() => new Function(stripped)).not.toThrow();
    }
  });

  it("transcript aria-live flips off during streaming and back to polite on done; hidden region announces on done", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]");
    expect(transcript?.getAttribute("aria-live")).toBe("polite");
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Hi" } });
    expect(transcript?.getAttribute("aria-live")).toBe("off");
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    expect(transcript?.getAttribute("aria-live")).toBe("polite");
    const live = document.querySelector("[data-aics-live]");
    expect(live?.textContent).toBe("Assistant reply complete");
  });

  it("drops navigation chips with unsafe URLs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Bad", path: "javascript:alert(1)" } },
    });
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Proto", path: "//evil.com" } },
    });
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Ok", path: "/dashboard" } },
    });
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Ext", path: "https://example.com" } },
    });
    const chips = document.querySelectorAll("[data-aics-navigation-chip]");
    expect(chips.length).toBe(2);
    expect(chips[0]?.textContent).toBe("Ok");
    expect(chips[1]?.textContent).toBe("Ext");
  });

  it("drops home and positioning navigation chips", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "CAMAudit positioning", path: "/" } },
    });
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Home", path: "/home" } },
    });
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Billing settings", path: "/settings/billing" } },
    });
    const chips = document.querySelectorAll("[data-aics-navigation-chip]");
    expect(chips.length).toBe(1);
    expect(chips[0]?.textContent).toBe("Billing settings");
  });

  it("does not render unsafe source links", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "x" } });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s1", title: "Bad", url: "javascript:alert(1)" } },
    });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s2", title: "Doc", url: "https://docs.example.com" } },
    });
    const links = document.querySelectorAll("[data-aics-sources] a");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://docs.example.com");
    expect(document.querySelector("[data-aics-source-plain]")?.textContent).toBe("Bad");
  });

  it("Escape key closes the modal; aria-modal applies only on mobile breakpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const panel = document.querySelector("[data-aics-panel]");
    // desktop jsdom viewport: aria-modal should NOT be set
    expect(panel?.getAttribute("aria-modal")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(widget.isOpen()).toBe(false);
  });

  it("aria-modal=true is applied on mobile-breakpoint viewports", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const mql: MediaQueryList = {
      matches: true,
      media: "(max-width: 640px)",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    const originalMM = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query.includes("max-width: 640px")
        ? mql
        : (originalMM?.(query) ?? mql)) as typeof window.matchMedia;
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      const panel = document.querySelector("[data-aics-panel]");
      expect(panel?.getAttribute("aria-modal")).toBe("true");
      widget.close();
    } finally {
      window.matchMedia = originalMM;
    }
  });

  it("escalation is rate-limited by an in-flight guard", async () => {
    const escRef: { current: ((response: Response) => void) | null } = { current: null };
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          escRef.current = resolve;
        }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const p1 = widget.escalate({ reason: "a" });
    const p2 = widget.escalate({ reason: "b" });
    await expect(p2).resolves.toBeNull();
    escRef.current?.(jsonResponse({ escalationId: "e1", status: "queued" }));
    await expect(p1).resolves.toEqual({ escalationId: "e1", status: "queued" });
  });

  it("clears navigation strip at the start of a new message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockResolvedValueOnce(
      new Response(sseStream(['event: message.done\ndata: {"messageId":"m1"}\n\n']), {
        status: 200,
      }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "navigation.suggestion",
      data: { target: { label: "Old", path: "/old" } },
    });
    expect(document.querySelectorAll("[data-aics-navigation-chip]").length).toBe(1);
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "again";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelectorAll("[data-aics-navigation-chip]").length).toBe(0);
  });

  it("focus restoration falls back to launcher when prior focus is detached", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const ephemeral = document.createElement("button");
    document.body.appendChild(ephemeral);
    ephemeral.focus();
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    ephemeral.remove();
    widget.close();
    const launcher = document.querySelector<HTMLButtonElement>("[data-aics-launcher]");
    expect(document.activeElement).toBe(launcher);
  });

  it("Tab cycles focus within the dialog", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const panel = document.querySelector("[data-aics-panel]") as HTMLElement;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
      ),
    ).filter((el) => el.tabIndex !== -1);
    expect(focusables.length).toBeGreaterThan(0);
    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("applies inert and aria-hidden to body siblings on mobile and releases on close", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const sibling = document.createElement("section");
    sibling.textContent = "other";
    document.body.appendChild(sibling);
    const originalMM = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 640px"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      expect(sibling.hasAttribute("inert")).toBe(true);
      expect(sibling.getAttribute("aria-hidden")).toBe("true");
      widget.close();
      expect(sibling.hasAttribute("inert")).toBe(false);
      expect(sibling.hasAttribute("aria-hidden")).toBe(false);
    } finally {
      window.matchMedia = originalMM;
    }
  });

  it("desktop viewport does NOT inert siblings (corner widget does not block page)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(sibling.hasAttribute("aria-hidden")).toBe(false);
    widget.close();
  });

  it("shared inert refcount handles two concurrent widgets cleanly on mobile", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const originalMM = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 640px"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      // Use createAiCsWidget directly to bypass the single-instance mount guard
      // (this test exercises the shared inert refcount with two independent widgets).
      const w1 = api.AiCs.createAiCsWidget(baseConfig({ session: { sessionId: "s1" } }));
      const w2 = api.AiCs.createAiCsWidget(baseConfig({ session: { sessionId: "s2" } }));
      await w1.open();
      await w2.open();
      expect(sibling.hasAttribute("inert")).toBe(true);
      w1.close();
      expect(sibling.hasAttribute("inert")).toBe(true);
      w2.close();
      expect(sibling.hasAttribute("inert")).toBe(false);
    } finally {
      window.matchMedia = originalMM;
    }
  });

  it("inert registry uses the shared ventora.chat.inertRegistry symbol as a WeakMap with refCount entries", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const sibling = document.createElement("section");
    document.body.appendChild(sibling);
    const originalMM = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 640px"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      const key = Symbol.for("ventora.chat.inertRegistry");
      const registry = (globalThis as unknown as Record<symbol, unknown>)[key];
      expect(registry instanceof WeakMap).toBe(true);
      const weakRegistry = registry as WeakMap<
        Element,
        { refCount: number; prevInert: boolean | null; prevAriaHidden: string | null }
      >;
      const entry = weakRegistry.get(sibling);
      expect(entry).toBeDefined();
      expect(entry?.refCount).toBe(1);
      expect(typeof entry?.prevInert).toBe("boolean");
      expect(entry?.prevAriaHidden === null || typeof entry?.prevAriaHidden === "string").toBe(
        true,
      );
      const liveKey = Symbol.for("ventora.chat.liveWidgetRoots");
      const live = (globalThis as unknown as Record<symbol, unknown>)[liveKey];
      expect(live instanceof Set).toBe(true);
      const holdersKey = Symbol.for("ventora.chat.inertHolders");
      const holders = (globalThis as unknown as Record<symbol, unknown>)[holdersKey];
      expect(holders instanceof Set).toBe(true);
      widget.close();
    } finally {
      window.matchMedia = originalMM;
    }
  });

  it("workflow summary text is Steps and details default open", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "workflow.step",
      data: { step: { id: "s1", label: "L", status: "current" } },
    });
    const summary = document.querySelector("[data-aics-workflow] summary");
    expect(summary?.textContent).toBe("Steps");
    expect(summary?.getAttribute("aria-label")).toBeNull();
    const details = document.querySelector("[data-aics-workflow]") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    details.open = false;
    expect(details.open).toBe(false);
  });

  it("toast timer is cleared on close and destroy", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "answer" } });
    const copyBtn = document.querySelector<HTMLButtonElement>("[data-aics-actions] button");
    copyBtn?.click();
    expect(document.querySelector("[data-aics-toast]")).not.toBeNull();
    widget.close();
    // After close, toast host is removed; no timer should fire on detached node.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(document.querySelector("[data-aics-toast]")).toBeNull();
  });

  it("overflow and close buttons meet WCAG 2.5.5 44px minimum touch target", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const styles = document.querySelector("#ventora-ai-cs-styles");
    const css = styles?.textContent ?? "";
    // The overflow/close rule must contain 44px touch targets
    expect(css).toContain("[data-aics-overflow-button],[data-aics-close]{");
    const overflowCloseRule = css.slice(
      css.indexOf("[data-aics-overflow-button],[data-aics-close]{"),
      css.indexOf("}", css.indexOf("[data-aics-overflow-button],[data-aics-close]{")) + 1,
    );
    expect(overflowCloseRule).toContain("min-width:44px");
    expect(overflowCloseRule).toContain("min-height:44px");
    expect(overflowCloseRule).not.toContain("min-width:32px");
    expect(overflowCloseRule).not.toContain("min-height:32px");
    widget.close();
  });

  it("transcript has aria-busy=false initially and aria-busy=true while streaming, false after done", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            'event: message.delta\ndata: {"messageId":"m1","delta":"Hi"}\n\n',
            'event: message.done\ndata: {"messageId":"m1"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]");
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    widget.close();
  });

  it("transcript aria-busy is set back to false on stream error", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(new Response("Internal Error", { status: 500 }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]");
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = "trigger error";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    widget.close();
  });

  it("stylesheet declares design-token CSS custom properties", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("--aics-space-1:4px");
    expect(css).toContain("--aics-radius-pill:9999px");
    expect(css).toContain("--aics-motion-fast:140ms");
    expect(css).toContain("100dvh");
    expect(css).toContain("safe-area-inset-top");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("forced-colors: active");
    expect(css).toContain("orientation:landscape");
    expect(css).toContain("[data-aics-typing]");
    expect(css).toContain("@keyframes aics-typing");
    expect(css).toContain("@keyframes aics-pop");
    expect(css).toContain("@keyframes aics-bubble-in");
    expect(css).toContain("[data-aics-escalate]");
    widget.close();
  });

  it("stylesheet guards every [hidden]-toggled element whose rule sets display, so native [hidden] hiding is not overridden by author CSS", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("[data-aics-composer][hidden]{display:none;}");
    expect(css).toContain("[data-aics-launcher][hidden]{display:none;}");
    expect(css).toContain("[data-aics-navigation][hidden]{display:none;}");
    expect(css).toContain("[data-aics-stop-host][hidden]{display:none;}");
    widget.close();
  });

  it("renders a chat-bubble icon on the launcher and no dead badge element", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_1" } }));
    await widget.open();
    const icon = document.querySelector("[data-aics-launcher] [data-aics-launcher-icon]");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("[data-aics-launcher-badge]")).toBeNull();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).not.toContain("[data-aics-launcher-badge]");
    widget.close();
  });

  it("renders header subtitle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const subtitle = document.querySelector("[data-aics-subtitle]");
    expect(subtitle?.textContent).toContain("reply");
    widget.close();
  });

  it("shows animated typing indicator while sending and converts to bubble on first delta", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            'event: message.delta\ndata: {"messageId":"m1","delta":"Hi"}\n\n',
            'event: message.done\ndata: {"messageId":"m1"}\n\n',
          ]),
          { status: 200 },
        ),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("[data-aics-typing]")).toBeNull();
    const assistant = document.querySelector("[data-aics-role='assistant']");
    expect(assistant?.textContent).toContain("Hi");
    widget.close();
  });

  it("renders typing indicator immediately when send begins (synchronous)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(sseStream(['event: message.done\ndata: {"messageId":"m1"}\n\n']), {
                  status: 200,
                }),
              ),
            50,
          );
        }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const typing = document.querySelector("[data-aics-typing]");
    expect(typing).not.toBeNull();
    expect(typing?.querySelectorAll("span").length).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    widget.close();
  });

  it("escalate pill is visible from widget creation (persistent, no auto-trigger)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const host = document.querySelector<HTMLElement>("[data-aics-escalate-host]");
    // Must be visible immediately — not hidden by default.
    expect(host?.hidden).toBe(false);
    // Adding assistant bubbles must NOT change visibility (it was already visible).
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "a" } });
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    widget.handleEvent({ event: "message.delta", data: { messageId: "m2", delta: "b" } });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(host?.hidden).toBe(false);
    expect(document.querySelector("[data-aics-escalate]")?.textContent).toContain(
      "Talk to a person",
    );
    widget.close();
  });

  it("negative trigger words do NOT auto-reveal the escalate pill (host already visible)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const host = document.querySelector<HTMLElement>("[data-aics-escalate-host]");
    // Host is already visible — typing negative keywords must NOT cause any live-region announcement.
    expect(host?.hidden).toBe(false);
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "this is not working";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // Still visible (was already visible), no change.
    expect(host?.hidden).toBe(false);
    // The live region must NOT have been updated with an escalation announcement.
    const live = document.querySelector("[data-aics-live]");
    expect(live?.textContent ?? "").toBe("");
    widget.close();
  });

  it("error banner does NOT auto-reveal escalate pill (host already visible)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "trigger error";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const host = document.querySelector<HTMLElement>("[data-aics-escalate-host]");
    // Host should still be visible (already was, not hidden by error either).
    expect(host?.hidden).toBe(false);
    widget.close();
  });

  it("escalate pill opens escalation booking", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(jsonResponse({ escalationId: "e1", status: "queued" }));
    const onEscalate = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onEscalate } }));
    await widget.open();
    const pill = document.querySelector<HTMLButtonElement>("[data-aics-escalate]");
    pill?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "https://cal.com/demo-team-lextract/15min",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onEscalate).not.toHaveBeenCalled();
    widget.close();
  });

  it("successful escalation locks/hides the composer and hides the escalate host", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(jsonResponse({ escalationId: "esc_lock_1", status: "pending" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();

    const composerEl = document.querySelector<HTMLElement>("[data-aics-composer]");
    const escalateHostEl = document.querySelector<HTMLElement>("[data-aics-escalate-host]");

    // Before escalation both should be visible
    expect(composerEl?.hidden).toBe(false);
    expect(escalateHostEl?.hidden).toBe(false);

    await widget.escalate();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // After successful escalation: composer must be hidden/locked and escalate host hidden
    expect(composerEl?.hidden).toBe(true);
    expect(composerEl?.getAttribute("aria-hidden")).toBe("true");
    expect(escalateHostEl?.hidden).toBe(true);
    widget.close();
  });

  it("handleEvent support.escalation.requested locks composer and hides escalate host directly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();

    const composerEl = document.querySelector<HTMLElement>("[data-aics-composer]");
    const escalateHostEl = document.querySelector<HTMLElement>("[data-aics-escalate-host]");

    expect(composerEl?.hidden).toBe(false);
    expect(escalateHostEl?.hidden).toBe(false);

    widget.handleEvent({
      event: "support.escalation.requested",
      data: { escalationId: "esc_direct_1" },
    });

    expect(composerEl?.hidden).toBe(true);
    expect(composerEl?.getAttribute("aria-hidden")).toBe("true");
    expect(escalateHostEl?.hidden).toBe(true);
    widget.close();
  });

  it("composer autosizes height on input and uses rows=1", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    expect(input.rows).toBe(1);
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => 80 });
    input.value = "line1\nline2\nline3";
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("80px");
    widget.close();
  });

  it("Enter while IME composing does not send", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, keyCode: 229 });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    widget.close();
  });

  it("composer sets readOnly and aria-busy while sending", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(sseStream(['event: message.done\ndata: {"messageId":"m1"}\n\n']), {
                  status: 200,
                }),
              ),
            30,
          );
        }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(input.readOnly).toBe(false);
    widget.close();
  });

  it("transcript has role=log, aria-label, and aria-relevant=additions text", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]");
    expect(transcript?.getAttribute("role")).toBe("log");
    expect(transcript?.getAttribute("aria-label")).toBe("Conversation");
    expect(transcript?.getAttribute("aria-relevant")).toBe("additions text");
    widget.close();
  });

  it("sources show hostname under titled link", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "x" } });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s1", title: "Docs", url: "https://docs.example.com/path" } },
    });
    const host = document.querySelector("[data-aics-source-host]");
    expect(host?.textContent).toBe("docs.example.com");
    widget.close();
  });

  it("workflow li carries data-aics-status used to render status circle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({
      event: "workflow.step",
      data: { step: { id: "s1", label: "Done", status: "done" } },
    });
    const item = document.querySelector("[data-aics-workflow] li");
    expect(item?.getAttribute("data-aics-status")).toBe("done");
    widget.close();
  });

  it("error banner from chat failure includes Retry action button", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "boom";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const action = document.querySelector("[data-aics-banner-action]");
    expect(action).not.toBeNull();
    expect(action?.textContent).toBe("Retry");
    widget.close();
  });

  it("ok-status banner auto-dismisses after timeout", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
        .mockResolvedValueOnce(jsonResponse({ escalationId: "e1", status: "queued" }));
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      const escalatePromise = widget.escalate();
      await vi.advanceTimersByTimeAsync(1);
      await escalatePromise;
      expect(document.querySelector("[data-aics-banner]")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(6001);
      expect(document.querySelector("[data-aics-banner]")).toBeNull();
      widget.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("jump-to-latest pill appears when user scrolls up and new bubble arrives", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]") as HTMLElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, get: () => 200 });
    transcript.scrollTop = 0;
    transcript.dispatchEvent(new Event("scroll"));
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "hi" } });
    expect(document.querySelector("[data-aics-jump]")).not.toBeNull();
    const jump = document.querySelector<HTMLButtonElement>("[data-aics-jump]");
    jump?.click();
    expect(document.querySelector("[data-aics-jump]")).toBeNull();
    widget.close();
  });

  it("overflow menu opens with arrow keys and Escape closes returning focus", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const overflow = document.querySelector<HTMLButtonElement>("[data-aics-overflow-button]");
    overflow?.click();
    const item = document.querySelector<HTMLButtonElement>("[role='menuitem']");
    expect(document.activeElement).toBe(item);
    const menu = document.querySelector<HTMLElement>("[data-aics-overflow-menu]");
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true, bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true, bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", cancelable: true, bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", cancelable: true, bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }),
    );
    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(overflow);
    overflow?.click();
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true }),
    );
    expect(menu?.hidden).toBe(true);
    widget.close();
  });

  it("document click outside overflow menu closes it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const overflow = document.querySelector<HTMLButtonElement>("[data-aics-overflow-button]");
    overflow?.click();
    const menu = document.querySelector<HTMLElement>("[data-aics-overflow-menu]");
    expect(menu?.hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(menu?.hidden).toBe(true);
    widget.close();
  });

  it("live region uses aics-sr-only class instead of inline styles", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const live = document.querySelector("[data-aics-live]");
    expect(live?.className).toBe("aics-sr-only");
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain(".aics-sr-only");
    widget.close();
  });

  it("toast renders without dataset timer attribute (legacy write removed)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "x" } });
    document.querySelector<HTMLButtonElement>("[data-aics-actions] button")?.click();
    const toast = document.querySelector("[data-aics-toast]") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.getAttribute("data-aics-toast-timer")).toBeNull();
    widget.close();
  });

  it("source events bind by messageId to the matching bubble, not last-of-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "first" } });
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    widget.handleEvent({ event: "message.delta", data: { messageId: "m2", delta: "second" } });
    widget.handleEvent({ event: "message.done", data: { messageId: "m2" } });
    widget.handleEvent({
      event: "source",
      data: {
        messageId: "m1",
        source: { id: "s1", title: "First-source", url: "https://docs.example.com" },
      },
    });
    const m1Bubble = document.querySelector('[data-aics-message-id="m1"]');
    const m2Bubble = document.querySelector('[data-aics-message-id="m2"]');
    expect(m1Bubble?.querySelector("[data-aics-sources] a")?.textContent).toContain("First-source");
    expect(m2Bubble?.querySelector("[data-aics-sources] a")).toBeNull();
    widget.close();
  });

  it("open() called twice is a no-op (does not stack listeners)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const onOpen = vi.fn();
    const widget = api.AiCs.init(
      baseConfig({ session: { sessionId: "sess_1" }, callbacks: { onOpen } }),
    );
    await widget.open();
    await widget.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-aics-panel]").length).toBe(1);
    widget.close();
  });

  it("Tab inside overflow menu closes it and focuses overflow button", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const overflow = document.querySelector<HTMLButtonElement>("[data-aics-overflow-button]");
    overflow?.click();
    const menu = document.querySelector<HTMLElement>("[data-aics-overflow-menu]");
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true }),
    );
    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(overflow);
    widget.close();
  });

  it("streaming bubble gets data-aics-streaming during deltas, removed on done", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Hi" } });
    const bubble = document.querySelector('[data-aics-message-id="m1"]') as HTMLElement;
    expect(bubble.hasAttribute("data-aics-streaming")).toBe(true);
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    expect(bubble.hasAttribute("data-aics-streaming")).toBe(false);
    widget.close();
  });

  it("RTL auto-detection sets dir=rtl on root", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    document.documentElement.dir = "rtl";
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      const root = document.querySelector("[data-aics-root]");
      expect(root?.getAttribute("dir")).toBe("rtl");
      widget.close();
    } finally {
      document.documentElement.dir = "";
    }
  });

  it("data-aics-converted is set on bubbles converted from pending typing indicator", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            'event: message.delta\ndata: {"messageId":"m1","delta":"Hi"}\n\n',
            'event: message.done\ndata: {"messageId":"m1"}\n\n',
          ]),
          { status: 200 },
        ),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bubble = document.querySelector('[data-aics-message-id="m1"]') as HTMLElement;
    expect(bubble?.dataset.aicsConverted).toBe("true");
    widget.close();
  });

  it("offline event shows persistent banner and disables send; online clears it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    window.dispatchEvent(new Event("offline"));
    const banner = document.querySelector("[data-aics-banner][data-aics-status='error']");
    expect(banner?.textContent).toContain("offline");
    const sendBtn = document.querySelector<HTMLButtonElement>("[data-aics-send]");
    expect(sendBtn?.disabled).toBe(true);
    window.dispatchEvent(new Event("online"));
    expect(document.querySelector("[data-aics-banner]")).toBeNull();
    widget.close();
  });

  it("online/offline listeners are removed on close", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.close();
    // After close, dispatching offline must NOT show a banner
    window.dispatchEvent(new Event("offline"));
    expect(document.querySelector("[data-aics-banner]")).toBeNull();
  });

  it("negativeTriggers option is ignored — escalate host is always visible (no auto-reveal)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    // Passing a custom regex is still accepted without error, but does not affect visibility.
    const widget = api.AiCs.init(
      baseConfig({ negativeTriggers: /\bxyzzy\b/i } as unknown as Partial<WidgetConfig>),
    );
    await widget.open();
    const host = document.querySelector<HTMLElement>("[data-aics-escalate-host]");
    // Should be visible from the start regardless.
    expect(host?.hidden).toBe(false);
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "say xyzzy";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // Still visible, no change.
    expect(host?.hidden).toBe(false);
    widget.close();
  });

  it("stylesheet declares streaming caret, escalate-in keyframes, color-mix fallback", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("data-aics-streaming");
    expect(css).toContain("aics-caret");
    expect(css).toContain("aics-escalate-in");
    expect(css).toContain("@supports not (background: color-mix");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("scrollbar-width:thin");
    expect(css).toContain("--aics-stick-threshold");
    expect(css).not.toContain("word-wrap:break-word");
    widget.close();
  });

  it("plain Tab from outside panel focuses the first focusable inside the panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const external = document.createElement("button");
    document.body.appendChild(external);
    external.focus();
    expect(document.activeElement).toBe(external);
    const panel = document.querySelector("[data-aics-panel]") as HTMLElement;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
      ),
    ).filter((el) => el.tabIndex !== -1);
    const evt = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    widget.close();
  });

  it("visualViewport scroll listener is attached on open and removed on close", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const added: string[] = [];
    const removed: string[] = [];
    const fakeVV = {
      addEventListener: (type: string) => {
        added.push(type);
      },
      removeEventListener: (type: string) => {
        removed.push(type);
      },
    } as unknown as VisualViewport;
    const originalVV = window.visualViewport;
    Object.defineProperty(window, "visualViewport", { value: fakeVV, configurable: true });
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      expect(added).toContain("resize");
      expect(added).toContain("scroll");
      widget.close();
      expect(removed).toContain("resize");
      expect(removed).toContain("scroll");
    } finally {
      Object.defineProperty(window, "visualViewport", { value: originalVV, configurable: true });
    }
  });

  it("aria-modal is re-evaluated on window resize", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    let mobile = false;
    const originalMM = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 640px") ? mobile : false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      const panel = document.querySelector("[data-aics-panel]");
      expect(panel?.getAttribute("aria-modal")).toBeNull();
      mobile = true;
      window.dispatchEvent(new Event("resize"));
      expect(panel?.getAttribute("aria-modal")).toBe("true");
      mobile = false;
      window.dispatchEvent(new Event("resize"));
      expect(panel?.getAttribute("aria-modal")).toBe("false");
      widget.close();
    } finally {
      window.matchMedia = originalMM;
    }
  });

  it("retry removes the prior incomplete assistant bubble so escalate threshold is not double-counted", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "partial" } });
    expect(document.querySelectorAll('[data-aics-bubble][data-aics-role="assistant"]').length).toBe(
      1,
    );
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "first";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await widget.retry();
    expect(document.querySelectorAll('[data-aics-bubble][data-aics-role="assistant"]').length).toBe(
      0,
    );
    widget.close();
  });

  it("transcript aria-busy is set back to false on stream abort", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
        }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = "abort me";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    widget.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  it("aria-busy on transcript toggles true on message.delta (new bubble) and false on message.done", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const transcript = document.querySelector("[data-aics-transcript]");
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    // First delta on a new message should set aria-busy=true
    widget.handleEvent({ event: "message.delta", data: { messageId: "ab-m1", delta: "Hi" } });
    expect(transcript?.getAttribute("aria-busy")).toBe("true");
    // message.done should set aria-busy=false
    widget.handleEvent({ event: "message.done", data: { messageId: "ab-m1" } });
    expect(transcript?.getAttribute("aria-busy")).toBe("false");
    widget.close();
  });

  it("reduced-motion data attribute is set on root when matchMedia reports reduce", async () => {
    const mq = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: undefined,
    };
    const origMatchMedia = window.matchMedia as typeof window.matchMedia | undefined;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => {
        if (query === "(prefers-reduced-motion: reduce)") return mq;
        if (typeof origMatchMedia === "function") return origMatchMedia.call(window, query);
        return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      },
      writable: true,
      configurable: true,
    });
    try {
      fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
      const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_rm" } }));
      await widget.open();
      const root = document.querySelector<HTMLElement>("[data-aics-root]");
      expect(root?.dataset.aicsReducedMotion).toBe("");
      // Simulate change to non-reduce
      const changeHandler = mq.addEventListener.mock.calls[0]?.[1] as
        | ((e: { matches: boolean }) => void)
        | undefined;
      changeHandler?.({ matches: false });
      expect(root?.dataset.aicsReducedMotion).toBeUndefined();
      widget.destroy();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        value: origMatchMedia,
        writable: true,
        configurable: true,
      });
    }
  });

  it("CSS stylesheet includes new status CSS vars and no hardcoded font-family on root", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig({ session: { sessionId: "sess_css" } }));
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("--aics-error-bg");
    expect(css).toContain("--aics-success-bg");
    expect(css).toContain("--aics-warning-bg");
    expect(css).toContain("--aics-muted-text");
    expect(css).toContain("--aics-focus-ring");
    expect(css).toContain("--aics-composer-max-height");
    // Dark mode scoped to :not([data-aics-theme])
    expect(css).toContain(":not([data-aics-theme])");
    // Reduced-motion data attr rule
    expect(css).toContain("[data-aics-reduced-motion]");
    // Root must NOT declare a hardcoded font-family string
    const rootRule = css.match(/\[data-aics-root\]\{[^}]+\}/)?.[0] ?? "";
    expect(rootRule).not.toContain("font-family:system-ui");
    widget.destroy();
  });

  it("escalate host is visible from panel creation (persistent — not auto-triggered)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const escalateHost = document.querySelector("[data-aics-escalate-host]") as HTMLElement | null;
    // Must be visible immediately without any triggers.
    expect(escalateHost?.hidden).toBe(false);
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    // Typing negative phrases does not change visibility (already visible, no announcement).
    input.value = "this is not working";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(escalateHost?.hidden).toBe(false);
    widget.destroy();
  });

  it("negativeTriggers option is a no-op — escalate is always persistently visible", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(
      baseConfig({ negativeTriggers: /banana/i } as unknown as Partial<WidgetConfig>),
    );
    await widget.open();
    const escalateHost = document.querySelector("[data-aics-escalate-host]") as HTMLElement | null;
    // Always visible, regardless of what the user types.
    expect(escalateHost?.hidden).toBe(false);
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "not working";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(escalateHost?.hidden).toBe(false);
    input.value = "banana";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(escalateHost?.hidden).toBe(false);
    widget.destroy();
  });

  // Cycle 3 — palette corrections (Fix 1)
  it("camaudit productBrand uses corrected accentColor #1f5a52", () => {
    const css = hostedClientModule;
    expect(css).toContain('"#1f5a52"');
    expect(css).not.toContain('"#2f8379"');
  });

  it("has no GrantPipe hosted profile while preserving sibling profiles", () => {
    expect(hostedClientModule).not.toContain('grantpipe: { id: "grantpipe"');
    expect(hostedClientModule).toContain('camaudit: { id: "camaudit"');
    expect(hostedClientModule).toContain('capveri: { id: "capveri"');
    expect(hostedClientModule).toContain('lextract: { id: "lextract"');
  });

  // Cycle 3 — stop-button padding token consistency (Fix 7)
  it("stop button uses var(--aics-space-3) not mixed px for horizontal padding", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    // The stop rule must use --aics-space-3 not 14px for horizontal padding
    const stopRule = css.slice(
      css.indexOf("[data-aics-stop]{"),
      css.indexOf("}", css.indexOf("[data-aics-stop]{")) + 1,
    );
    expect(stopRule).toContain("var(--aics-space-3)");
    expect(stopRule).not.toContain("14px");
    widget.close();
  });

  // Cycle 3 — structural neutrals via color-mix (Fix 8)
  it("hosted CSS structural selectors (panel, nav, stop, composer, workflow) use color-mix not rgba(15,23,42", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    // Structural borders/shadows that used to be rgba(15,23,42 are now color-mix
    expect(css).toContain("[data-aics-panel]{position:absolute");
    const panelIdx = css.indexOf("[data-aics-panel]{position:absolute");
    const panelRule = css.slice(panelIdx, css.indexOf("}", panelIdx) + 1);
    expect(panelRule).toContain("color-mix");
    expect(panelRule).not.toContain("rgba(15,23,42");
    // stop host border
    expect(css).toContain("border-top:1px solid color-mix(in srgb,var(--aics-text");
    // navigation border
    expect(css).toContain("[data-aics-navigation]{");
    const navIdx = css.indexOf("[data-aics-navigation]{");
    const navRule = css.slice(navIdx, css.indexOf("}", navIdx) + 1);
    expect(navRule).toContain("color-mix");
    expect(navRule).not.toContain("rgba(15,23,42");
    widget.close();
  });

  // Cycle 3 — assistant bubble brand tint (Fix 9)
  it("assistant bubble uses color-mix accent tint via --aics-assistant-bubble-bg", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("--aics-assistant-bubble-bg");
    expect(css).toContain("color-mix(in srgb,var(--aics-accent");
    widget.close();
  });

  // Cycle 3 — stop/loading transitions (Fix 5)
  it("CSS includes loading fade-in animation and stop-host opacity transition", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    expect(css).toContain("aics-fade-in");
    expect(css).toContain("[data-aics-stop-host]{transition:opacity");
    widget.close();
  });

  // Cycle 3 — dead code: data-aics-converted CSS animation rule removed (Fix 6)
  it("CSS does not contain the dead data-aics-converted animation override", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    // The animation:none override for converted bubbles must be gone
    expect(css).not.toContain('[data-aics-bubble][data-aics-converted="true"]{animation:none;}');
    widget.close();
  });

  // Cycle 3 — stop-button focus-to-composer (Fix 3)
  it("stopGenerating moves focus to composer if stop button was focused", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    // Fire a message.delta to make streamingCount > 0 so stopHost becomes visible
    widget.handleEvent({ event: "message.delta", data: { messageId: "sfoc-m1", delta: "Hi" } });
    const stopBtn = document.querySelector<HTMLButtonElement>("[data-aics-stop]");
    if (stopBtn === null) throw new Error("stop button not rendered");
    // Focus the stop button then call stopGenerating
    stopBtn.focus();
    expect(document.activeElement).toBe(stopBtn);
    widget.stopGenerating();
    // Focus should have moved to composer
    expect(document.activeElement).toBe(input);
    widget.close();
  });

  // Cycle 4 — panel font-family is a valid system-ui stack (no font-family:inherit,)
  it("[data-aics-panel] CSS rule uses a valid system-ui font stack and does NOT contain font-family:inherit,", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const css = document.querySelector("#ventora-ai-cs-styles")?.textContent ?? "";
    const panelIdx = css.indexOf("[data-aics-panel]{");
    expect(panelIdx).toBeGreaterThan(-1);
    const panelRule = css.slice(panelIdx, css.indexOf("}", panelIdx) + 1);
    expect(panelRule).toContain("font-family:system-ui");
    expect(panelRule).not.toContain("font-family:inherit,");
    widget.close();
  });

  // Cycle 4 — data-aics-theme attribute is set on root (opts branded instances out of dark mode block)
  it("root element has data-aics-theme attribute after init", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
    const widget = api.AiCs.init(baseConfig({ brand: { id: "lextract", accentColor: "#1e3a5f" } }));
    await widget.open();
    const root = document.querySelector<HTMLElement>("[data-aics-root]");
    expect(root?.hasAttribute("data-aics-theme")).toBe(true);
    widget.close();
  });

  // Cycle 4 — reduced-motion MQ listener is detached on close (addEventListener branch)
  it("prefers-reduced-motion MQ listener is removed on close (addEventListener branch)", async () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const mq = {
      matches: false,
      addEventListener: vi.fn((type: string, handler: unknown) => {
        added.push([type, handler]);
      }),
      removeEventListener: vi.fn((type: string, handler: unknown) => {
        removed.push([type, handler]);
      }),
      addListener: undefined,
      removeListener: undefined,
    };
    const origMatchMedia = window.matchMedia as typeof window.matchMedia | undefined;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => {
        if (query === "(prefers-reduced-motion: reduce)") return mq;
        if (typeof origMatchMedia === "function") return origMatchMedia.call(window, query);
        return {
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: undefined,
          removeListener: undefined,
        };
      },
      writable: true,
      configurable: true,
    });
    try {
      fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      expect(added.some(([type]) => type === "change")).toBe(true);
      widget.close();
      expect(removed.some(([type]) => type === "change")).toBe(true);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        value: origMatchMedia,
        writable: true,
        configurable: true,
      });
    }
  });

  // Cycle 4 — reduced-motion MQ listener is detached on close (legacy addListener branch)
  it("prefers-reduced-motion MQ listener is removed on close (legacy addListener branch)", async () => {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const mq = {
      matches: false,
      addEventListener: undefined,
      removeEventListener: undefined,
      addListener: vi.fn((handler: unknown) => {
        added.push(handler);
      }),
      removeListener: vi.fn((handler: unknown) => {
        removed.push(handler);
      }),
    };
    const origMatchMedia = window.matchMedia as typeof window.matchMedia | undefined;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => {
        if (query === "(prefers-reduced-motion: reduce)") return mq;
        if (typeof origMatchMedia === "function") return origMatchMedia.call(window, query);
        return {
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: undefined,
          removeListener: undefined,
        };
      },
      writable: true,
      configurable: true,
    });
    try {
      fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_1" }));
      const widget = api.AiCs.init(baseConfig());
      await widget.open();
      expect(added.length).toBeGreaterThan(0);
      widget.close();
      expect(removed.length).toBeGreaterThan(0);
      expect(removed[0]).toBe(added[0]);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        value: origMatchMedia,
        writable: true,
        configurable: true,
      });
    }
  });

  // Helper: builds a stream that yields a delta SSE event then rejects on the next read.
  // The stream delays the error slightly so the delta chunk is fully processed first.
  function deltaStreamThenReject(msgId: string, delta = "Partial"): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let step = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(
            encoder.encode(
              `event: message.delta\ndata: {"messageId":"${msgId}","delta":"${delta}"}\n\n`,
            ),
          );
        } else {
          controller.error(new Error("connection dropped"));
        }
      },
    });
  }

  // Cycle 4 — failed bubble gets data-aics-failed and an inline retry-row sibling
  it("stream error marks last assistant bubble failed and inserts inline retry-row as next sibling", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockResolvedValueOnce(
      new Response(deltaStreamThenReject("fb-m1"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "trigger failure";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const failedBubble = document.querySelector<HTMLElement>(
      "[data-aics-bubble][data-aics-failed]",
    );
    expect(failedBubble).not.toBeNull();
    const retryRow = failedBubble?.nextElementSibling;
    expect(retryRow?.hasAttribute("data-aics-retry-row")).toBe(true);
    const inlineBtn = retryRow?.querySelector("[data-aics-retry-inline]");
    expect(inlineBtn).not.toBeNull();
    widget.close();
  });

  // Cycle 4 — markBubbleFailed called directly: bubble gets data-aics-failed and retry-row sibling
  it("markBubbleFailed via stream error attaches retry-row as next sibling of the failed bubble", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" })).mockResolvedValueOnce(
      new Response(deltaStreamThenReject("dc-m1"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "test markBubbleFailed";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const bubble = document.querySelector<HTMLElement>('[data-aics-message-id="dc-m1"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.hasAttribute("data-aics-failed")).toBe(true);
    const retryRow = bubble?.nextElementSibling;
    expect(retryRow?.hasAttribute("data-aics-retry-row")).toBe(true);
    expect(retryRow?.querySelector("[data-aics-retry-inline]")).not.toBeNull();
    widget.close();
  });

  // Cycle 4 — clicking the inline retry button removes orphaned retry-row along with failed bubble
  it("inline retry button click removes the failed bubble and its adjacent retry-row (no orphan)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(deltaStreamThenReject("orph-m1"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(sseStream(['event: message.done\ndata: {"messageId":"orph-m2"}\n\n']), {
          status: 200,
        }),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "cause failure";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const retryRow = document.querySelector("[data-aics-retry-row]");
    expect(retryRow).not.toBeNull();
    const inlineBtn = retryRow?.querySelector<HTMLButtonElement>("[data-aics-retry-inline]");
    expect(inlineBtn).not.toBeNull();
    inlineBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Both the failed bubble and its retry-row must be gone
    expect(document.querySelector("[data-aics-retry-row]")).toBeNull();
    expect(document.querySelector("[data-aics-bubble][data-aics-failed]")).toBeNull();
    widget.close();
  });

  // Cycle 4 — second failure after retry produces a fresh retry-row (dedup is bubble-scoped)
  it("second failure after retry produces a fresh retry-row on the new bubble", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(
        new Response(deltaStreamThenReject("dup-m1"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(deltaStreamThenReject("dup-m2"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "fail twice";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // First failure: retry-row present
    expect(document.querySelector("[data-aics-retry-row]")).not.toBeNull();
    // Retry (removes bubble + row, re-sends)
    await widget.retry();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Second failure: a fresh retry-row should appear
    const freshRow = document.querySelector("[data-aics-retry-row]");
    expect(freshRow).not.toBeNull();
    expect(freshRow?.querySelector("[data-aics-retry-inline]")).not.toBeNull();
    widget.close();
  });

  // Cycle 3 — retry focus-to-composer (Fix 4)
  it("retry moves focus to composer after retry completes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_1" }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            'event: message.delta\ndata: {"messageId":"rf-hc","delta":"OK"}\n\n',
            'event: message.done\ndata: {"messageId":"rf-hc"}\n\n',
          ]),
          { status: 200 },
        ),
      );
    const widget = api.AiCs.init(baseConfig());
    await widget.open();
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing");
    input.value = "fail this";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Retry
    await widget.retry();
    // Composer should be focused
    expect(document.activeElement).toBe(input);
    widget.close();
  });
});

describe("double-mount guard (AiCs.init idempotency)", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    // Clear the mount key between tests to ensure isolation.
    globalThis.__ventoraAiCsWidget = undefined;
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    globalThis.__ventoraAiCsWidget = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calling init twice returns the same widget instance and does not mount a second root", () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    const config = baseConfig({ session: { sessionId: "s1" } });
    const w1 = api.AiCs.init(config);
    const w2 = api.AiCs.init(config);
    expect(w1).toBe(w2);
  });

  it("calling init twice emits a console.warn on the second call", () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig({ session: { sessionId: "s1" } });
    api.AiCs.init(config);
    api.AiCs.init(config);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already mounted"));
    warnSpy.mockRestore();
  });

  it("destroy clears the mount flag so re-init creates a fresh widget", () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    const config = baseConfig({ session: { sessionId: "s1" } });
    const w1 = api.AiCs.init(config);
    w1.destroy();
    // After destroy, init must produce a new widget (different object from w1).
    const w2 = api.AiCs.init(config);
    expect(w2).not.toBe(w1);
  });

  it("second call before destroy does not insert a second [data-aics-root] into the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    const config = baseConfig({ session: { sessionId: "s1" } });
    const w1 = api.AiCs.init(config);
    await w1.open();
    api.AiCs.init(config);
    expect(document.querySelectorAll("[data-aics-root]").length).toBe(1);
    w1.destroy();
  });
});

describe("session recovery on 404", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    globalThis.__ventoraAiCsWidget = undefined;
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    globalThis.__ventoraAiCsWidget = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function notFoundResponse(): Response {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json" },
    });
  }

  function submitMessage(value: string): void {
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = value;
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  it("recovers when first /v1/chat 404s: mints a fresh signed session and renders reply with no error", async () => {
    const onError = vi.fn();
    const signPaths: string[] = [];
    const signBodies: unknown[] = [];
    const signRequest: WidgetConfig["signRequest"] = async (input) => {
      signPaths.push(input.path);
      signBodies.push(input.body);
      return {
        body: input.body,
        headers: {
          "X-Ventora-Timestamp": "2026-01-01T00:00:00Z",
          "X-Ventora-Nonce": "nonce",
          "X-Ventora-Signature": "sig",
        },
      };
    };
    const widget = api.AiCs.init(baseConfig({ signRequest, callbacks: { onError } }));

    // 1. open() mints a stale session.
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "stale_sess" }));
    await widget.open();
    expect(widget.getSessionId()).toBe("stale_sess");

    // 2. first /v1/chat -> 404, 3. recovery /v1/sessions -> fresh id, 4. retry /v1/chat -> ok.
    fetchMock
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(jsonResponse({ sessionId: "fresh_sess" }))
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            'event: message.delta\ndata: {"messageId":"r1","delta":"Recovered reply"}\n\n',
            'event: message.done\ndata: {"messageId":"r1"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );

    submitMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const assistant = document.querySelector("[data-aics-role='assistant']");
    expect(assistant?.textContent).toContain("Recovered reply");
    expect(widget.getSessionId()).toBe("fresh_sess");
    // Transparent recovery: no error banner, no onError.
    expect(document.querySelector("[data-aics-banner][data-aics-status='error']")).toBeNull();
    expect(onError).not.toHaveBeenCalled();

    // The recovery mint hit /v1/sessions with the signed header.
    const sessionCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/sessions"),
    );
    expect(sessionCalls.length).toBe(2);
    const recoveryInit = sessionCalls[1]?.[1] as RequestInit;
    const recoveryHeaders = recoveryInit.headers as Record<string, string>;
    expect(recoveryHeaders["X-Ventora-Signature"]).toBe("sig");
    // signRequest was invoked for the recovery mint (/v1/sessions) after the first chat.
    expect(signPaths.filter((p) => p === "/v1/sessions").length).toBe(2);
    expect(signBodies.filter((_, index) => signPaths[index] === "/v1/chat")).toEqual([
      {
        appId: "lextract",
        userId: "u1",
        sessionId: "stale_sess",
        message: "hello",
      },
      {
        appId: "lextract",
        userId: "u1",
        sessionId: "fresh_sess",
        message: "hello",
      },
    ]);

    widget.destroy();
  });

  it("surfaces error after exactly one recovery attempt when the retried /v1/chat also 404s", async () => {
    const onError = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onError } }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "stale_2" }));
    await widget.open();

    fetchMock
      .mockResolvedValueOnce(notFoundResponse()) // first chat 404
      .mockResolvedValueOnce(jsonResponse({ sessionId: "also_stale" })) // recovery mint
      .mockResolvedValueOnce(notFoundResponse()); // retried chat also 404

    submitMessage("hello again");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    // Exactly 4 fetches: open-session + first-chat + recovery-session + retry-chat. No loop.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const errorBanners = document.querySelectorAll("[data-aics-banner][data-aics-status='error']");
    expect(errorBanners.length).toBe(1);

    widget.destroy();
  });

  it("guards against an empty recovered session id: does not send with it and surfaces an error", async () => {
    const onError = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onError } }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "stale_3" }));
    await widget.open();

    // first chat 404, then recovery mint resolves with an empty id.
    fetchMock
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(jsonResponse({ sessionId: "" }));

    submitMessage("hello there");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    // open-session + first-chat + recovery-session only. No third /v1/chat with an empty id.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Session id is unchanged from the stale id (empty id was rejected).
    expect(widget.getSessionId()).toBe("stale_3");

    widget.destroy();
  });
});

describe("escalation never auto-fires (escalation requirement)", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    globalThis.__ventoraAiCsWidget = undefined;
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    globalThis.__ventoraAiCsWidget = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 500 from /v1/chat plus negative wording does not auto-call /v1/escalations or onEscalate", async () => {
    const onEscalate = vi.fn();
    const onError = vi.fn();
    const widget = api.AiCs.init(baseConfig({ callbacks: { onEscalate, onError } }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_e" }));
    await widget.open();

    // /v1/chat returns a 500 server error on a negative-sounding message.
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = "this is not working";
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Error surfaced, but escalation must be a user-only action.
    expect(onError).toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
    const escalationCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/escalations"),
    );
    expect(escalationCalls.length).toBe(0);
    // open-session + the single failed chat only.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    widget.destroy();
  });
});

describe("chat error-handling parity (401/403/429/SSE/502)", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    globalThis.__ventoraAiCsWidget = undefined;
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    globalThis.__ventoraAiCsWidget = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function statusResponse(status: number, statusText: string, body = ""): Response {
    return new Response(body, { status, statusText });
  }

  async function openWidget(onError = vi.fn()): Promise<Widget> {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: "sess_p" }));
    const widget = api.AiCs.init(baseConfig({ callbacks: { onError } }));
    await widget.open();
    return widget;
  }

  function submitMessage(value: string): void {
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    if (input === null) throw new Error("missing input");
    input.value = value;
    input.dispatchEvent(new Event("input"));
    document
      .querySelector<HTMLFormElement>("[data-aics-composer]")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  function bannerText(): string {
    return (
      document.querySelector("[data-aics-banner][data-aics-status='error'] span")?.textContent ?? ""
    );
  }

  function composerEnabled(): boolean {
    const input = document.querySelector<HTMLTextAreaElement>("[data-aics-composer] textarea");
    return input !== null && input.readOnly === false;
  }

  it("401 on /v1/chat: shows an auth/session message, re-enables composer, no crash, no retry loop", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    // Raw 401 body (no JSON) — the worst case: must not show blank/statusText-only.
    fetchMock.mockResolvedValueOnce(statusResponse(401, "Unauthorized"));
    submitMessage("are you there?");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    const text = bannerText();
    expect(text).not.toBe("");
    expect(text.toLowerCase()).toMatch(/session|sign|expired|again/);
    expect(composerEnabled()).toBe(true);
    // No 404 recovery path: exactly open-session + one chat call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sessionCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/v1/sessions"));
    expect(sessionCalls.length).toBe(1);

    widget.destroy();
  });

  it("403 on /v1/chat: shows a graceful error banner, no crash", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    fetchMock.mockResolvedValueOnce(statusResponse(403, "Forbidden"));
    submitMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(bannerText()).not.toBe("");
    expect(composerEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    widget.destroy();
  });

  it("429 on /v1/chat: shows a distinct rate-limit message and does not auto-retry", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    fetchMock.mockResolvedValueOnce(statusResponse(429, "Too Many Requests"));
    submitMessage("spam spam");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    const text = bannerText();
    expect(text.toLowerCase()).toMatch(/too many|slow down|moment|wait/);
    expect(composerEnabled()).toBe(true);
    // No auto-retry loop: open-session + single chat only.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    widget.destroy();
  });

  it("502 app_context_unavailable on /v1/chat: shows a specific banner and recovers the composer", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "app_context_unavailable" }), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "application/json" },
      }),
    );
    submitMessage("what is my balance?");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    const text = bannerText();
    expect(text).not.toBe("");
    expect(text.toLowerCase()).not.toContain("app_context_unavailable");
    expect(text.toLowerCase()).toMatch(/unavailable|try again|moment/);
    expect(composerEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    widget.destroy();
  });

  it("malformed JSON mid-stream: parser reports via onError, no corrupt bubble, composer re-enabled", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream([
          'event: message.delta\ndata: {"messageId":"m1","delta":"Hi"}\n\n',
          "event: message.delta\ndata: {bad json\n\n",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    submitMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-aics-banner][data-aics-status='error']")).not.toBeNull();
    expect(composerEnabled()).toBe(true);
    // The transcript must not be wedged: aria-busy is cleared.
    expect(document.querySelector("[data-aics-transcript]")?.getAttribute("aria-busy")).toBe(
      "false",
    );

    widget.destroy();
  });

  it("unknown/invalid SSE event shape: parser reports via onError, no crash, composer re-enabled", async () => {
    const onError = vi.fn();
    const widget = await openWidget(onError);
    fetchMock.mockResolvedValueOnce(
      new Response(sseStream(['event: bogus.event\ndata: {"foo":"bar"}\n\n']), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    submitMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-aics-banner][data-aics-status='error']")).not.toBeNull();
    expect(composerEnabled()).toBe(true);

    widget.destroy();
  });
});

describe("focus trap skips hidden controls", () => {
  let api: HostedClientApi;
  let fetchMock: ReturnType<typeof vi.fn>;
  let openWidgets: Widget[];

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    globalThis.__ventoraAiCsWidget = undefined;
    openWidgets = [];
    api = evalHostedClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // Tear down here rather than at the end of each test so a failing assertion
    // cannot leave a live document-level keydown listener behind for the next test.
    for (const widget of openWidgets) widget.destroy();
    globalThis.__ventoraAiCsWidget = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function openWidget(): Promise<Widget> {
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "sess_focus" }));
    const widget = api.AiCs.init(baseConfig());
    openWidgets.push(widget);
    await widget.open();
    return widget;
  }

  function query<T extends HTMLElement>(selector: string): T {
    const el = document.querySelector<T>(selector);
    if (el === null) throw new Error(`missing element: ${selector}`);
    return el;
  }

  function pressTab(shiftKey: boolean): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
    document.dispatchEvent(event);
    return event;
  }

  it("Shift+Tab from the first control lands on the stop button, not the hidden composer", async () => {
    const widget = await openWidget();
    const overflowButton = query<HTMLButtonElement>("[data-aics-overflow-button]");
    const composerInput = query<HTMLTextAreaElement>("[data-aics-composer] textarea");
    // A delta puts the widget into the streaming state: stop host shown, composer hidden.
    widget.handleEvent({ event: "message.delta", data: { messageId: "ft-m1", delta: "Hi" } });
    const stopButton = query<HTMLButtonElement>("[data-aics-stop]");
    expect(query("[data-aics-composer]").hidden).toBe(true);
    expect(query("[data-aics-stop-host]").hidden).toBe(false);

    overflowButton.focus();
    const event = pressTab(true);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stopButton);
    expect(document.activeElement).not.toBe(composerInput);
  });

  it("Tab from the stop button wraps to the first control instead of leaking out of the panel", async () => {
    const widget = await openWidget();
    const overflowButton = query<HTMLButtonElement>("[data-aics-overflow-button]");
    widget.handleEvent({ event: "message.delta", data: { messageId: "ft-m2", delta: "Hi" } });
    const stopButton = query<HTMLButtonElement>("[data-aics-stop]");

    stopButton.focus();
    const event = pressTab(false);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(overflowButton);
  });

  it("keeps the escalated (permanently hidden) composer out of the trap cycle", async () => {
    const widget = await openWidget();
    const overflowButton = query<HTMLButtonElement>("[data-aics-overflow-button]");
    const transcript = query<HTMLElement>("[data-aics-transcript]");
    const composer = query<HTMLFormElement>("[data-aics-composer]");
    const composerInput = query<HTMLTextAreaElement>("[data-aics-composer] textarea");
    widget.handleEvent({ event: "support.escalation.requested", data: { reason: "user" } });
    expect(composer.hidden).toBe(true);
    expect(composer.getAttribute("aria-hidden")).toBe("true");

    overflowButton.focus();
    const back = pressTab(true);

    // Every control after the transcript is inside a hidden host once escalation lands.
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(transcript);
    expect(document.activeElement).not.toBe(composerInput);

    // ...and forward Tab from that last visible control wraps back to the first.
    const forward = pressTab(false);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(overflowButton);
  });

  it("moves focus to the stop button when the focused composer is hidden for streaming", async () => {
    const widget = await openWidget();
    const composerInput = query<HTMLTextAreaElement>("[data-aics-composer] textarea");
    composerInput.focus();
    expect(document.activeElement).toBe(composerInput);

    widget.handleEvent({ event: "message.delta", data: { messageId: "ft-m3", delta: "Hi" } });

    const stopButton = query<HTMLButtonElement>("[data-aics-stop]");
    expect(document.activeElement).toBe(stopButton);
  });

  it("leaves focus alone when the composer did not hold focus at stream start", async () => {
    const widget = await openWidget();
    const overflowButton = query<HTMLButtonElement>("[data-aics-overflow-button]");
    overflowButton.focus();

    widget.handleEvent({ event: "message.delta", data: { messageId: "ft-m4", delta: "Hi" } });

    expect(document.activeElement).toBe(overflowButton);
  });

  it("returns focus to the composer when streaming ends, completing the round trip", async () => {
    const widget = await openWidget();
    const composerInput = query<HTMLTextAreaElement>("[data-aics-composer] textarea");
    composerInput.focus();
    widget.handleEvent({ event: "message.delta", data: { messageId: "ft-m5", delta: "Hi" } });
    expect(document.activeElement).toBe(query("[data-aics-stop]"));

    widget.handleEvent({ event: "message.done", data: { messageId: "ft-m5" } });

    expect(document.activeElement).toBe(composerInput);
    expect(query("[data-aics-composer]").hidden).toBe(false);
  });
});

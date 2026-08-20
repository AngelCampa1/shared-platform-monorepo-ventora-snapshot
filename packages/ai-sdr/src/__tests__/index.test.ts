import type { AiSdrSseEvent, CreateSessionRequest } from "@ventora/ai-sdr-contracts";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AiSdrApiError,
  type LeadCaptureSnapshot,
  createAiSdrSession,
  createAiSdrSseParser,
  createAiSdrWidget,
  requestAiSdrHandoff,
  sendAiSdrChatMessage,
} from "../index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(...frames: AiSdrSseEvent[]): Response {
  return new Response(
    frames
      .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function fetchMock(response: Response): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function encodeSse(frame: AiSdrSseEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
}

function controlledSseResponse(): {
  response: Response;
  enqueue(frame: AiSdrSseEvent): void;
  close(): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    enqueue(frame) {
      controller?.enqueue(encodeSse(frame));
    },
    close() {
      controller?.close();
    },
  };
}

describe("AI-SDR SSE parser", () => {
  it("parses typed events across chunks and ignores comments", () => {
    const parsed: AiSdrSseEvent[] = [];
    const parser = createAiSdrSseParser({ onEvent: (event) => parsed.push(event) });

    parser.feed(': keepalive\n\nevent: message.delta\ndata: {"messageId":"m1"');
    parser.feed(',"delta":"Hi"}\n\nevent: message.done\ndata: {"messageId":"m1"}\n\n');

    expect(parsed).toEqual([
      { event: "message.delta", data: { messageId: "m1", delta: "Hi" } },
      { event: "message.done", data: { messageId: "m1" } },
    ]);
  });

  it("reports malformed or schema-invalid SSE frames without stopping later events", () => {
    const parsed: AiSdrSseEvent[] = [];
    const errors: Error[] = [];
    const parser = createAiSdrSseParser({
      onEvent: (event) => parsed.push(event),
      onError: (error) => errors.push(error),
    });

    parser.feed("event: message.delta\ndata: nope\n\n");
    parser.feed('event: message.delta\ndata: {"messageId":"m1"}\n\n');
    parser.feed("event\ndata:{}\n\n");
    parser.feed('event: heartbeat\ndata: {"timestamp":"2026-05-13T00:00:00.000Z"}\n\n');

    expect(errors).toHaveLength(3);
    expect(errors.map((error) => error.message)).toEqual([
      "Invalid SSE JSON payload",
      "Invalid AI-SDR SSE event",
      "Invalid AI-SDR SSE event",
    ]);
    expect(parsed).toEqual([
      { event: "heartbeat", data: { timestamp: "2026-05-13T00:00:00.000Z" } },
    ]);
  });

  it("flushes the final frame and supports reset cleanup", () => {
    const parsed: AiSdrSseEvent[] = [];
    const parser = createAiSdrSseParser({ onEvent: (event) => parsed.push(event) });

    parser.feed('event: session.created\ndata: {"sessionId":"s1"}');
    parser.end();
    parser.feed('event: message.done\ndata: {"messageId":"old"}');
    parser.reset();
    parser.feed('event: heartbeat\ndata: {"timestamp":"now"}\n\n');

    expect(parsed).toEqual([
      { event: "session.created", data: { sessionId: "s1" } },
      { event: "heartbeat", data: { timestamp: "now" } },
    ]);
  });
});

describe("AI-SDR API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates sessions with a typed request and browser-safe headers", async () => {
    const request: CreateSessionRequest = { productId: "p1", visitorId: "v1" };
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));

    const result = await createAiSdrSession(
      { baseUrl: "https://ai.example", fetch: fetchFn },
      request,
    );

    expect(result).toEqual({ sessionId: "s1" });
    expect(fetchFn).toHaveBeenCalledWith("https://ai.example/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("invokes signRequest with the structured body and attaches HMAC headers", async () => {
    const request: CreateSessionRequest = { productId: "p1", visitorId: "v1" };
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const signRequest = vi.fn(async () => ({
      timestamp: "2026-05-01T00:00:00Z",
      nonce: "nonce-1",
      signature: "sig-1",
    }));

    await createAiSdrSession(
      {
        baseUrl: "https://ai.example",
        fetch: fetchFn,
        signRequest,
      },
      request,
    );

    expect(signRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/sessions",
      body: request,
      serializedBody: JSON.stringify(request),
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Timestamp")).toBe("2026-05-01T00:00:00Z");
    expect(headers.get("X-Ventora-Nonce")).toBe("nonce-1");
    expect(headers.get("X-Ventora-Signature")).toBe("sig-1");
  });

  it("falls back to clientAssertion when no signRequest is provided", async () => {
    const fetchFn = fetchMock(jsonResponse({ handoffId: "h1", status: "queued" }));

    await requestAiSdrHandoff(
      {
        baseUrl: "https://ai.example",
        fetch: fetchFn,
        clientAssertion: { timestamp: "ts-1", nonce: "nonce-1", signature: "sig-1" },
      },
      { sessionId: "s1", reason: "sales" },
    );

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Ventora-Timestamp")).toBe("ts-1");
    expect(headers.get("X-Ventora-Nonce")).toBe("nonce-1");
    expect(headers.get("X-Ventora-Signature")).toBe("sig-1");
  });

  it("sends chat and handoff requests with typed responses and abort signals", async () => {
    const controller = new AbortController();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse(
          { event: "message.delta", data: { messageId: "m1", delta: "Hello" } },
          { event: "message.done", data: { messageId: "m1" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ handoffId: "h1", status: "queued" }));

    await expect(
      sendAiSdrChatMessage(
        { baseUrl: "https://ai.example/", fetch: fetchFn },
        { sessionId: "s1", message: "Hello" },
        {
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual([
      { event: "message.delta", data: { messageId: "m1", delta: "Hello" } },
      { event: "message.done", data: { messageId: "m1" } },
    ]);
    await expect(
      requestAiSdrHandoff(
        { baseUrl: "https://ai.example", fetch: fetchFn },
        { sessionId: "s1", reason: "sales" },
      ),
    ).resolves.toEqual({
      handoffId: "h1",
      status: "queued",
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://ai.example/v1/chat",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://ai.example/v1/handoff",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("streams chat events through callbacks before the response closes", async () => {
    const stream = controlledSseResponse();
    const fetchFn = fetchMock(stream.response);
    const received: AiSdrSseEvent[] = [];
    const chatPromise = sendAiSdrChatMessage(
      { baseUrl: "https://ai.example", fetch: fetchFn },
      { sessionId: "s1", message: "Hello" },
      { onEvent: (event) => received.push(event) },
    );

    await nextTick();
    stream.enqueue({ event: "message.delta", data: { messageId: "m1", delta: "Hel" } });
    await nextTick();
    expect(received).toEqual([{ event: "message.delta", data: { messageId: "m1", delta: "Hel" } }]);

    stream.enqueue({ event: "message.delta", data: { messageId: "m1", delta: "lo" } });
    stream.enqueue({ event: "message.done", data: { messageId: "m1" } });
    stream.close();

    await expect(chatPromise).resolves.toEqual([
      { event: "message.delta", data: { messageId: "m1", delta: "Hel" } },
      { event: "message.delta", data: { messageId: "m1", delta: "lo" } },
      { event: "message.done", data: { messageId: "m1" } },
    ]);
  });

  it("parses non-streaming SSE response bodies when a fetch implementation has no readable body", async () => {
    const response = {
      ok: true,
      body: null,
      text: async () =>
        'event: message.delta\ndata: {"messageId":"m1","delta":"Plain"}\n\nevent: message.done\ndata: {"messageId":"m1"}\n\n',
    } as Response;

    await expect(
      sendAiSdrChatMessage(
        { baseUrl: "https://ai.example", fetch: fetchMock(response) },
        { sessionId: "s1", message: "Hello" },
      ),
    ).resolves.toEqual([
      { event: "message.delta", data: { messageId: "m1", delta: "Plain" } },
      { event: "message.done", data: { messageId: "m1" } },
    ]);
  });

  it("surfaces a typed API error for non-JSON error bodies without throwing a SyntaxError", async () => {
    const htmlErrorBody = new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html" },
    });

    await expect(
      sendAiSdrChatMessage(
        { baseUrl: "https://ai.example", fetch: fetchMock(htmlErrorBody) },
        { sessionId: "s1", message: "Hello" },
      ),
    ).rejects.toMatchObject({ name: "AiSdrApiError", status: 502, message: "Bad Gateway" });
  });

  it("returns already-collected events when a trailing SSE frame is malformed", async () => {
    const response = {
      ok: true,
      body: null,
      text: async () =>
        'event: message.delta\ndata: {"messageId":"m1","delta":"Hi"}\n\nevent: message.delta\ndata: not-json\n\n',
    } as Response;

    await expect(
      sendAiSdrChatMessage(
        { baseUrl: "https://ai.example", fetch: fetchMock(response) },
        { sessionId: "s1", message: "Hello" },
      ),
    ).resolves.toEqual([{ event: "message.delta", data: { messageId: "m1", delta: "Hi" } }]);
  });

  it("throws typed API errors for failed HTTP responses and invalid JSON shapes", async () => {
    await expect(
      createAiSdrSession(
        {
          baseUrl: "https://ai.example",
          fetch: fetchMock(jsonResponse({ message: "Nope" }, { status: 403 })),
        },
        {
          productId: "p1",
        },
      ),
    ).rejects.toMatchObject({ name: "AiSdrApiError", status: 403, message: "Nope" });

    await expect(
      createAiSdrSession(
        { baseUrl: "https://ai.example", fetch: fetchMock(jsonResponse({ id: "wrong" })) },
        {
          productId: "p1",
        },
      ),
    ).rejects.toThrow("Invalid create session response");

    expect(new AiSdrApiError("Bad gateway", 502).status).toBe(502);
  });

  it("validates chat and handoff response shapes", async () => {
    await expect(
      sendAiSdrChatMessage(
        { baseUrl: "https://ai.example", fetch: fetchMock(jsonResponse({ accepted: false })) },
        {
          sessionId: "s1",
          message: "Hello",
        },
      ),
    ).rejects.toThrow("Invalid AI-SDR SSE event");

    await expect(
      requestAiSdrHandoff(
        { baseUrl: "https://ai.example", fetch: fetchMock(jsonResponse({ handoffId: "h1" })) },
        {
          sessionId: "s1",
        },
      ),
    ).rejects.toThrow("Invalid handoff response");
  });

  it("throws parser errors from malformed streamed chat responses", async () => {
    await expect(
      sendAiSdrChatMessage(
        {
          baseUrl: "https://ai.example",
          fetch: fetchMock(
            new Response("event: message.delta\ndata: nope\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        },
        { sessionId: "s1", message: "Hello" },
      ),
    ).rejects.toThrow("Invalid SSE JSON payload");
  });

  it("uses fallback HTTP error messages and accepts empty response bodies", async () => {
    await expect(
      sendAiSdrChatMessage(
        {
          baseUrl: "https://ai.example",
          fetch: fetchMock(new Response(JSON.stringify({ error: "Retry later" }), { status: 503 })),
        },
        { sessionId: "s1", message: "Hello" },
      ),
    ).rejects.toMatchObject({ message: "Retry later", status: 503 });

    await expect(
      sendAiSdrChatMessage(
        {
          baseUrl: "https://ai.example",
          fetch: fetchMock(new Response("", { status: 500, statusText: "" })),
        },
        { sessionId: "s1", message: "Hello" },
      ),
    ).rejects.toMatchObject({ message: "AI-SDR request failed", status: 500 });
  });

  it("requires an available fetch implementation", async () => {
    vi.stubGlobal("fetch", undefined);

    await expect(
      createAiSdrSession({ baseUrl: "https://ai.example" }, { productId: "p1" }),
    ).rejects.toThrow("No fetch implementation available");
  });
});

describe("createAiSdrWidget", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders product-branded structure with accessible empty and input states", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "camaudit" },
    });

    await widget.open();

    const root = host.querySelector<HTMLElement>("[data-ai-sdr-widget]");
    const transcript = host.querySelector<HTMLElement>("[data-ai-sdr-transcript]");
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");

    expect(root).toBeInstanceOf(HTMLElement);
    expect(root?.dataset.aiSdrProduct).toBe("camaudit");
    expect(root?.style.getPropertyValue("--ai-sdr-accent")).toBe("#1f5a52");
    expect(root?.getAttribute("aria-label")).toBe("CAMAudit assistant conversation");
    expect(host.querySelector("[data-ai-sdr-heading]")?.tagName).toBe("H2");
    expect(transcript?.getAttribute("aria-live")).toBe("polite");
    expect(transcript?.getAttribute("aria-labelledby")).toBe("ai-sdr-camaudit-heading-1");
    expect(input?.getAttribute("aria-describedby")).toBe("ai-sdr-camaudit-empty-1");
    expect(host.textContent).toContain("Need help?");
    expect(host.textContent).toContain("Ask CAMAudit about pricing, fit, setup, or next steps.");
    expect(input?.getAttribute("placeholder")).toBe("Ask CAMAudit a question...");
    expect(send?.disabled).toBe(true);
    expect(send?.style.borderRadius).toBe("9999px");

    if (input instanceof HTMLTextAreaElement) {
      input.value = "What does setup include?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(send?.disabled).toBe(false);
  });

  it("renders assistant typography, CTA pills, and keeps separate message bubbles by message id", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.handleEvent({
      event: "message.delta",
      data: {
        messageId: "m1",
        delta: "**Annual** is the default.\n\n| Plan | Price |\n| --- | --- |\n| Pro | $99/mo |",
      },
    });
    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    widget.handleEvent({
      event: "message.delta",
      data: { messageId: "m2", delta: "Monthly is also available." },
    });
    widget.handleEvent({
      event: "message.delta",
      data: {
        messageId: "m3",
        delta: "*Monthly* details are at [pricing](https://app.example.com/pricing).",
      },
    });
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial", url: "https://app.example.com/trial" } },
    });

    const assistantMessages = host.querySelectorAll<HTMLElement>('[data-ai-sdr-role="assistant"]');
    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0]?.querySelector("strong")?.textContent).toBe("Annual");
    expect(assistantMessages[0]?.querySelector("ul")?.textContent).toContain("Plan: Pro");
    expect(assistantMessages[0]?.textContent).not.toContain("| --- |");
    expect(assistantMessages[1]?.textContent).toBe("Monthly is also available.");
    expect(assistantMessages[2]?.querySelector("em")?.textContent).toBe("Monthly");
    expect(assistantMessages[2]?.querySelector("a")?.href).toBe("https://app.example.com/pricing");

    const cta = host.querySelector<HTMLAnchorElement>("[data-ai-sdr-cta]");
    expect(cta?.textContent).toBe("Start trial");
    expect(cta?.href).toBe("https://app.example.com/trial");
    expect(cta?.rel).toBe("noopener noreferrer");
    expect(cta?.style.borderRadius).toBe("9999px");
  });

  it("does not render unsafe CTA URLs from API events", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial", url: "javascript:alert(document.domain)" } },
    });
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Protocol relative", url: "//evil.example/trial" } },
    });
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial", url: "/trial?productId=grantpipe" } },
    });

    const ctas = host.querySelectorAll<HTMLAnchorElement>("[data-ai-sdr-cta]");
    expect(ctas).toHaveLength(1);
    expect(ctas[0]?.textContent).toBe("Start trial");
    expect(ctas[0]?.getAttribute("href")).toBe("/trial?productId=grantpipe");
    expect(ctas[0]?.rel).toBe("noopener noreferrer");
  });

  it("renders source citations, plan recommendations, and handoff confirmations", async () => {
    const capture = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
      analytics: { posthog: { capture } },
    });

    await widget.open();
    widget.handleEvent({
      event: "source",
      data: { source: { id: "src_1", title: "Pricing docs", url: "https://app.example.com/docs" } },
    });
    widget.handleEvent({
      event: "plan.recommendation",
      data: {
        recommendation: {
          planId: "Pro",
          reason: "Best fit for your volume.",
          priceSummary: "$199/mo",
        },
      },
    });
    widget.handleEvent({
      event: "handoff.requested",
      data: { handoffId: "handoff_1", reason: "needs_sales" },
    });

    const source = host.querySelector<HTMLAnchorElement>("[data-ai-sdr-source]");
    expect(source?.textContent).toBe("Pricing docs");
    expect(source?.href).toBe("https://app.example.com/docs");
    expect(source?.rel).toBe("noopener noreferrer");

    const plan = host.querySelector<HTMLElement>("[data-ai-sdr-plan]");
    expect(plan?.querySelector("[data-ai-sdr-plan-name]")?.textContent).toBe("Pro");
    expect(plan?.querySelector("[data-ai-sdr-plan-price]")?.textContent).toBe("$199/mo");
    expect(plan?.querySelector("[data-ai-sdr-plan-reason]")?.textContent).toBe(
      "Best fit for your volume.",
    );

    const handoff = host.querySelector<HTMLElement>("[data-ai-sdr-handoff]");
    expect(handoff?.getAttribute("role")).toBe("status");
    expect(handoff?.textContent).toContain("in touch");

    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_plan_recommendation_shown",
      expect.objectContaining({ planId: "Pro" }),
    );
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_handoff_requested",
      expect.objectContaining({ handoffId: "handoff_1" }),
    );
  });

  it("rejects unsafe source URLs and dedupes repeated sources and plan cards", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.handleEvent({
      event: "source",
      data: { source: { id: "bad", title: "XSS", url: "javascript:alert(1)" } },
    });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "ok", title: "Docs", url: "https://app.example.com/docs" } },
    });
    widget.handleEvent({
      event: "source",
      data: { source: { id: "ok2", title: "Docs again", url: "https://app.example.com/docs" } },
    });
    widget.handleEvent({
      event: "plan.recommendation",
      data: { recommendation: { planId: "Pro", reason: "First." } },
    });
    widget.handleEvent({
      event: "plan.recommendation",
      data: { recommendation: { planId: "Pro", reason: "Updated." } },
    });

    // Only the one safe, deduped source survives.
    const sources = host.querySelectorAll("[data-ai-sdr-source]");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.textContent).toBe("Docs");

    // Only the latest plan card survives.
    const plans = host.querySelectorAll("[data-ai-sdr-plan]");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.querySelector("[data-ai-sdr-plan-reason]")?.textContent).toBe("Updated.");
  });

  it("uses the source URL as label when the title is empty", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s", title: "", url: "https://app.example.com/docs" } },
    });

    expect(host.querySelector("[data-ai-sdr-source]")?.textContent).toBe(
      "https://app.example.com/docs",
    );
  });

  it("ignores source, plan, and handoff render events after the widget is closed", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.close();

    expect(() => {
      widget.handleEvent({
        event: "source",
        data: { source: { id: "s", title: "Docs", url: "https://app.example.com/docs" } },
      });
      widget.handleEvent({
        event: "plan.recommendation",
        data: { recommendation: { planId: "Pro", reason: "Fit." } },
      });
      widget.handleEvent({
        event: "handoff.requested",
        data: { handoffId: "handoff_1" },
      });
    }).not.toThrow();
    expect(host.querySelector("[data-ai-sdr-source]")).toBeNull();
    expect(host.querySelector("[data-ai-sdr-plan]")).toBeNull();
    expect(host.querySelector("[data-ai-sdr-handoff]")).toBeNull();
  });

  it("dedupes trial CTA links across turns", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial", url: "https://app.example.com/trial" } },
    });
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial now", url: "https://app.example.com/trial?v=2" } },
    });

    const ctas = host.querySelectorAll<HTMLAnchorElement>("[data-ai-sdr-cta]");
    expect(ctas).toHaveLength(1);
    expect(ctas[0]?.textContent).toBe("Start trial now");
    expect(ctas[0]?.href).toBe("https://app.example.com/trial?v=2");
  });

  it("auto-scrolls the transcript on new content and sets aria-busy while streaming", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    const transcript = host.querySelector<HTMLElement>("[data-ai-sdr-transcript]");
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (transcript === null || input === null || send === null) {
      throw new Error("widget did not mount");
    }
    // jsdom has no layout; simulate an overflowing transcript so scrollTop is
    // meaningful.
    Object.defineProperty(transcript, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(transcript, "clientHeight", { value: 100, configurable: true });

    const scrollWrites: number[] = [];
    let scrollTopValue = 0;
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        scrollWrites.push(value);
      },
    });

    widget.handleEvent({
      event: "message.delta",
      data: { messageId: "m1", delta: "Streaming answer." },
    });

    expect(scrollWrites.at(-1)).toBe(500);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(send.getAttribute("aria-busy")).toBe("true");

    widget.handleEvent({ event: "message.done", data: { messageId: "m1" } });
    expect(input.getAttribute("aria-busy")).toBe("false");
    expect(send.getAttribute("aria-busy")).toBe("false");
  });

  it("does not auto-scroll when the user has scrolled up to read history", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    const transcript = host.querySelector<HTMLElement>("[data-ai-sdr-transcript]");
    if (transcript === null) {
      throw new Error("widget did not mount");
    }
    Object.defineProperty(transcript, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(transcript, "clientHeight", { value: 100, configurable: true });
    let scrollTopValue = 0; // far from bottom (distance 400)
    const scrollWrites: number[] = [];
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
        scrollWrites.push(value);
      },
    });

    // A source event should respect the user's scroll position.
    widget.handleEvent({
      event: "source",
      data: { source: { id: "s", title: "Docs", url: "https://app.example.com/docs" } },
    });

    expect(scrollWrites).toEqual([]);
  });

  it("tracks widget, send, receive, and CTA events through PostHog-compatible capture", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockResolvedValueOnce(
        sseResponse(
          { event: "message.delta", data: { messageId: "m1", delta: "Good fit." } },
          {
            event: "trial.cta",
            data: { cta: { label: "Start trial", url: "https://example.com/trial" } },
          },
          { event: "message.done", data: { messageId: "m1" } },
        ),
      );
    const capture = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe", visitorId: "visitor_1" },
      analytics: { posthog: { capture } },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Can I try it?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();

    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_widget_opened",
      expect.objectContaining({ productId: "grantpipe", visitorId: "visitor_1" }),
    );
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_message_sent",
      expect.objectContaining({ productId: "grantpipe", messageLength: 13 }),
    );
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_message_received",
      expect.objectContaining({ productId: "grantpipe", messageId: "m1" }),
    );
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_trial_cta_shown",
      expect.objectContaining({ productId: "grantpipe", label: "Start trial" }),
    );
  });

  it("continues widget open, send, receive, and CTA flows when PostHog capture throws", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockResolvedValueOnce(
        sseResponse(
          { event: "message.delta", data: { messageId: "m1", delta: "Still works." } },
          {
            event: "trial.cta",
            data: { cta: { label: "Start trial", url: "https://example.com/trial" } },
          },
          { event: "message.done", data: { messageId: "m1" } },
        ),
      );
    const capture = vi.fn<(event: string, properties?: Record<string, unknown>) => void>(() => {
      throw new Error("posthog offline");
    });
    const host = document.createElement("section");
    document.body.append(host);
    const errors: Error[] = [];
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe", visitorId: "visitor_1" },
      analytics: { posthog: { capture } },
      callbacks: { onError: (error) => errors.push(error) },
    });

    await expect(widget.open()).resolves.toBeUndefined();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Can I try it?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-ai-sdr-role="assistant"]')?.textContent).toBe("Still works.");
    expect(host.querySelector("[data-ai-sdr-cta]")?.textContent).toBe("Start trial");
    expect(errors).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it("falls back to global PostHog and title-cases unknown product ids", async () => {
    const capture = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
    vi.stubGlobal("posthog", { capture });
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "new_product-suite" },
    });

    await widget.open();

    expect(host.textContent).toContain("Ask New Product Suite");
    expect(capture).toHaveBeenCalledWith(
      "ai_sdr_widget_opened",
      expect.objectContaining({ productId: "new_product-suite", sessionId: "s1" }),
    );
    vi.unstubAllGlobals();
  });

  it("handles absent global PostHog, blank product names, and CTA events after close", async () => {
    vi.stubGlobal("posthog", {});
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "" },
    });

    await widget.open();
    expect(host.textContent).toContain("Ask Ventora");

    widget.close();
    widget.handleEvent({
      event: "trial.cta",
      data: { cta: { label: "Start trial", url: "https://example.com/trial" } },
    });

    expect(host.querySelector("[data-ai-sdr-cta]")).toBeNull();
  });

  it("sends with Enter, keeps Shift+Enter for new lines, and exposes pending state", async () => {
    let resolveChat: (response: Response) => void = () => undefined;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveChat = resolve;
          }),
      );
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    expect(input).toBeInstanceOf(HTMLTextAreaElement);
    expect(send).toBeInstanceOf(HTMLButtonElement);

    if (input instanceof HTMLTextAreaElement) {
      input.value = "Line one";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const shifted = new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(shifted);
      expect(shifted.defaultPrevented).toBe(false);

      const submitted = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(submitted);
      expect(submitted.defaultPrevented).toBe(true);
      input.value = "Second submit while pending";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    await nextTick();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://ai.example/v1/chat",
      expect.objectContaining({
        body: JSON.stringify({ sessionId: "s1", message: "Line one" }),
      }),
    );
    expect(send?.disabled).toBe(true);
    expect(host.querySelector("[data-ai-sdr-pending]")).not.toBeNull();

    resolveChat(
      sseResponse(
        { event: "message.delta", data: { messageId: "m1", delta: "Done." } },
        { event: "message.done", data: { messageId: "m1" } },
      ),
    );
    await nextTick();

    expect(host.textContent).toContain("Done.");
    expect(host.querySelector("[data-ai-sdr-pending]")).toBeNull();
  });

  it("uses fallback and override branding for unknown products", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "" },
      brand: { productName: "DealDesk", accentColor: "#123456" },
    });

    await widget.open();

    const root = host.querySelector<HTMLElement>("[data-ai-sdr-widget]");
    expect(root?.dataset.aiSdrProduct).toBe("ventora");
    expect(root?.style.getPropertyValue("--ai-sdr-accent")).toBe("#123456");
    expect(host.textContent).toContain("Ask DealDesk about pricing, fit, setup, or next steps.");
  });

  it("keeps generated widget description ids valid for punctuation product ids", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "!!!" },
    });

    await widget.open();

    const heading = host.querySelector<HTMLElement>("[data-ai-sdr-heading]");
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(heading?.id).toMatch(/^ai-sdr-ventora-heading-\d+$/);
    expect(input?.getAttribute("aria-describedby")).toMatch(/^ai-sdr-ventora-empty-\d+$/);
  });

  it("mounts, sends messages, dispatches typed callbacks, and cleans up", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockResolvedValueOnce(
        sseResponse(
          { event: "message.delta", data: { messageId: "m1", delta: "Plans start at" } },
          { event: "message.delta", data: { messageId: "m1", delta: " $49." } },
          { event: "message.done", data: { messageId: "m1" } },
        ),
      );
    const onEvent = vi.fn<(event: AiSdrSseEvent) => void>();
    const onError = vi.fn<(error: Error) => void>();
    const host = document.createElement("section");
    document.body.append(host);

    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "p1" },
      callbacks: { onEvent, onError },
    });

    expectTypeOf(onEvent).parameter(0).toEqualTypeOf<AiSdrSseEvent>();
    await widget.open();
    expect(host.querySelector("[data-ai-sdr-widget]")).not.toBeNull();
    expect(widget.getSessionId()).toBe("s1");

    const input = host.querySelector("textarea");
    const button = host.querySelector("button[data-ai-sdr-send]");
    expect(input).toBeInstanceOf(HTMLTextAreaElement);
    expect(button).toBeInstanceOf(HTMLButtonElement);
    input?.focus();
    if (input instanceof HTMLTextAreaElement && button instanceof HTMLButtonElement) {
      input.value = "I need pricing";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
    }

    await nextTick();
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://ai.example/v1/chat",
      expect.objectContaining({
        body: JSON.stringify({ sessionId: "s1", message: "I need pricing" }),
      }),
    );
    expect(host.textContent).toContain("I need pricing");
    expect(host.textContent).toContain("Plans start at $49.");

    widget.handleEvent({ event: "error", data: { code: "rate_limited", message: "Slow down" } });
    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Slow down" }));

    widget.destroy();
    expect(host.querySelector("[data-ai-sdr-widget]")).toBeNull();
    expect(widget.isOpen()).toBe(false);
  });

  it("reuses persisted widget sessions across page mounts and can start a new chat", async () => {
    const storage = new Map<string, string>();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_second" }));
    const firstHost = document.createElement("section");
    const secondHost = document.createElement("section");
    document.body.append(firstHost, secondHost);

    const firstWidget = createAiSdrWidget({
      target: firstHost,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe", visitorId: "visitor_1" },
      sessionStore: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    });
    await firstWidget.open();
    firstWidget.destroy();

    const secondWidget = createAiSdrWidget({
      target: secondHost,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe", visitorId: "visitor_1" },
      sessionStore: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    });
    await secondWidget.open();

    expect(secondWidget.getSessionId()).toBe("sess_first");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await secondWidget.startNewChat();

    expect(secondWidget.getSessionId()).toBe("sess_second");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(secondHost.querySelector('[data-ai-sdr-role="assistant"]')).toBeNull();
  });

  it("uses localStorage by default for widget session continuity", async () => {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_local" }));
    const firstHost = document.createElement("section");
    const secondHost = document.createElement("section");
    document.body.append(firstHost, secondHost);

    const firstWidget = createAiSdrWidget({
      target: firstHost,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "lextract", visitorId: "visitor_2" },
    });
    await firstWidget.open();
    firstWidget.destroy();

    const secondWidget = createAiSdrWidget({
      target: secondHost,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "lextract", visitorId: "visitor_2" },
    });
    await secondWidget.open();

    expect(secondWidget.getSessionId()).toBe("sess_local");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports start-new-chat failures and rejects after destroy", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockRejectedValueOnce("offline");
    const onError = vi.fn<(error: Error) => void>();
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_3" },
      callbacks: { onError },
    });

    await widget.open();
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "Keep me." } });
    await expect(widget.startNewChat()).rejects.toThrow("offline");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
    expect(widget.getSessionId()).toBe("sess_first");
    expect(host.textContent).toContain("Keep me.");

    widget.destroy();
    await expect(widget.startNewChat()).rejects.toThrow("Widget destroyed");
  });

  it("ignores stale in-flight chat events after starting a new chat", async () => {
    const oldStream = controlledSseResponse();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockResolvedValueOnce(oldStream.response)
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_second" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_stream" },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Old question";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();
    await widget.startNewChat();

    oldStream.enqueue({ event: "message.delta", data: { messageId: "old", delta: "Old answer" } });
    oldStream.close();
    await nextTick();

    expect(widget.getSessionId()).toBe("sess_second");
    expect(host.textContent).not.toContain("Old answer");
    expect(host.textContent).not.toContain("Old question");
  });

  it("rejects start-new-chat if the widget is destroyed after the session response", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_4" },
    });

    await widget.open();
    const newChatPromise = widget.startNewChat();
    widget.destroy();
    resolveFetch(jsonResponse({ sessionId: "late" }));

    await expect(newChatPromise).rejects.toThrow("Widget destroyed");
  });

  it("keeps the newer session when startup and new-chat creation overlap", async () => {
    let resolveInitial!: (response: Response) => void;
    let resolveNewChat!: (response: Response) => void;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveNewChat = resolve;
          }),
      );
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_overlap" },
    });

    const openPromise = widget.open();
    const newChatPromise = widget.startNewChat();
    resolveNewChat(jsonResponse({ sessionId: "sess_new" }));
    await expect(newChatPromise).resolves.toBeUndefined();
    resolveInitial(jsonResponse({ sessionId: "sess_initial" }));
    await expect(openPromise).resolves.toBeUndefined();

    expect(widget.getSessionId()).toBe("sess_new");
    expect(localStorage.getItem("ventora:ai-sdr:session:capveri:visitor_overlap")).toBe("sess_new");
  });

  it("keeps the latest session when two new-chat requests overlap", async () => {
    let resolveFirstNewChat!: (response: Response) => void;
    let resolveSecondNewChat!: (response: Response) => void;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstNewChat = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecondNewChat = resolve;
          }),
      );
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_new_overlap" },
    });

    await widget.open();
    const firstNewChat = widget.startNewChat();
    const secondNewChat = widget.startNewChat();
    resolveSecondNewChat(jsonResponse({ sessionId: "sess_latest" }));
    await expect(secondNewChat).resolves.toBeUndefined();
    resolveFirstNewChat(jsonResponse({ sessionId: "sess_stale" }));
    await expect(firstNewChat).resolves.toBeUndefined();

    expect(widget.getSessionId()).toBe("sess_latest");
  });

  it("does not cancel an active chat when starting a new chat fails", async () => {
    const oldStream = controlledSseResponse();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_first" }))
      .mockResolvedValueOnce(oldStream.response)
      .mockRejectedValueOnce(new Error("offline"));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "capveri", visitorId: "visitor_failed_new" },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Current question";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();
    await expect(widget.startNewChat()).rejects.toThrow("offline");
    oldStream.enqueue({
      event: "message.delta",
      data: { messageId: "current", delta: "Current answer" },
    });
    oldStream.close();
    await nextTick();

    expect(widget.getSessionId()).toBe("sess_first");
    expect(host.textContent).toContain("Current question");
    expect(host.textContent).toContain("Current answer");
  });

  it("continues when widget session storage is unavailable or throws", async () => {
    const throwingStore = {
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
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_one" }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: "sess_two" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "camaudit", visitorId: "visitor_5" },
      sessionStore: throwingStore,
    });

    await widget.open();
    await widget.startNewChat();

    expect(widget.getSessionId()).toBe("sess_two");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("falls back when global localStorage is not a session store", async () => {
    vi.stubGlobal("localStorage", null);
    const fetchFn = fetchMock(jsonResponse({ sessionId: "sess_no_store" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "camaudit", visitorId: "visitor_6" },
    });

    await widget.open();

    expect(widget.getSessionId()).toBe("sess_no_store");
  });

  it("aborts in-flight startup and prevents later DOM updates", async () => {
    const abortSignals: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) {
        abortSignals.push(init.signal);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "p1" },
    });

    const openPromise = widget.open();
    widget.destroy();
    await expect(openPromise).rejects.toThrow("Widget destroyed");

    expect(abortSignals).toHaveLength(1);
    expect(abortSignals[0]?.aborted).toBe(true);
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "ignored" } });
    expect(host.textContent).not.toContain("ignored");
  });

  it("handles repeated open, close, empty send, and async send failures", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockRejectedValueOnce("offline");
    const onError = vi.fn<(error: Error) => void>();
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "p1" },
      callbacks: { onError },
    });

    await widget.open();
    await widget.open();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const input = host.querySelector("textarea");
    const button = host.querySelector("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && button instanceof HTMLButtonElement) {
      input.value = "   ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
      input.value = "help";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));

    widget.close();
    expect(widget.isOpen()).toBe(false);
    widget.handleEvent({ event: "message.delta", data: { messageId: "m1", delta: "after close" } });
    widget.handleEvent({ event: "heartbeat", data: { timestamp: "now" } });
  });

  it("reports startup failures and rejects opening after destroy", async () => {
    const onError = vi.fn<(error: Error) => void>();
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: {
        baseUrl: "https://ai.example",
        fetch: fetchMock(new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })),
      },
      session: { productId: "p1" },
      callbacks: { onError },
    });

    await expect(widget.open()).rejects.toMatchObject({ status: 403 });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Forbidden" }));

    widget.destroy();
    await expect(widget.open()).rejects.toThrow("Widget destroyed");
  });

  it("rejects if destroyed after startup response resolves", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchFn = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "p1" },
    });

    const openPromise = widget.open();
    widget.destroy();
    resolveFetch(jsonResponse({ sessionId: "late" }));

    await expect(openPromise).rejects.toThrow("Widget destroyed");
    expect(widget.getSessionId()).toBeNull();
  });

  // Per-product theming sweep: mounting the widget for each product must apply
  // that product's brand palette as inline CSS custom properties
  // (--ai-sdr-accent / -accent-text / -surface / -text) on the [data-ai-sdr-widget]
  // root, so the SDR assistant visually adapts to the host app's brand. This is
  // the ai-sdr counterpart of the ai-cs per-brand theming assertion.
  async function mountBrandRoot(
    productId: string,
    brand?: { productName?: string; accentColor?: string },
  ): Promise<HTMLElement> {
    const fetchFn = fetchMock(jsonResponse({ sessionId: "brand-session" }));
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId },
      ...(brand !== undefined ? { brand } : {}),
    });
    await widget.open();
    const root = host.querySelector<HTMLElement>("[data-ai-sdr-widget]");
    if (root === null) throw new Error("ai-sdr widget root not found");
    // Snapshot the element before destroying so the caller can read inline styles
    // even after the root is detached from the document.
    widget.destroy();
    return root;
  }

  function readBrandVars(root: HTMLElement): {
    accent: string;
    accentText: string;
    surface: string;
    text: string;
  } {
    return {
      accent: root.style.getPropertyValue("--ai-sdr-accent"),
      accentText: root.style.getPropertyValue("--ai-sdr-accent-text"),
      surface: root.style.getPropertyValue("--ai-sdr-surface"),
      text: root.style.getPropertyValue("--ai-sdr-text"),
    };
  }

  // Stable product palettes pinned as a regression lock. Every shipped product
  // is pinned to its canonical accent (matching the deployed hosted-client and
  // @ventora/ai-cs presets) so the importable widget can never drift out of
  // sync with the rest of the brand surface.
  const STABLE_PRODUCT_BRANDS = [
    {
      productId: "camaudit",
      accent: "#1f5a52",
      accentText: "#ffffff",
      surface: "#fbfefd",
      text: "#071426",
    },
    {
      productId: "capveri",
      accent: "#4f46e5",
      accentText: "#ffffff",
      surface: "#fbfbff",
      text: "#141528",
    },
    {
      productId: "grantpipe",
      accent: "#15803d",
      accentText: "#ffffff",
      surface: "#fbfdf8",
      text: "#102015",
    },
    {
      productId: "lextract",
      accent: "#b45309",
      accentText: "#ffffff",
      surface: "#fffdfa",
      text: "#1d1712",
    },
  ] as const;

  it.each(STABLE_PRODUCT_BRANDS)(
    "applies the $productId brand palette as inline CSS vars on the widget root",
    async (expected) => {
      const root = await mountBrandRoot(expected.productId);
      expect(root.dataset.aiSdrProduct).toBe(expected.productId);
      const vars = readBrandVars(root);
      expect(vars.accent).toBe(expected.accent);
      expect(vars.accentText).toBe(expected.accentText);
      expect(vars.surface).toBe(expected.surface);
      expect(vars.text).toBe(expected.text);
    },
  );

  it("gives every shipped product a distinct accent so no two widgets look alike", async () => {
    const accents = new Map<string, string>();
    for (const { productId } of STABLE_PRODUCT_BRANDS) {
      const root = await mountBrandRoot(productId);
      const vars = readBrandVars(root);
      // Each token must be a well-formed 6-digit hex color.
      for (const value of Object.values(vars)) {
        expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      accents.set(productId, vars.accent.toLowerCase());
    }
    // Mutual distinctness: the count of unique accents equals the product count.
    // This guards against one product silently cloning another's palette.
    const uniqueAccents = new Set(accents.values());
    expect(uniqueAccents.size).toBe(STABLE_PRODUCT_BRANDS.length);
  });

  it("falls back to ventora default tokens for an unknown product id", async () => {
    const root = await mountBrandRoot("totally-unknown-product");
    const vars = readBrandVars(root);
    expect(vars.accent).toBe("#0f172a");
    expect(vars.accentText).toBe("#ffffff");
    expect(vars.surface).toBe("#f8fafc");
    expect(vars.text).toBe("#0f172a");
  });

  it("flows a brand override accent color through to the root var", async () => {
    const root = await mountBrandRoot("camaudit", { accentColor: "#abcdef" });
    const vars = readBrandVars(root);
    expect(vars.accent).toBe("#abcdef");
    // Non-overridden tokens still come from the camaudit preset.
    expect(vars.surface).toBe("#fbfefd");
  });

  it("aborts an in-flight chat stream when the panel is closed mid-stream", async () => {
    const stream = controlledSseResponse();
    const capturedSignals: Array<AbortSignal | null> = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockImplementationOnce((_input, init) => {
        capturedSignals.push((init?.signal as AbortSignal | undefined) ?? null);
        return Promise.resolve(stream.response);
      });
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Tell me about pricing";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();
    stream.enqueue({ event: "message.delta", data: { messageId: "m1", delta: "Strea" } });
    await nextTick();

    const chatSignal = capturedSignals[0];
    expect(chatSignal).toBeInstanceOf(AbortSignal);
    expect(chatSignal?.aborted).toBe(false);
    widget.close();
    expect(chatSignal?.aborted).toBe(true);
  });

  it("shows a visible error message in the transcript when the chat request fails", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const errors: Error[] = [];
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
      callbacks: { onError: (error) => errors.push(error) },
    });

    await widget.open();
    const input = host.querySelector("textarea");
    const send = host.querySelector<HTMLButtonElement>("button[data-ai-sdr-send]");
    if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
      input.value = "Does it integrate?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }
    await nextTick();

    expect(host.querySelector("[data-ai-sdr-pending]")).toBeNull();
    const errorMessage = host.querySelector<HTMLElement>("[data-ai-sdr-error]");
    expect(errorMessage).toBeInstanceOf(HTMLElement);
    expect(errorMessage?.getAttribute("role")).toBe("alert");
    expect(errorMessage?.textContent).toContain("Something went wrong");
    expect(errors).toHaveLength(1);
  });

  it("shows a visible error message in the transcript on an error SSE event", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }));
    const errors: Error[] = [];
    const host = document.createElement("section");
    document.body.append(host);
    const widget = createAiSdrWidget({
      target: host,
      api: { baseUrl: "https://ai.example", fetch: fetchFn },
      session: { productId: "grantpipe" },
      callbacks: { onError: (error) => errors.push(error) },
    });

    await widget.open();
    widget.handleEvent({
      event: "error",
      data: { code: "upstream_error", message: "upstream model failure" },
    });

    const errorMessage = host.querySelector<HTMLElement>("[data-ai-sdr-error]");
    expect(errorMessage).toBeInstanceOf(HTMLElement);
    expect(errorMessage?.textContent).toContain("Something went wrong");
    expect(errors).toHaveLength(1);
  });

  describe("double-mount singleton guard", () => {
    it("single mount still works normally", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s-single" }));
      const host = document.createElement("section");
      document.body.append(host);
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });

      await widget.open();

      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);
      expect(widget.getSessionId()).toBe("s-single");
      widget.destroy();
    });

    it("two createAiSdrWidget calls produce ONE [data-ai-sdr-widget] root and the second warns", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-first" }))
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-second" }));

      const firstHost = document.createElement("section");
      const secondHost = document.createElement("section");
      document.body.append(firstHost, secondHost);

      const firstWidget = createAiSdrWidget({
        target: firstHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await firstWidget.open();

      const secondWidget = createAiSdrWidget({
        target: secondHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await secondWidget.open();

      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(secondWidget.getSessionId()).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("[ai-sdr]");

      warnSpy.mockRestore();
      firstWidget.destroy();
    });

    it("does not repeat the warning for additional mounts after the first duplicate warning", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-base" }));

      const baseHost = document.createElement("section");
      document.body.append(baseHost);

      const baseWidget = createAiSdrWidget({
        target: baseHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await baseWidget.open();

      const dupHost1 = document.createElement("section");
      const dupHost2 = document.createElement("section");
      document.body.append(dupHost1, dupHost2);

      const dup1 = createAiSdrWidget({
        target: dupHost1,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await dup1.open();

      const dup2 = createAiSdrWidget({
        target: dupHost2,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
      });
      await dup2.open();

      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
      baseWidget.destroy();
    });

    it("startNewChat on a blocked (duplicate) widget is a no-op", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-primary" }));

      const primaryHost = document.createElement("section");
      const dupHost = document.createElement("section");
      document.body.append(primaryHost, dupHost);

      const primaryWidget = createAiSdrWidget({
        target: primaryHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await primaryWidget.open();

      const dupWidget = createAiSdrWidget({
        target: dupHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await dupWidget.open();

      // startNewChat on a blocked widget must also be a no-op
      await expect(dupWidget.startNewChat()).resolves.toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);

      warnSpy.mockRestore();
      primaryWidget.destroy();
    });

    it("teardown then re-mount works — destroy removes root so a new mount succeeds", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-first" }))
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s-remount" }));

      const firstHost = document.createElement("section");
      document.body.append(firstHost);

      const firstWidget = createAiSdrWidget({
        target: firstHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "lextract" },
      });
      await firstWidget.open();
      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);

      firstWidget.destroy();
      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(0);

      const secondHost = document.createElement("section");
      document.body.append(secondHost);

      const secondWidget = createAiSdrWidget({
        target: secondHost,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "camaudit" },
      });
      await secondWidget.open();

      expect(document.querySelectorAll("[data-ai-sdr-widget]")).toHaveLength(1);
      expect(secondWidget.getSessionId()).toBe("s-remount");
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      secondWidget.destroy();
    });
  });

  describe("lead.captured event and getCaptureSnapshot", () => {
    it("returns null from getCaptureSnapshot before any capture event", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
      });
      await widget.open();

      expect(widget.getCaptureSnapshot()).toBeNull();
    });

    it("sets the snapshot and fires onLeadCaptured with a copy after lead.captured", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const captured: LeadCaptureSnapshot[] = [];
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
        callbacks: {
          onLeadCaptured: (snapshot) => captured.push(snapshot),
        },
      });
      await widget.open();

      widget.handleEvent({ event: "lead.captured", data: { leadId: "lead_1", status: "new" } });

      const snapshot = widget.getCaptureSnapshot();
      expect(snapshot).toEqual({ leadId: "lead_1", status: "new" });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({ leadId: "lead_1", status: "new" });
    });

    it("fires PostHog ai_sdr_lead_captured with leadId and status", async () => {
      const capture = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
        analytics: { posthog: { capture } },
      });
      await widget.open();

      widget.handleEvent({
        event: "lead.captured",
        data: { leadId: "lead_2", status: "enriched" },
      });

      expect(capture).toHaveBeenCalledWith(
        "ai_sdr_lead_captured",
        expect.objectContaining({ leadId: "lead_2", status: "enriched" }),
      );
    });

    it("getCaptureSnapshot returns a defensive copy — mutating it does not change internal state", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
      });
      await widget.open();

      widget.handleEvent({ event: "lead.captured", data: { leadId: "lead_3", status: "new" } });

      const copy = widget.getCaptureSnapshot();
      expect(copy).not.toBeNull();
      if (copy !== null) {
        // Mutate the returned copy
        (copy as { leadId: string; status: string }).leadId = "mutated";
      }
      // Internal state must be unchanged
      expect(widget.getCaptureSnapshot()?.leadId).toBe("lead_3");
    });

    it("does not fire onLeadCaptured or update snapshot after destroy", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const captured: LeadCaptureSnapshot[] = [];
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
        callbacks: { onLeadCaptured: (s) => captured.push(s) },
      });
      await widget.open();
      widget.destroy();

      widget.handleEvent({
        event: "lead.captured",
        data: { leadId: "after_destroy", status: "new" },
      });

      expect(captured).toHaveLength(0);
      expect(widget.getCaptureSnapshot()).toBeNull();
    });
  });

  describe("renderHandoffConfirmation copy update", () => {
    it("shows the updated copy 'Thanks. We'll be in touch.' for handoff.requested SSE event", async () => {
      const fetchFn = fetchMock(jsonResponse({ sessionId: "s1" }));
      const host = document.createElement("section");
      document.body.append(host);
      const widget = createAiSdrWidget({
        target: host,
        api: { baseUrl: "https://ai.example", fetch: fetchFn },
        session: { productId: "grantpipe" },
      });
      await widget.open();

      widget.handleEvent({
        event: "handoff.requested",
        data: { handoffId: "h1", reason: "needs_sales" },
      });

      const handoff = host.querySelector<HTMLElement>("[data-ai-sdr-handoff]");
      expect(handoff?.textContent).toBe("Thanks. We'll be in touch.");
    });
  });
});

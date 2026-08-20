export * from "@ventora/ai-sdr-contracts";

import {
  type AiSdrSseEvent,
  type ChatRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type HandoffReceipt,
  type HandoffRequest,
  isAiSdrSseEvent,
} from "@ventora/ai-sdr-contracts";

export interface AiSdrApiConfig {
  baseUrl: string;
  fetch?: typeof fetch;
  signRequest?: AiSdrSignRequest;
  clientAssertion?: AiSdrSignedAssertion;
}

export interface AiSdrSignedAssertion {
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface AiSdrSignRequestInput {
  method: string;
  path: string;
  body: unknown;
  serializedBody: string;
}

export type AiSdrSignRequest = (
  input: AiSdrSignRequestInput,
) => Promise<AiSdrSignedAssertion> | AiSdrSignedAssertion;

export interface AiSdrRequestOptions {
  signal?: AbortSignal;
}

export interface AiSdrChatRequestOptions extends AiSdrRequestOptions {
  onEvent?: (event: AiSdrSseEvent) => void;
}

export class AiSdrApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AiSdrApiError";
    this.status = status;
  }
}

export interface AiSdrSseParser {
  feed(chunk: string): AiSdrSseEvent[];
  end(): AiSdrSseEvent[];
  reset(): void;
}

export interface AiSdrSseParserOptions {
  onEvent?: (event: AiSdrSseEvent) => void;
  onError?: (error: Error) => void;
}

export function createAiSdrSseParser(options: AiSdrSseParserOptions = {}): AiSdrSseParser {
  let buffer = "";

  const emitFrame = (frame: string): AiSdrSseEvent | null => {
    const lines = frame.split(/\r?\n/);
    let eventName = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line === "" || line.startsWith(":")) {
        continue;
      }
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (eventName === "" && dataLines.length === 0) {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      options.onError?.(new Error("Invalid SSE JSON payload"));
      return null;
    }

    const candidate = { event: eventName, data };
    if (!isAiSdrSseEvent(candidate)) {
      options.onError?.(new Error("Invalid AI-SDR SSE event"));
      return null;
    }

    options.onEvent?.(candidate);
    return candidate;
  };

  const drain = (flush: boolean): AiSdrSseEvent[] => {
    const events: AiSdrSseEvent[] = [];
    const delimiter = /\r?\n\r?\n/;
    let match = delimiter.exec(buffer);
    while (match !== null) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = emitFrame(frame);
      if (event !== null) {
        events.push(event);
      }
      match = delimiter.exec(buffer);
    }

    if (flush && buffer.trim() !== "") {
      const event = emitFrame(buffer);
      if (event !== null) {
        events.push(event);
      }
      buffer = "";
    }

    return events;
  };

  return {
    feed(chunk) {
      buffer += chunk;
      return drain(false);
    },
    end() {
      return drain(true);
    },
    reset() {
      buffer = "";
    },
  };
}

export async function createAiSdrSession(
  config: AiSdrApiConfig,
  request: CreateSessionRequest,
  options: AiSdrRequestOptions = {},
): Promise<CreateSessionResponse> {
  const json = await postJson(config, "/v1/sessions", request, options.signal);
  if (isRecord(json) && typeof json.sessionId === "string") {
    return { sessionId: json.sessionId };
  }
  throw new Error("Invalid create session response");
}

export async function sendAiSdrChatMessage(
  config: AiSdrApiConfig,
  request: ChatRequest,
  options: AiSdrChatRequestOptions = {},
): Promise<AiSdrSseEvent[]> {
  const response = await post(config, "/v1/chat", request, options.signal);
  if (!response.ok) {
    const text = await response.text();
    throw new AiSdrApiError(
      errorMessage(parseJsonOrNull(text), response.statusText),
      response.status,
    );
  }

  const errors: Error[] = [];
  const events: AiSdrSseEvent[] = [];
  const parser = createAiSdrSseParser({
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    onError: (error) => errors.push(error),
  });

  if (response.body === null) {
    const text = await response.text();
    parser.feed(text);
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value !== undefined) {
        parser.feed(decoder.decode(chunk.value, { stream: !done }));
      }
    }
    parser.feed(decoder.decode());
  }
  parser.end();

  if (events.length === 0) {
    if (errors[0] !== undefined) {
      throw errors[0];
    }
    throw new Error("Invalid AI-SDR SSE event");
  }
  return events;
}

export async function requestAiSdrHandoff(
  config: AiSdrApiConfig,
  request: HandoffRequest,
  options: AiSdrRequestOptions = {},
): Promise<HandoffReceipt> {
  const json = await postJson(config, "/v1/handoff", request, options.signal);
  if (isRecord(json) && typeof json.handoffId === "string" && typeof json.status === "string") {
    return { handoffId: json.handoffId, status: json.status };
  }
  throw new Error("Invalid handoff response");
}

export interface LeadCaptureSnapshot {
  leadId: string;
  status: string;
}

export interface AiSdrWidgetCallbacks {
  onEvent?: (event: AiSdrSseEvent) => void;
  onError?: (error: Error) => void;
  onLeadCaptured?: (snapshot: LeadCaptureSnapshot) => void;
}

export interface AiSdrPosthogClient {
  capture(event: string, properties?: Record<string, unknown>): void;
}

export interface AiSdrWidgetAnalytics {
  posthog?: AiSdrPosthogClient;
}

export interface AiSdrSessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AiSdrWidgetBrand {
  productName?: string;
  accentColor?: string;
  accentTextColor?: string;
  surfaceColor?: string;
  textColor?: string;
}

export interface AiSdrWidgetOptions {
  target: HTMLElement;
  api: AiSdrApiConfig;
  session: CreateSessionRequest;
  brand?: AiSdrWidgetBrand;
  callbacks?: AiSdrWidgetCallbacks;
  analytics?: AiSdrWidgetAnalytics;
  sessionStore?: AiSdrSessionStore;
}

export interface AiSdrWidget {
  open(): Promise<void>;
  close(): void;
  destroy(): void;
  isOpen(): boolean;
  getSessionId(): string | null;
  getCaptureSnapshot(): LeadCaptureSnapshot | null;
  startNewChat?(): Promise<void>;
  handleEvent(event: AiSdrSseEvent): void;
}

export interface AiSdrPersistentWidget extends AiSdrWidget {
  startNewChat(): Promise<void>;
}

let aiSdrDuplicateMountWarned = false;

export function createAiSdrWidget(options: AiSdrWidgetOptions): AiSdrPersistentWidget {
  let root: HTMLElement | null = null;
  let transcript: HTMLElement | null = null;
  let input: HTMLTextAreaElement | null = null;
  let sendButton: HTMLButtonElement | null = null;
  let pendingMessage: HTMLElement | null = null;
  let ctaElement: HTMLAnchorElement | null = null;
  let planCardElement: HTMLElement | null = null;
  const renderedSourceUrls = new Set<string>();
  const assistantMessagesById = new Map<string, HTMLElement>();
  const completedAssistantMessageIds = new Set<string>();
  let sessionId: string | null = null;
  let openState = false;
  let destroyed = false;
  let blocked = false;
  let sending = false;
  let startupController: AbortController | null = null;
  let chatController: AbortController | null = null;
  let conversationVersion = 0;
  let sessionRequestVersion = 0;
  let leadCaptureSnapshot: LeadCaptureSnapshot | null = null;
  const brand = resolveWidgetBrand(options.session.productId, options.brand);
  const posthog = resolvePosthog(options.analytics?.posthog);
  const widgetIds = resolveWidgetIds(brand.productId);
  const sessionStore = resolveSessionStore(options.sessionStore);
  const sessionStoreKey = aiSdrSessionStoreKey(options.session);

  const track = (event: string, properties: Record<string, unknown> = {}): void => {
    try {
      posthog?.capture(event, {
        productId: brand.productId,
        visitorId: options.session.visitorId,
        ...properties,
      });
    } catch {
      return;
    }
  };

  const ensureRoot = (): boolean => {
    if (root !== null) {
      return true;
    }
    const existingRoot = document.querySelector("[data-ai-sdr-widget]");
    if (existingRoot === null) {
      aiSdrDuplicateMountWarned = false;
    }
    if (existingRoot !== null) {
      blocked = true;
      if (!aiSdrDuplicateMountWarned) {
        aiSdrDuplicateMountWarned = true;
        console.warn(
          "[ai-sdr] A widget is already mounted on this page. " +
            "Call destroy() on the existing widget before mounting a new one. " +
            "The duplicate createAiSdrWidget mount has been ignored.",
        );
      }
      return false;
    }

    root = document.createElement("div");
    root.dataset.aiSdrWidget = "";
    root.dataset.aiSdrProduct = brand.productId;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", `${brand.productName} assistant conversation`);
    root.style.setProperty("--ai-sdr-accent", brand.accentColor);
    root.style.setProperty("--ai-sdr-accent-text", brand.accentTextColor);
    root.style.setProperty("--ai-sdr-surface", brand.surfaceColor);
    root.style.setProperty("--ai-sdr-text", brand.textColor);

    transcript = document.createElement("div");
    transcript.dataset.aiSdrTranscript = "";
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-relevant", "additions text");
    transcript.setAttribute("aria-labelledby", widgetIds.heading);

    const heading = document.createElement("h2");
    heading.dataset.aiSdrHeading = "";
    heading.id = widgetIds.heading;
    heading.textContent = "Need help?";

    renderEmptyState(transcript);

    input = document.createElement("textarea");
    input.setAttribute("aria-label", "Message");
    input.setAttribute("aria-describedby", widgetIds.empty);
    input.placeholder = `Ask ${brand.productName} a question...`;
    input.rows = 3;
    input.addEventListener("input", updateSendState);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendCurrentMessage();
      }
    });

    const send = document.createElement("button");
    send.type = "button";
    send.dataset.aiSdrSend = "";
    send.textContent = "Send";
    applyPillStyle(send);
    send.addEventListener("click", () => {
      void sendCurrentMessage();
    });
    sendButton = send;

    updateSendState();

    root.append(heading, transcript, input, send);
    options.target.append(root);
    return true;
  };

  const appendMessage = (
    role: "user" | "assistant" | "system",
    content: string,
  ): HTMLElement | null => {
    if (transcript === null || destroyed) {
      return null;
    }
    const message = document.createElement("div");
    message.dataset.aiSdrRole = role;
    if (role === "assistant") {
      message.dataset.aiSdrMessageText = content;
      renderRichText(message, content);
    } else {
      message.textContent = content;
    }
    transcript.append(message);
    scrollTranscriptToBottom();
    return message;
  };

  const isNearBottom = (): boolean => {
    if (transcript === null) {
      return true;
    }
    // Treat "no overflow yet" and "within a small threshold of the end" as near
    // bottom so streaming keeps following along, but a user who scrolled up to
    // read history is left alone.
    const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    return distance <= 40;
  };

  function scrollTranscriptToBottom(): void {
    if (transcript === null) {
      return;
    }
    transcript.scrollTop = transcript.scrollHeight;
  }

  const createSession = async (signal?: AbortSignal): Promise<string> => {
    const requestOptions: AiSdrRequestOptions = signal === undefined ? {} : { signal };
    const response = await createAiSdrSession(options.api, options.session, requestOptions);
    return response.sessionId;
  };

  const useSession = (nextSessionId: string): void => {
    writeStoredSessionId(nextSessionId);
    sessionId = nextSessionId;
    updateSendState();
    track("ai_sdr_widget_opened", { sessionId });
  };

  const sendCurrentMessage = async (): Promise<void> => {
    const message = input?.value.trim() ?? "";
    if (message === "" || sessionId === null || destroyed || sending) {
      return;
    }
    sending = true;
    const sendVersion = conversationVersion;
    const controller = new AbortController();
    chatController = controller;
    updateSendState();
    if (input !== null) {
      input.value = "";
    }
    appendMessage("user", message);
    track("ai_sdr_message_sent", { messageLength: message.length });
    showPendingMessage();
    setStreamingBusy(true);
    try {
      await sendAiSdrChatMessage(
        options.api,
        { sessionId, message },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (sendVersion === conversationVersion) {
              widget.handleEvent(event);
            }
          },
        },
      );
    } catch (error) {
      if (sendVersion === conversationVersion && !isAbortError(error)) {
        hidePendingMessage();
        showErrorMessage();
        options.callbacks?.onError?.(toError(error));
      }
    } finally {
      if (chatController === controller) {
        chatController = null;
      }
      if (sendVersion === conversationVersion) {
        hidePendingMessage();
        setStreamingBusy(false);
        sending = false;
        updateSendState();
      }
    }
  };

  function updateSendState(): void {
    const message = input?.value.trim() ?? "";
    if (sendButton !== null) {
      sendButton.disabled = message === "" || sessionId === null || destroyed || sending;
      sendButton.setAttribute("aria-disabled", String(sendButton.disabled));
    }
    if (input !== null) {
      input.disabled = destroyed;
    }
  }

  function showPendingMessage(): void {
    hidePendingMessage();
    pendingMessage = appendMessage("assistant", "Thinking...");
    pendingMessage?.setAttribute("data-ai-sdr-pending", "");
  }

  function hidePendingMessage(): void {
    pendingMessage?.remove();
    pendingMessage = null;
  }

  function showErrorMessage(): void {
    if (transcript === null || destroyed) {
      return;
    }
    const message = document.createElement("div");
    message.dataset.aiSdrRole = "system";
    message.dataset.aiSdrError = "";
    message.setAttribute("role", "alert");
    message.textContent = "Something went wrong. Please try again in a moment.";
    transcript.append(message);
  }

  function renderCta(label: string, url: string): void {
    if (transcript === null || destroyed) {
      return;
    }
    if (!isSafeLinkUrl(url)) {
      return;
    }
    const link = document.createElement("a");
    link.dataset.aiSdrCta = "";
    applySafeLink(link, url);
    link.textContent = label;
    applyPillStyle(link);
    // Dedupe: replace any prior CTA so repeated trial.cta events across turns do
    // not stack duplicate links in the transcript.
    ctaElement?.remove();
    ctaElement = link;
    transcript.append(link);
    scrollTranscriptToBottom();
  }

  function renderSource(source: { title: string; url: string }): void {
    if (transcript === null || destroyed) {
      return;
    }
    if (!isSafeLinkUrl(source.url)) {
      return;
    }
    const normalized = source.url.trim();
    // Dedupe sources by URL so the once-per-turn source event does not pile up
    // identical citations across turns.
    if (renderedSourceUrls.has(normalized)) {
      return;
    }
    renderedSourceUrls.add(normalized);
    const wasNearBottom = isNearBottom();
    const chip = document.createElement("a");
    chip.dataset.aiSdrSource = "";
    applySafeLink(chip, source.url);
    chip.textContent = source.title === "" ? source.url : source.title;
    applyPillStyle(chip);
    transcript.append(chip);
    if (wasNearBottom) {
      scrollTranscriptToBottom();
    }
  }

  function renderPlanRecommendation(recommendation: {
    planId: string;
    reason: string;
    priceSummary?: string;
  }): void {
    if (transcript === null || destroyed) {
      return;
    }
    const wasNearBottom = isNearBottom();
    const card = document.createElement("div");
    card.dataset.aiSdrPlan = "";
    const name = document.createElement("p");
    name.dataset.aiSdrPlanName = "";
    name.textContent = recommendation.planId;
    card.append(name);
    if (recommendation.priceSummary !== undefined && recommendation.priceSummary !== "") {
      const price = document.createElement("p");
      price.dataset.aiSdrPlanPrice = "";
      price.textContent = recommendation.priceSummary;
      card.append(price);
    }
    const reason = document.createElement("p");
    reason.dataset.aiSdrPlanReason = "";
    reason.textContent = recommendation.reason;
    card.append(reason);
    // Dedupe: replace the previous recommendation card rather than appending a
    // new one each turn.
    planCardElement?.remove();
    planCardElement = card;
    transcript.append(card);
    if (wasNearBottom) {
      scrollTranscriptToBottom();
    }
  }

  function renderHandoffConfirmation(): void {
    if (transcript === null || destroyed) {
      return;
    }
    const wasNearBottom = isNearBottom();
    const note = document.createElement("div");
    note.dataset.aiSdrRole = "system";
    note.dataset.aiSdrHandoff = "";
    note.setAttribute("role", "status");
    note.textContent = "Thanks. We'll be in touch.";
    transcript.append(note);
    if (wasNearBottom) {
      scrollTranscriptToBottom();
    }
  }

  function setStreamingBusy(busy: boolean): void {
    if (input !== null) {
      input.setAttribute("aria-busy", String(busy));
    }
    if (sendButton !== null) {
      sendButton.setAttribute("aria-busy", String(busy));
    }
  }

  function renderEmptyState(target: HTMLElement): void {
    const empty = document.createElement("div");
    empty.dataset.aiSdrEmpty = "";
    empty.id = widgetIds.empty;
    empty.textContent = `Ask ${brand.productName} about pricing, fit, setup, or next steps.`;
    target.append(empty);
  }

  function resetConversation(): void {
    if (transcript !== null) {
      transcript.replaceChildren();
      renderEmptyState(transcript);
    }
    pendingMessage = null;
    ctaElement = null;
    planCardElement = null;
    renderedSourceUrls.clear();
    assistantMessagesById.clear();
    completedAssistantMessageIds.clear();
  }

  function readStoredSessionId(): string | null {
    try {
      const stored = sessionStore?.getItem(sessionStoreKey) ?? null;
      return stored === "" ? null : stored;
    } catch {
      return null;
    }
  }

  function writeStoredSessionId(nextSessionId: string): void {
    try {
      sessionStore?.setItem(sessionStoreKey, nextSessionId);
    } catch {
      return;
    }
  }

  function clearStoredSessionId(): void {
    try {
      sessionStore?.removeItem(sessionStoreKey);
    } catch {
      return;
    }
  }

  const widget: AiSdrPersistentWidget = {
    async open() {
      if (destroyed) {
        throw new Error("Widget destroyed");
      }
      if (!ensureRoot() || blocked) {
        return;
      }
      openState = true;
      if (sessionId !== null) {
        return;
      }
      const storedSessionId = readStoredSessionId();
      if (storedSessionId !== null) {
        sessionId = storedSessionId;
        updateSendState();
        track("ai_sdr_widget_opened", { sessionId });
        return;
      }

      const requestVersion = sessionRequestVersion + 1;
      sessionRequestVersion = requestVersion;
      const controller = new AbortController();
      startupController = controller;
      try {
        const nextSessionId = await createSession(controller.signal);
        if (destroyed) {
          throw new Error("Widget destroyed");
        }
        if (requestVersion !== sessionRequestVersion) {
          return;
        }
        useSession(nextSessionId);
      } catch (error) {
        const normalized = destroyed ? new Error("Widget destroyed") : toError(error);
        options.callbacks?.onError?.(normalized);
        throw normalized;
      } finally {
        if (startupController === controller) {
          startupController = null;
        }
      }
    },
    close() {
      openState = false;
      startupController?.abort();
      chatController?.abort();
      root?.remove();
      root = null;
      transcript = null;
      input = null;
      sendButton = null;
      pendingMessage = null;
      ctaElement = null;
      planCardElement = null;
      renderedSourceUrls.clear();
      assistantMessagesById.clear();
      completedAssistantMessageIds.clear();
    },
    destroy() {
      destroyed = true;
      startupController?.abort();
      chatController?.abort();
      widget.close();
    },
    isOpen() {
      return openState;
    },
    getSessionId() {
      return sessionId;
    },
    getCaptureSnapshot() {
      return leadCaptureSnapshot === null ? null : { ...leadCaptureSnapshot };
    },
    async startNewChat() {
      if (destroyed) {
        throw new Error("Widget destroyed");
      }
      if (!ensureRoot() || blocked) {
        return;
      }
      openState = true;
      const requestVersion = sessionRequestVersion + 1;
      sessionRequestVersion = requestVersion;
      const controller = new AbortController();
      startupController = controller;
      try {
        const nextSessionId = await createSession(controller.signal);
        if (destroyed) {
          throw new Error("Widget destroyed");
        }
        if (requestVersion !== sessionRequestVersion) {
          return;
        }
        chatController?.abort();
        conversationVersion += 1;
        sending = false;
        resetConversation();
        clearStoredSessionId();
        useSession(nextSessionId);
      } catch (error) {
        const normalized = destroyed ? new Error("Widget destroyed") : toError(error);
        options.callbacks?.onError?.(normalized);
        throw normalized;
      } finally {
        if (startupController === controller) {
          startupController = null;
        }
      }
    },
    handleEvent(event) {
      if (destroyed) {
        return;
      }
      if (event.event === "message.delta") {
        const wasNearBottom = isNearBottom();
        hidePendingMessage();
        setStreamingBusy(true);
        let message = assistantMessagesById.get(event.data.messageId) ?? null;
        if (message === null && !completedAssistantMessageIds.has(event.data.messageId)) {
          message = appendMessage("assistant", "");
          if (message !== null) {
            assistantMessagesById.set(event.data.messageId, message);
          }
        }
        if (message !== null) {
          const current = message.dataset.aiSdrMessageText ?? "";
          const next = `${current}${event.data.delta}`;
          message.dataset.aiSdrMessageText = next;
          renderRichText(message, next);
        }
        if (wasNearBottom) {
          scrollTranscriptToBottom();
        }
      } else if (event.event === "source") {
        renderSource(event.data.source);
      } else if (event.event === "plan.recommendation") {
        renderPlanRecommendation(event.data.recommendation);
        track("ai_sdr_plan_recommendation_shown", {
          planId: event.data.recommendation.planId,
        });
      } else if (event.event === "message.done") {
        completedAssistantMessageIds.add(event.data.messageId);
        assistantMessagesById.delete(event.data.messageId);
        setStreamingBusy(false);
        track("ai_sdr_message_received", { messageId: event.data.messageId });
      } else if (event.event === "trial.cta") {
        renderCta(event.data.cta.label, event.data.cta.url);
        track("ai_sdr_trial_cta_shown", { label: event.data.cta.label, url: event.data.cta.url });
      } else if (event.event === "handoff.requested") {
        renderHandoffConfirmation();
        track("ai_sdr_handoff_requested", { handoffId: event.data.handoffId });
      } else if (event.event === "lead.captured") {
        leadCaptureSnapshot = { leadId: event.data.leadId, status: event.data.status };
        track("ai_sdr_lead_captured", { leadId: event.data.leadId, status: event.data.status });
        options.callbacks?.onLeadCaptured?.({ ...leadCaptureSnapshot });
      } else if (event.event === "error") {
        hidePendingMessage();
        setStreamingBusy(false);
        showErrorMessage();
        options.callbacks?.onError?.(new Error(event.data.message));
      }
      options.callbacks?.onEvent?.(event);
    },
  };

  return widget;
}

async function postJson(
  config: AiSdrApiConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await post(config, path, body, signal);
  const text = await response.text();
  const json = parseJsonOrNull(text);
  if (!response.ok) {
    throw new AiSdrApiError(errorMessage(json, response.statusText), response.status);
  }
  return json;
}

async function post(
  config: AiSdrApiConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (fetchFn === undefined) {
    throw new Error("No fetch implementation available");
  }
  const serializedBody = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof config.signRequest === "function") {
    const assertion = await Promise.resolve(
      config.signRequest({ method: "POST", path, body, serializedBody }),
    );
    headers["X-Ventora-Timestamp"] = assertion.timestamp;
    headers["X-Ventora-Nonce"] = assertion.nonce;
    headers["X-Ventora-Signature"] = assertion.signature;
  } else if (config.clientAssertion !== undefined) {
    headers["X-Ventora-Timestamp"] = config.clientAssertion.timestamp;
    headers["X-Ventora-Nonce"] = config.clientAssertion.nonce;
    headers["X-Ventora-Signature"] = config.clientAssertion.signature;
  }

  const init: RequestInit = {
    method: "POST",
    headers,
    body: serializedBody,
  };
  if (signal !== undefined) {
    init.signal = signal;
  }

  return fetchFn(`${config.baseUrl.replace(/\/+$/, "")}${path}`, init);
}

function parseJsonOrNull(text: string): unknown {
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (isRecord(value)) {
    if (typeof value.message === "string") {
      return value.message;
    }
    if (typeof value.error === "string") {
      return value.error;
    }
  }
  return fallback === "" ? "AI-SDR request failed" : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function resolvePosthog(explicit: AiSdrPosthogClient | undefined): AiSdrPosthogClient | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const candidate = (globalThis as { posthog?: unknown }).posthog;
  if (!isRecord(candidate)) {
    return undefined;
  }
  const capture = candidate.capture;
  return typeof capture === "function"
    ? { capture: (event, properties) => capture(event, properties) }
    : undefined;
}

function resolveSessionStore(
  explicit: AiSdrSessionStore | undefined,
): AiSdrSessionStore | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  return isSessionStore(candidate) ? candidate : undefined;
}

function isSessionStore(value: unknown): value is AiSdrSessionStore {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.getItem === "function" &&
    typeof value.setItem === "function" &&
    typeof value.removeItem === "function"
  );
}

function aiSdrSessionStoreKey(session: CreateSessionRequest): string {
  const productId = session.productId.trim().toLowerCase() || "ventora";
  const visitorId = session.visitorId?.trim() || "anonymous";
  return `ventora:ai-sdr:session:${encodeURIComponent(productId)}:${encodeURIComponent(visitorId)}`;
}

function applyPillStyle(element: HTMLElement): void {
  element.style.borderRadius = "9999px";
}

let widgetSequence = 0;

function resolveWidgetIds(productId: string): { heading: string; empty: string } {
  widgetSequence += 1;
  const base = productId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ventora";
  return {
    heading: `ai-sdr-${base}-heading-${widgetSequence}`,
    empty: `ai-sdr-${base}-empty-${widgetSequence}`,
  };
}

function renderRichText(target: HTMLElement, raw: string): void {
  target.replaceChildren();
  for (const block of markdownBlocks(raw)) {
    if (block.kind === "list") {
      const list = document.createElement("ul");
      for (const item of block.items) {
        const listItem = document.createElement("li");
        appendInlineMarkdown(listItem, item);
        list.append(listItem);
      }
      target.append(list);
    } else {
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, block.text);
      target.append(paragraph);
    }
  }
}

type MarkdownBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

function markdownBlocks(raw: string): MarkdownBlock[] {
  const normalized = normalizeMarkdownTables(raw);
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listItems.length > 0) {
      blocks.push({ kind: "list", items: listItems });
      listItems = [];
    }
  };

  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1] ?? "");
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks : [{ kind: "paragraph", text: "" }];
}

function normalizeMarkdownTables(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(next)) {
      const headers = tableCells(line);
      index += 1;
      while (index + 1 < lines.length && isMarkdownTableRow(lines[index + 1] ?? "")) {
        index += 1;
        const values = tableCells(lines[index] ?? "");
        const summary = headers
          .map((header, cellIndex) => `${header}: ${values[cellIndex] ?? ""}`)
          .join("; ");
        output.push(`- ${summary}`);
      }
    } else if (!isMarkdownTableSeparator(line)) {
      output.push(line);
    }
  }
  return output.join("\n");
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && tableCells(line).length > 1;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
}

function isSafeLinkUrl(value: string): boolean {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("//")) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}

function applySafeLink(link: HTMLAnchorElement, url: string): void {
  link.href = url.trim();
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
}

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index as number;
    parent.append(document.createTextNode(text.slice(lastIndex, index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else {
      const closeBracket = token.indexOf("](");
      const link = document.createElement("a");
      link.textContent = token.slice(1, closeBracket);
      applySafeLink(link, token.slice(closeBracket + 2, -1));
      parent.append(link);
    }
    lastIndex = index + token.length;
  }
  parent.append(document.createTextNode(text.slice(lastIndex)));
}

interface ResolvedAiSdrWidgetBrand {
  productId: string;
  productName: string;
  accentColor: string;
  accentTextColor: string;
  surfaceColor: string;
  textColor: string;
}

const productBrands: Record<string, ResolvedAiSdrWidgetBrand> = {
  camaudit: {
    productId: "camaudit",
    productName: "CAMAudit",
    // accent #1f5a52: 7.95:1 contrast vs #ffffff (WCAG AA normal text)
    accentColor: "#1f5a52",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfefd",
    textColor: "#071426",
  },
  capveri: {
    productId: "capveri",
    productName: "CapVeri",
    accentColor: "#4f46e5",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfbff",
    textColor: "#141528",
  },
  grantpipe: {
    productId: "grantpipe",
    productName: "GrantPipe",
    accentColor: "#15803d",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfdf8",
    textColor: "#102015",
  },
  lextract: {
    productId: "lextract",
    productName: "Lextract",
    accentColor: "#b45309",
    accentTextColor: "#ffffff",
    surfaceColor: "#fffdfa",
    textColor: "#1d1712",
  },
};

function resolveWidgetBrand(
  productId: string,
  override: AiSdrWidgetBrand = {},
): ResolvedAiSdrWidgetBrand {
  const key = productId.trim().toLowerCase();
  const fallback: ResolvedAiSdrWidgetBrand = {
    productId: key === "" ? "ventora" : key,
    productName: override.productName ?? titleCaseProduct(productId),
    accentColor: "#0f172a",
    accentTextColor: "#ffffff",
    surfaceColor: "#f8fafc",
    textColor: "#0f172a",
  };
  const base = productBrands[key] ?? fallback;
  return {
    ...base,
    productName: override.productName ?? base.productName,
    accentColor: override.accentColor ?? base.accentColor,
    accentTextColor: override.accentTextColor ?? base.accentTextColor,
    surfaceColor: override.surfaceColor ?? base.surfaceColor,
    textColor: override.textColor ?? base.textColor,
  };
}

function titleCaseProduct(productId: string): string {
  const cleaned = productId.trim();
  if (cleaned === "") {
    return "Ventora";
  }
  return cleaned
    .split(/[-_\s]+/)
    .filter((part) => part !== "")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

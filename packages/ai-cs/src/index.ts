export * from "@ventora/ai-cs-contracts";
export { isAiCsSseEvent, parseAiCsSseEventName } from "@ventora/ai-cs-contracts";

import {
  type AiCsChatRequest,
  type AiCsEscalationReceipt,
  type AiCsEscalationRequest,
  type AiCsSessionRequest,
  type AiCsSessionResponse,
  type AiCsSseEvent,
  isAiCsSseEvent,
} from "@ventora/ai-cs-contracts";

export interface AiCsSignedAssertion {
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface AiCsSignRequestInput {
  method: string;
  path: string;
  body: unknown;
  serializedBody: string;
}

export type AiCsSignRequest = (
  input: AiCsSignRequestInput,
) => Promise<AiCsSignedAssertion> | AiCsSignedAssertion;

export interface AiCsApiConfig {
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
  /**
   * Canonical request signer. The host application's backend mints HMAC
   * assertions and supplies this callback. Required for every authenticated
   * AI-CS API call (sessions, chat, escalations). The browser never holds
   * the HMAC secret directly.
   */
  signRequest?: AiCsSignRequest;
  /**
   * Optional pre-minted single-use assertion. When supplied without
   * `signRequest`, the same assertion is reused for every call — typically
   * only useful for short-lived flows or smoke tests. Prefer `signRequest`.
   */
  clientAssertion?: AiCsSignedAssertion;
}

export interface AiCsRequestOptions {
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
}

export interface AiCsChatRequestOptions extends AiCsRequestOptions {
  onEvent?: (event: AiCsSseEvent) => void;
}

export interface AiCsSessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AiCsSessionManagerOptions extends AiCsRequestOptions {
  sessionStore?: AiCsSessionStore;
}

export interface AiCsSessionManager {
  getSessionId(): string | null;
  getOrCreateSession(options?: AiCsRequestOptions): Promise<AiCsSessionResponse>;
  startNewChat(options?: AiCsRequestOptions): Promise<AiCsSessionResponse>;
  clearActiveSession(): void;
}

export class AiCsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AiCsApiError";
    this.status = status;
  }
}

const aiCsSessionCreations = new Map<string, Promise<AiCsSessionResponse>>();
const aiCsFetchIds = new WeakMap<object, number>();
const aiCsSignalIds = new WeakMap<object, number>();
const aiCsSessionStoreIds = new WeakMap<object, number>();
const aiCsSignRequestIds = new WeakMap<object, number>();
const aiCsSessionStoreGenerations = new Map<string, number>();
let aiCsFetchSequence = 0;
let aiCsSignalSequence = 0;
let aiCsSessionStoreSequence = 0;
let aiCsSignRequestSequence = 0;

export interface AiCsSseParser {
  feed(chunk: string): AiCsSseEvent[];
  end(): AiCsSseEvent[];
  reset(): void;
}

export interface AiCsSseParserOptions {
  onEvent?: (event: AiCsSseEvent) => void;
  onError?: (error: Error) => void;
}

export function createAiCsSseParser(options: AiCsSseParserOptions = {}): AiCsSseParser {
  let buffer = "";

  const emitFrame = (frame: string): AiCsSseEvent | null => {
    const lines = frame.split(/\r\n|\r|\n/);
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
    if (!isAiCsSseEvent(candidate)) {
      options.onError?.(new Error("Invalid AI-CS SSE event"));
      return null;
    }

    options.onEvent?.(candidate);
    return candidate;
  };

  const drain = (flush: boolean): AiCsSseEvent[] => {
    const events: AiCsSseEvent[] = [];
    const delimiter = /(\r\n|\r|\n){2}/;
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

export async function createAiCsSession(
  config: AiCsApiConfig,
  request: AiCsSessionRequest,
  options: AiCsRequestOptions = {},
): Promise<AiCsSessionResponse> {
  const json = await postJson(config, "/v1/sessions", request, options);
  if (isRecord(json) && typeof json.sessionId === "string") {
    return { sessionId: json.sessionId };
  }
  throw new Error("Invalid create session response");
}

export function createAiCsSessionManager(
  config: AiCsApiConfig,
  request: AiCsSessionRequest,
  options: AiCsSessionManagerOptions = {},
): AiCsSessionManager {
  const sessionStore = resolveSessionStore(options.sessionStore);
  const sessionStoreKey = aiCsSessionStoreKey(request);
  const sessionStoreGenerationKey = aiCsSessionStoreGenerationKey(sessionStore, sessionStoreKey);
  let sessionId: string | null = null;
  let sessionVersion = 0;

  const readStoredSessionId = (): string | null => {
    try {
      const stored = sessionStore?.getItem(sessionStoreKey) ?? null;
      return stored === "" ? null : stored;
    } catch {
      return null;
    }
  };

  const writeStoredSessionId = (nextSessionId: string): void => {
    try {
      sessionStore?.setItem(sessionStoreKey, nextSessionId);
    } catch {
      return;
    }
  };

  const clearStoredSessionId = (): void => {
    try {
      sessionStore?.removeItem(sessionStoreKey);
    } catch {
      return;
    }
  };

  const createAndStoreSession = (
    requestOptions: AiCsRequestOptions = {},
  ): Promise<AiCsSessionResponse> => {
    const mergedOptions = mergeRequestOptions(options, requestOptions);
    const creationVersion = sessionVersion;
    const storageGeneration = readSessionStoreGeneration(sessionStoreGenerationKey);
    return createSessionOnce(config, request, sessionStoreKey, mergedOptions, "resume").then(
      (response) => {
        if (
          creationVersion === sessionVersion &&
          storageGeneration === readSessionStoreGeneration(sessionStoreGenerationKey)
        ) {
          sessionId = response.sessionId;
          writeStoredSessionId(response.sessionId);
        }
        return response;
      },
    );
  };

  return {
    getSessionId() {
      return readStoredSessionId() ?? sessionId;
    },
    async getOrCreateSession(requestOptions = {}) {
      const existingSessionId = readStoredSessionId() ?? sessionId;
      if (existingSessionId !== null) {
        sessionId = existingSessionId;
        return { sessionId: existingSessionId };
      }
      return createAndStoreSession(requestOptions);
    },
    async startNewChat(requestOptions = {}) {
      const nextVersion = sessionVersion + 1;
      sessionVersion = nextVersion;
      const response = await createSessionOnce(
        config,
        request,
        sessionStoreKey,
        mergeRequestOptions(options, requestOptions),
        "new",
      );
      if (nextVersion !== sessionVersion) {
        return response;
      }
      sessionId = response.sessionId;
      advanceSessionStoreGeneration(sessionStoreGenerationKey);
      clearStoredSessionId();
      writeStoredSessionId(response.sessionId);
      return response;
    },
    clearActiveSession() {
      // Forget the cached session without a network call. Invalidating the
      // generation cancels any in-flight resume from binding its result, so the
      // next getOrCreateSession lazily creates a brand-new session.
      sessionVersion += 1;
      sessionId = null;
      advanceSessionStoreGeneration(sessionStoreGenerationKey);
      clearStoredSessionId();
    },
  };
}

function createSessionOnce(
  config: AiCsApiConfig,
  request: AiCsSessionRequest,
  sessionStoreKey: string,
  options: AiCsRequestOptions,
  purpose: "resume" | "new",
): Promise<AiCsSessionResponse> {
  const creationKey = aiCsSessionCreationKey(config, request, sessionStoreKey, options, purpose);
  let sharedCreation = aiCsSessionCreations.get(creationKey);
  if (sharedCreation === undefined) {
    sharedCreation = createAiCsSession(config, request, options).finally(() => {
      if (aiCsSessionCreations.get(creationKey) === sharedCreation) {
        aiCsSessionCreations.delete(creationKey);
      }
    });
    aiCsSessionCreations.set(creationKey, sharedCreation);
    // Keep an always-handled reference to the cached promise. Callers chain
    // their own `.then`/`await` (with their own error handling) off the value
    // we return, but a fire-and-forget caller (e.g. the widget's eager session
    // prefetch on open) attaches its `.catch` several async hops downstream.
    // Without this synchronous no-op handler the cached root promise can be
    // observed as an unhandled rejection in the gap before that downstream
    // handler is wired up. Swallowing here is safe: every real caller still
    // sees the rejection through the promise we return.
    sharedCreation.catch(() => {});
  }
  return sharedCreation;
}

export async function sendAiCsChatMessage(
  config: AiCsApiConfig,
  request: AiCsChatRequest,
  options: AiCsChatRequestOptions = {},
): Promise<AiCsSseEvent[]> {
  const response = await post(config, "/v1/chat", request, options);
  if (!response.ok) {
    const text = await response.text();
    throw new AiCsApiError(
      errorMessage(parseJsonOrNull(text), response.statusText),
      response.status,
    );
  }

  const errors: Error[] = [];
  const events: AiCsSseEvent[] = [];
  const parser = createAiCsSseParser({
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    onError: (error) => errors.push(error),
  });

  if (response.body == null) {
    parser.feed(await response.text());
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
    const trailing = decoder.decode();
    if (trailing !== "") {
      parser.feed(trailing);
    }
  }
  parser.end();

  if (errors[0] !== undefined) {
    throw errors[0];
  }
  if (events.length === 0) {
    throw new Error("Invalid AI-CS SSE event");
  }
  return events;
}

export async function requestAiCsSupportEscalation(
  config: AiCsApiConfig,
  request: AiCsEscalationRequest,
  options: AiCsRequestOptions = {},
): Promise<AiCsEscalationReceipt> {
  const json = await postJson(config, "/v1/escalations", request, options);
  if (isRecord(json) && typeof json.escalationId === "string" && typeof json.status === "string") {
    return { escalationId: json.escalationId, status: json.status };
  }
  throw new Error("Invalid support escalation response");
}

async function postJson(
  config: AiCsApiConfig,
  path: string,
  body: unknown,
  options: AiCsRequestOptions,
): Promise<unknown> {
  const response = await post(config, path, body, options);
  const text = await response.text();
  if (!response.ok) {
    throw new AiCsApiError(
      errorMessage(parseJsonOrNull(text), response.statusText),
      response.status,
    );
  }
  return parseJsonOrNull(text);
}

async function post(
  config: AiCsApiConfig,
  path: string,
  body: unknown,
  options: AiCsRequestOptions,
): Promise<Response> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (fetchFn === undefined) {
    throw new Error("No fetch implementation available");
  }
  const headers = new Headers(config.headers);
  new Headers(options.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
  const serializedBody = JSON.stringify(body);
  if (typeof config.signRequest === "function") {
    const assertion = await Promise.resolve(
      config.signRequest({ method: "POST", path, body, serializedBody }),
    );
    headers.set("X-Ventora-Timestamp", assertion.timestamp);
    headers.set("X-Ventora-Nonce", assertion.nonce);
    headers.set("X-Ventora-Signature", assertion.signature);
  } else if (config.clientAssertion !== undefined) {
    headers.set("X-Ventora-Timestamp", config.clientAssertion.timestamp);
    headers.set("X-Ventora-Nonce", config.clientAssertion.nonce);
    headers.set("X-Ventora-Signature", config.clientAssertion.signature);
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: serializedBody,
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const credentials = options.credentials ?? config.credentials;
  if (credentials !== undefined) {
    init.credentials = credentials;
  }
  return fetchFn(`${trimTrailingSlash(config.baseUrl)}${path}`, init);
}

function errorMessage(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === "string"
    ? json.error
    : fallback || "Request failed";
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function mergeRequestOptions(
  base: AiCsSessionManagerOptions,
  override: AiCsRequestOptions,
): AiCsRequestOptions {
  const merged: AiCsRequestOptions = {};
  if (base.signal !== undefined) {
    merged.signal = base.signal;
  }
  if (base.credentials !== undefined) {
    merged.credentials = base.credentials;
  }
  if (base.headers !== undefined) {
    merged.headers = base.headers;
  }
  if (override.signal !== undefined) {
    merged.signal = override.signal;
  }
  if (override.credentials !== undefined) {
    merged.credentials = override.credentials;
  }
  if (override.headers !== undefined) {
    merged.headers = mergeHeaders(base.headers, override.headers);
  }
  return merged;
}

function mergeHeaders(base: HeadersInit | undefined, override: HeadersInit): Headers {
  const headers = new Headers(base);
  new Headers(override).forEach((value, name) => {
    headers.set(name, value);
  });
  return headers;
}

function aiCsSessionCreationKey(
  config: AiCsApiConfig,
  request: AiCsSessionRequest,
  sessionStoreKey: string,
  options: AiCsRequestOptions,
  purpose: "resume" | "new",
): string {
  const headers = new Headers(config.headers);
  new Headers(options.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  return stableJsonKey({
    baseUrl: trimTrailingSlash(config.baseUrl),
    clientAssertion: aiCsClientAssertionIdentity(config.clientAssertion),
    credentials: options.credentials ?? config.credentials ?? "",
    fetch: aiCsFetchIdentity(config.fetch),
    headers: stableHeaders(headers),
    purpose,
    request: stableSessionRequest(request),
    sessionStoreKey,
    signRequest: aiCsSignRequestIdentity(config.signRequest),
    signal: aiCsSignalIdentity(options.signal),
  });
}

function aiCsSignRequestIdentity(signer: AiCsSignRequest | undefined): string {
  if (signer === undefined) {
    return "";
  }
  const existing = aiCsSignRequestIds.get(signer);
  if (existing !== undefined) {
    return String(existing);
  }
  aiCsSignRequestSequence += 1;
  aiCsSignRequestIds.set(signer, aiCsSignRequestSequence);
  return String(aiCsSignRequestSequence);
}

function aiCsClientAssertionIdentity(assertion: AiCsSignedAssertion | undefined): string {
  if (assertion === undefined) {
    return "";
  }
  return `${assertion.timestamp}:${assertion.nonce}:${assertion.signature}`;
}

function aiCsFetchIdentity(fetchFn: typeof fetch | undefined): string {
  if (fetchFn === undefined) {
    return "global";
  }
  const existing = aiCsFetchIds.get(fetchFn);
  if (existing !== undefined) {
    return String(existing);
  }
  aiCsFetchSequence += 1;
  aiCsFetchIds.set(fetchFn, aiCsFetchSequence);
  return String(aiCsFetchSequence);
}

function aiCsSignalIdentity(signal: AbortSignal | undefined): string {
  if (signal === undefined) {
    return "";
  }
  const existing = aiCsSignalIds.get(signal);
  if (existing !== undefined) {
    return String(existing);
  }
  aiCsSignalSequence += 1;
  aiCsSignalIds.set(signal, aiCsSignalSequence);
  return String(aiCsSignalSequence);
}

function aiCsSessionStoreIdentity(sessionStore: AiCsSessionStore): string {
  const existing = aiCsSessionStoreIds.get(sessionStore);
  if (existing !== undefined) {
    return String(existing);
  }
  aiCsSessionStoreSequence += 1;
  aiCsSessionStoreIds.set(sessionStore, aiCsSessionStoreSequence);
  return String(aiCsSessionStoreSequence);
}

function aiCsSessionStoreGenerationKey(
  sessionStore: AiCsSessionStore | undefined,
  sessionStoreKey: string,
): string | undefined {
  if (sessionStore === undefined) {
    return undefined;
  }
  return `${aiCsSessionStoreIdentity(sessionStore)}:${sessionStoreKey}`;
}

function readSessionStoreGeneration(generationKey: string | undefined): number {
  if (generationKey === undefined) {
    return 0;
  }
  return aiCsSessionStoreGenerations.get(generationKey) ?? 0;
}

function advanceSessionStoreGeneration(generationKey: string | undefined): void {
  if (generationKey === undefined) {
    return;
  }
  aiCsSessionStoreGenerations.set(generationKey, readSessionStoreGeneration(generationKey) + 1);
}

function stableSessionRequest(request: AiCsSessionRequest): Record<string, unknown> {
  return {
    appId: request.appId,
    currentPath: request.currentPath ?? "",
    metadata: stableMetadata(request.metadata),
    userId: request.userId,
  };
}

function stableMetadata(metadata: Record<string, string> | undefined): string[][] {
  if (metadata === undefined) {
    return [];
  }
  return Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
}

function stableHeaders(headers: Headers): string[][] {
  const entries: string[][] = [];
  headers.forEach((value, name) => {
    entries.push([name, value]);
  });
  return entries.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

function stableJsonKey(value: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function resolveSessionStore(explicit: AiCsSessionStore | undefined): AiCsSessionStore | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  return isSessionStore(candidate) ? candidate : undefined;
}

function isSessionStore(value: unknown): value is AiCsSessionStore {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.getItem === "function" &&
    typeof value.setItem === "function" &&
    typeof value.removeItem === "function"
  );
}

function aiCsSessionStoreKey(request: AiCsSessionRequest): string {
  return `ventora:ai-cs:session:${encodeURIComponent(request.appId)}:${encodeURIComponent(
    request.userId,
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Vanilla createAiCsWidget
// ---------------------------------------------------------------------------

export interface AiCsWidgetHandle {
  /** Remove the widget root from the DOM and release all resources. */
  destroy(): void;
}

export interface AiCsVanillaWidgetOptions {
  container?: HTMLElement;
  api: AiCsApiConfig;
  session: AiCsSessionRequest;
  brand?: string;
  position?: "bottom-right" | "bottom-left";
  locale?: string;
  defaultOpen?: boolean;
  /**
   * Callback invoked with the resolved React root unmount function once the
   * widget has been mounted. Primarily for internal / testing use.
   */
  onMounted?: (unmount: () => void) => void;
  /**
   * Injectable mount adapter. When supplied, skips the dynamic import of
   * React/ReactDOM and calls this function directly. Used in tests.
   * @internal
   */
  _mountAdapter?: (host: HTMLElement) => { unmount: () => void };
}

/**
 * Mount the AI-CS widget into the given container (or document.body) without
 * requiring an existing React tree in the host application.
 *
 * Double-mount guard: if a `[data-aics-root]` element is already present in
 * the document, this call is a no-op and returns a handle whose `destroy()`
 * is also a no-op. A warning is emitted once. Call `destroy()` on the
 * existing handle before mounting again.
 */
export function createAiCsWidget(options: AiCsVanillaWidgetOptions): AiCsWidgetHandle {
  /* v8 ignore next 3 */
  if (typeof document === "undefined") {
    return { destroy() {} };
  }

  // Double-mount guard: bail out if any AI-CS root is already in the DOM.
  const existing = document.querySelector("[data-aics-root]");
  if (existing !== null) {
    console.warn(
      "[createAiCsWidget] An AI-CS widget is already mounted. Only one instance is supported. Call destroy() on the existing handle before mounting again.",
    );
    return { destroy() {} };
  }

  // Create a host element for the React root.
  const mountHost = document.createElement("div");
  mountHost.setAttribute("data-aics-mount-host", "");
  (options.container ?? document.body).appendChild(mountHost);

  // Track the React root so destroy() can unmount cleanly.
  let reactUnmount: (() => void) | null = null;
  let destroyed = false;

  const performMount = (host: HTMLElement): Promise<void> => {
    if (options._mountAdapter !== undefined) {
      // Test-injectable path: skip dynamic imports.
      const root = options._mountAdapter(host);
      reactUnmount = () => root.unmount();
      options.onMounted?.(reactUnmount);
      return Promise.resolve();
    }
    // Production path: load React, ReactDOM, and the widget via dynamic imports
    // so that tree-shaking can remove them from API-only builds.
    /* v8 ignore next 30 */
    return Promise.all([
      import("react") as Promise<typeof import("react")>,
      import("react-dom/client") as Promise<typeof import("react-dom/client")>,
      import("./react/index.js") as Promise<typeof import("./react/index.js")>,
    ]).then(([React, ReactDomClient, { AiCsWidget }]) => {
      const domRoot = ReactDomClient.createRoot(host);
      type WidgetProps = Parameters<typeof AiCsWidget>[0];
      const widgetProps: WidgetProps = {
        api: options.api,
        session: options.session,
      };
      if (options.brand !== undefined) {
        widgetProps.brand = options.brand as unknown as NonNullable<WidgetProps["brand"]>;
      }
      if (options.position !== undefined) {
        widgetProps.position = options.position;
      }
      if (options.locale !== undefined) {
        widgetProps.locale = options.locale;
      }
      if (options.defaultOpen !== undefined) {
        widgetProps.defaultOpen = options.defaultOpen;
      }
      domRoot.render(React.createElement(AiCsWidget, widgetProps));
      reactUnmount = () => domRoot.unmount();
      options.onMounted?.(reactUnmount);
    });
  };

  void Promise.resolve().then(() => {
    if (destroyed) {
      // destroy() was called synchronously before the microtask fired.
      mountHost.remove();
      return;
    }
    // Re-check the guard after the async gap — a concurrent call may have won.
    if (document.querySelector("[data-aics-root]") !== null) {
      mountHost.remove();
      return;
    }
    return performMount(mountHost);
  });

  return {
    destroy() {
      destroyed = true;
      reactUnmount?.();
      reactUnmount = null;
      mountHost.remove();
    },
  };
}

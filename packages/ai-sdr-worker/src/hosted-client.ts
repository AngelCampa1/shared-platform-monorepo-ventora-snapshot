declare global {
  // eslint-disable-next-line no-var
  var __ventoraAiSdrWidget: { destroy: () => void } | null | undefined;
}

// AiSdrWidgetBrand — optional brand overrides accepted by createAiSdrWidget.
// iconUrl is a new optional field: when provided an <img> is shown in the launcher.
export interface AiSdrWidgetBrand {
  productName?: string;
  accentColor?: string;
  accentTextColor?: string;
  surfaceColor?: string;
  textColor?: string;
  iconUrl?: string;
}

// AiSdrWidgetCopy — all user-visible strings exposed for customization.
// Exported only as a type; the runtime shape lives inside hostedClientCore.
export interface AiSdrWidgetCopy {
  launcher: string;
  subtitle: string;
  placeholder: string;
  send: string;
  close: string;
  composerHint: string;
  emptyHeading: string;
  emptySuggestions: string[];
  offlineBanner: string;
  errorGeneric: string;
  errorSessionExpired: string;
  errorNetwork: string;
  retry: string;
  newMessages: string;
  stopGenerating: string;
  loading: string;
}

const hostedClientCore = String.raw`
const AI_SDR_STICK_THRESHOLD = 24;
const AI_SDR_MOBILE_BREAKPOINT = 640;
// A stored session id outlives the worker session (default TTL 86400s / 24h).
// Reusing an expired id makes the first /v1/chat 404 before the silent-recovery
// path mints a fresh one — functional, but it logs a stray network error on
// every returning visit. Proactively discard ids older than the worker TTL so
// the common "came back the next day" case mints fresh with no doomed request.
// The 404-recovery path stays as the backstop for early server-side eviction.
const AI_SDR_SESSION_STORE_TTL_MS = 86_400_000;

const AI_SDR_DEFAULT_COPY = {
  launcher: "Need help?",
  subtitle: "Replies in seconds",
  placeholder: "Ask {productName} a question…",
  send: "Send",
  close: "Close chat",
  composerHint: "Press Enter to send. Shift+Enter for a new line.",
  emptyHeading: "Hi, I’m {productName}’s AI assistant",
  emptySuggestions: ["What does it cost?", "How do I get started?"],
  offlineBanner: "You’re offline. Messages will send when you reconnect.",
  errorGeneric: "Could not send message. Tap retry to try again.",
  errorSessionExpired: "This chat session expired.",
  errorNetwork: "You appear to be offline.",
  retry: "Retry",
  newMessages: "{count} new",
  stopGenerating: "Stop generating",
  loading: "Loading…",
};

function resolveWidgetCopy(raw) {
  const defaultCopy = Object.assign({}, AI_SDR_DEFAULT_COPY);
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultCopy;
  }
  const merged = Object.assign({}, defaultCopy);
  for (const key of Object.keys(AI_SDR_DEFAULT_COPY)) {
    if (key === "emptySuggestions") {
      if (Array.isArray(raw[key]) && raw[key].every(function(s) { return typeof s === "string"; })) {
        merged[key] = raw[key];
      }
    } else if (typeof raw[key] === "string") {
      merged[key] = raw[key];
    }
  }
  return merged;
}

function isMobileBreakpoint() {
  try {
    const mql = globalThis.matchMedia?.("(max-width: " + AI_SDR_MOBILE_BREAKPOINT + "px)");
    return mql !== undefined && mql !== null && mql.matches === true;
  } catch {
    return false;
  }
}

class AiSdrApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AiSdrApiError";
    this.status = status;
  }
}

function createAiSdrSseParser(options = {}) {
  let buffer = "";

  const emitFrame = (frame) => {
    const lines = frame.split(/\r?\n/);
    let eventName = "";
    const dataLines = [];
    for (const line of lines) {
      if (line === "" || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
    }
    if (eventName === "" && dataLines.length === 0) return null;

    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      options.onError?.(new Error("Invalid SSE JSON payload"));
      return null;
    }

    const event = { event: eventName, data };
    if (!isAiSdrSseEvent(event)) {
      options.onError?.(new Error("Invalid AI-SDR SSE event"));
      return null;
    }
    options.onEvent?.(event);
    return event;
  };

  const drain = (flush) => {
    const events = [];
    const delimiter = /\r?\n\r?\n/;
    let match = delimiter.exec(buffer);
    while (match !== null) {
      const event = emitFrame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event !== null) events.push(event);
      match = delimiter.exec(buffer);
    }
    if (flush && buffer.trim() !== "") {
      const event = emitFrame(buffer);
      if (event !== null) events.push(event);
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

async function createAiSdrSession(config, request, options = {}) {
  const json = await postJson(config, "/v1/sessions", request, options.signal);
  if (isRecord(json) && typeof json.sessionId === "string") return { sessionId: json.sessionId };
  throw new Error("Invalid create session response");
}

async function sendAiSdrChatMessage(config, request, options = {}) {
  const response = await post(config, "/v1/chat", request, options.signal);
  if (!response.ok) {
    const text = await response.text();
    throw new AiSdrApiError(errorMessage(parseJsonOrNull(text), response.statusText), response.status);
  }

  const errors = [];
  const events = [];
  const parser = createAiSdrSseParser({
    onEvent(event) {
      events.push(event);
      options.onEvent?.(event);
    },
    onError(error) {
      errors.push(error);
    },
  });

  if (response.body === null) {
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
    parser.feed(decoder.decode());
  }
  parser.end();

  if (errors[0] !== undefined) throw errors[0];
  if (events.length === 0) throw new Error("Invalid AI-SDR SSE event");
  return events;
}

async function requestAiSdrHandoff(config, request, options = {}) {
  const json = await postJson(config, "/v1/handoff", request, options.signal);
  if (isRecord(json) && typeof json.handoffId === "string" && typeof json.status === "string") {
    return { handoffId: json.handoffId, status: json.status };
  }
  throw new Error("Invalid handoff response");
}

// Invariant: aiSdrInertRegistry tracks ref-counted inert/aria-hidden state per element so concurrent widgets layer correctly; an element is restored to its original state only when refCount reaches zero, widget roots in aiSdrLiveWidgetRoots are never inerted by other widgets, and ancestors of a newly-registered widget root are force-uninerted (with their refCount entries dropped from any prior holder) so a late-arriving widget is always operable.
// The registry is shared across all Ventora chat widgets (AI-SDR + AI-CS) via a Symbol.for key on globalThis so concurrent widgets from different bundles cooperate on ref-counts.
const VENTORA_INERT_REGISTRY_KEY = Symbol.for("ventora.chat.inertRegistry");
const VENTORA_LIVE_WIDGET_ROOTS_KEY = Symbol.for("ventora.chat.liveWidgetRoots");
const VENTORA_INERT_HOLDERS_KEY = Symbol.for("ventora.chat.inertHolders");
const aiSdrGlobalScope = globalThis;
function getSharedInertRegistry() {
  const slot = aiSdrGlobalScope[VENTORA_INERT_REGISTRY_KEY];
  if (slot instanceof WeakMap) return slot;
  const fresh = new WeakMap();
  aiSdrGlobalScope[VENTORA_INERT_REGISTRY_KEY] = fresh;
  return fresh;
}
function getSharedLiveWidgetRoots() {
  const slot = aiSdrGlobalScope[VENTORA_LIVE_WIDGET_ROOTS_KEY];
  if (slot instanceof Set) return slot;
  const fresh = new Set();
  aiSdrGlobalScope[VENTORA_LIVE_WIDGET_ROOTS_KEY] = fresh;
  return fresh;
}
function getSharedInertHolders() {
  const slot = aiSdrGlobalScope[VENTORA_INERT_HOLDERS_KEY];
  if (slot instanceof Set) return slot;
  const fresh = new Set();
  aiSdrGlobalScope[VENTORA_INERT_HOLDERS_KEY] = fresh;
  return fresh;
}
const aiSdrInertRegistry = getSharedInertRegistry();
const aiSdrLiveWidgetRoots = getSharedLiveWidgetRoots();
const aiSdrInertHolders = getSharedInertHolders();

function aiSdrRegisterInertHolder(element) {
  aiSdrInertHolders.add(element);
}

function aiSdrUnregisterInertHolder(element) {
  aiSdrInertHolders.delete(element);
}

function aiSdrForceUninert(element) {
  const entry = aiSdrInertRegistry.get(element);
  if (entry === undefined) return;
  aiSdrInertRegistry.delete(element);
  if (entry.prevAriaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", entry.prevAriaHidden);
  }
  if (entry.prevInert) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
  aiSdrInertHolders.delete(element);
}

// Ensures a newly-mounted widget root is operable even when an earlier widget
// already inerted one of its ancestors. Tradeoff: when widget B mounts inside
// an element widget A had inerted, that ancestor is force-uninerted, so A's
// modality no longer "covers" the other children of that ancestor while both
// widgets are open — B's operability takes precedence over A's modal reach.
function aiSdrClearInertOnAncestors(root) {
  let cursor = root.parentElement;
  while (cursor !== null) {
    aiSdrForceUninert(cursor);
    cursor = cursor.parentElement;
  }
}

function aiSdrAcquireInert(element) {
  const entry = aiSdrInertRegistry.get(element);
  if (entry !== undefined) {
    entry.refCount += 1;
    return;
  }
  aiSdrInertRegistry.set(element, {
    refCount: 1,
    prevInert: element.hasAttribute("inert"),
    prevAriaHidden: element.getAttribute("aria-hidden"),
  });
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
}

function aiSdrReleaseInert(element) {
  const entry = aiSdrInertRegistry.get(element);
  if (entry === undefined) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  aiSdrInertRegistry.delete(element);
  if (entry.prevAriaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", entry.prevAriaHidden);
  }
  if (entry.prevInert) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
}

function createAiSdrWidget(options) {
  const ui = {
    root: null,
    launcher: null,
    panel: null,
    header: null,
    closeButton: null,
    transcript: null,
    composer: null,
    sendButton: null,
    stopButton: null,
    loadingEl: null,
    newMessagesPill: null,
    handoffBanner: null,
    sourcesList: null,
    toast: null,
    toastTimer: null,
    styleEl: null,
    statusRegion: null,
    emptyDescription: null,
    headingId: "",
    emptyId: "",
    describeId: "",
  };
  let pendingMessage = null;
  let lastUserMessage = "";
  let lastUserBubble = null;
  let lastAssistantMessage = null;
  let lastSendError = null;
  let lastActiveElement = null;
  let composing = false;
  let stickToBottom = true;
  let unreadCount = 0;
  let closingTransitionTimer = null;
  let pendingTransitionEndListener = null;
  let streamingCount = 0;
  let viewportResizeHandler = null;
  let composerResizeObserver = null;
  let onlineHandler = null;
  let offlineHandler = null;
  let offlineBanner = null;
  // Siblings this instance contributed to the shared inert ref-count, so close() can decrement exactly what it incremented.
  const inertSiblings = [];
  const assistantMessagesById = new Map();
  const completedAssistantMessageIds = new Set();
  const sources = [];
  let sessionId = null;
  let openState = false;
  let destroyed = false;
  let sending = false;
  let startupController = null;
  let chatController = null;
  let conversationVersion = 0;
  let sessionRequestVersion = 0;
  let documentKeydownAttached = false;
  const brand = resolveWidgetBrand(options.session.productId, options.brand);
  const copy = resolveWidgetCopy(options.copy);
  const posthog = resolvePosthog(options.analytics?.posthog);
  const widgetIds = resolveWidgetIds(brand.productId);
  ui.headingId = widgetIds.heading;
  ui.emptyId = widgetIds.empty;
  ui.describeId = widgetIds.describe;
  const sessionStore = resolveSessionStore(options.sessionStore);
  const sessionStoreKey = aiSdrSessionStoreKey(options.session);
  const sessionStoreTimestampKey = sessionStoreKey + ":ts";
  const reducedMotion = prefersReducedMotion();
  const isRtl = detectRtl();

  const track = (event, properties = {}) => {
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

  const ensureStyles = () => {
    if (ui.styleEl !== null) return;
    const style = document.createElement("style");
    style.dataset.aiSdrStyles = "";
    style.textContent = widgetStyleSheet(reducedMotion);
    document.head.append(style);
    ui.styleEl = style;
  };

  const ensureRoot = () => {
    if (ui.root !== null) return;
    ensureStyles();
    const root = document.createElement("div");
    root.dataset.aiSdrWidget = "";
    root.dataset.aiSdrProduct = brand.productId;
    root.dataset.aiSdrDir = isRtl ? "rtl" : "ltr";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", brand.productName + " assistant conversation");
    root.style.setProperty("--ai-sdr-accent", brand.accentColor);
    root.style.setProperty("--ai-sdr-accent-text", brand.accentTextColor);
    root.style.setProperty("--ai-sdr-surface", brand.surfaceColor);
    root.style.setProperty("--ai-sdr-text", brand.textColor);
    // The brand defines explicit surface/text colors as inline custom properties,
    // which always outrank the auto dark-mode stylesheet rule. Mark the instance as
    // themed so the prefers-color-scheme:dark block opts out instead of half-applying
    // (which would leave a light brand surface with dark composer/bubbles).
    root.dataset.aiSdrTheme = "";
    if (reducedMotion) root.dataset.aiSdrReducedMotion = "";
    ui.root = root;
    aiSdrLiveWidgetRoots.add(root);
    buildLauncher();
    buildPanel();
    options.target.append(root);
    aiSdrClearInertOnAncestors(root);
  };

  function buildLauncher() {
    if (ui.root === null) return;
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.dataset.aiSdrLauncher = "";
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", widgetIds.panel);
    launcher.setAttribute("aria-label", copy.launcher);
    if (typeof brand.iconUrl === "string" && brand.iconUrl !== "" && isSafeLinkUrl(brand.iconUrl)) {
      const img = document.createElement("img");
      img.src = brand.iconUrl;
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      img.dataset.aiSdrLauncherIcon = "";
      launcher.append(img, document.createTextNode(copy.launcher));
    } else {
      launcher.textContent = copy.launcher;
    }
    launcher.addEventListener("click", () => {
      // open() surfaces its own error toast + onError callback and restores the
      // launcher on failure, then re-throws for programmatic callers. Swallow
      // that rejection here so a failed session-create (e.g. a transient
      // "Failed to fetch") never escapes as an unhandled promise rejection.
      void widget.open().catch(() => {});
    });
    ui.launcher = launcher;
    ui.root.append(launcher);
  }

  function buildPanel() {
    if (ui.root === null) return;
    const panel = document.createElement("div");
    panel.dataset.aiSdrPanel = "";
    panel.id = widgetIds.panel;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", widgetIds.heading);
    panel.hidden = true;
    ui.panel = panel;

    const header = document.createElement("header");
    header.dataset.aiSdrHeader = "";
    const headingWrap = document.createElement("div");
    headingWrap.dataset.aiSdrHeadingWrap = "";
    const heading = document.createElement("h2");
    heading.dataset.aiSdrHeading = "";
    heading.id = widgetIds.heading;
    heading.textContent = "Chat with " + brand.productName;
    headingWrap.append(heading);
    const subtitleText = typeof options.subtitle === "string" ? options.subtitle : copy.subtitle;
    if (subtitleText !== "") {
      const subtitle = document.createElement("span");
      subtitle.dataset.aiSdrSubtitle = "";
      subtitle.textContent = subtitleText;
      headingWrap.append(subtitle);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.aiSdrClose = "";
    close.setAttribute("aria-label", copy.close);
    close.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
    close.addEventListener("click", () => {
      widget.close();
    });
    ui.closeButton = close;
    header.append(headingWrap, close);
    ui.header = header;

    const transcript = document.createElement("div");
    transcript.dataset.aiSdrTranscript = "";
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-busy", "false");
    transcript.setAttribute("aria-labelledby", widgetIds.heading);
    transcript.tabIndex = 0;
    transcript.addEventListener("scroll", handleTranscriptScroll);
    ui.transcript = transcript;
    renderEmptyState(transcript);

    const statusRegion = document.createElement("div");
    statusRegion.dataset.aiSdrStatus = "";
    statusRegion.setAttribute("role", "status");
    statusRegion.setAttribute("aria-live", "polite");
    statusRegion.setAttribute("aria-atomic", "true");
    statusRegion.className = "ai-sdr-sr-only";
    ui.statusRegion = statusRegion;

    const banner = document.createElement("div");
    banner.dataset.aiSdrHandoffBanner = "";
    banner.setAttribute("role", "status");
    banner.hidden = true;
    ui.handoffBanner = banner;

    const sourcesList = document.createElement("ul");
    sourcesList.dataset.aiSdrSources = "";
    sourcesList.setAttribute("aria-label", "Sources");
    sourcesList.hidden = true;
    ui.sourcesList = sourcesList;

    const composerForm = document.createElement("form");
    composerForm.dataset.aiSdrComposer = "";
    composerForm.setAttribute("aria-label", "Send a message");
    composerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void sendCurrentMessage();
    });

    const describe = document.createElement("span");
    describe.dataset.aiSdrComposerDescribe = "";
    describe.id = widgetIds.describe;
    describe.textContent = copy.composerHint;
    describe.className = "ai-sdr-sr-only";
    ui.emptyDescription = describe;

    const composer = document.createElement("textarea");
    composer.dataset.aiSdrInput = "";
    composer.setAttribute("aria-label", "Message");
    composer.setAttribute("aria-describedby", widgetIds.describe);
    composer.placeholder = copy.placeholder.replace("{productName}", brand.productName);
    composer.rows = 1;
    composer.addEventListener("input", () => {
      autosizeComposer();
      updateSendState();
    });
    composer.addEventListener("keydown", handleComposerKey);
    composer.addEventListener("compositionstart", () => {
      composing = true;
    });
    composer.addEventListener("compositionend", () => {
      composing = false;
    });
    ui.composer = composer;

    const send = document.createElement("button");
    send.type = "submit";
    send.dataset.aiSdrSend = "";
    send.textContent = copy.send;
    ui.sendButton = send;

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.dataset.aiSdrStopGenerating = "";
    stopBtn.setAttribute("aria-label", copy.stopGenerating);
    stopBtn.setAttribute("aria-hidden", "true");
    stopBtn.setAttribute("inert", "");
    stopBtn.textContent = copy.stopGenerating;
    stopBtn.addEventListener("click", () => {
      if (chatController !== null) {
        const ctrl = chatController;
        chatController = null;
        ctrl.abort();
      }
    });
    ui.stopButton = stopBtn;

    const composerHintEl = document.createElement("small");
    composerHintEl.dataset.aiSdrComposerHint = "";
    composerHintEl.setAttribute("aria-hidden", "true");
    composerHintEl.textContent = copy.composerHint;
    composerForm.append(describe, composer, send);

    const toast = document.createElement("div");
    toast.dataset.aiSdrToast = "";
    toast.setAttribute("role", "status");
    toast.hidden = true;
    ui.toast = toast;

    const loadingEl = document.createElement("div");
    loadingEl.dataset.aiSdrLoading = "";
    loadingEl.setAttribute("role", "status");
    loadingEl.setAttribute("aria-label", copy.loading);
    loadingEl.hidden = true;
    ui.loadingEl = loadingEl;

    panel.append(header, loadingEl, transcript, statusRegion, banner, sourcesList, stopBtn, composerForm, composerHintEl, toast);
    ui.root.append(panel);
    updateSendState();
  }

  function handleComposerKey(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.isComposing === true || event.keyCode === 229 || composing) return;
      event.preventDefault();
      void sendCurrentMessage();
      return;
    }
    if (event.key === "ArrowUp" && ui.composer !== null && ui.composer.value === "" && lastUserMessage !== "") {
      event.preventDefault();
      ui.composer.value = lastUserMessage;
      autosizeComposer();
      updateSendState();
    }
  }

  function autosizeComposer() {
    const el = ui.composer;
    if (el === null) return;
    el.style.height = "auto";
    const next = Math.min(120, el.scrollHeight);
    el.style.height = next + "px";
  }

  function handleTranscriptScroll() {
    const transcript = ui.transcript;
    if (transcript === null) return;
    stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < AI_SDR_STICK_THRESHOLD;
    if (stickToBottom) {
      unreadCount = 0;
      hideNewMessagesPill();
    }
  }

  function showNewMessagesPill(increment = false) {
    if (ui.panel === null) return;
    if (increment) unreadCount += 1;
    if (ui.newMessagesPill !== null) {
      ui.newMessagesPill.textContent = copy.newMessages.replace("{count}", String(unreadCount));
      ui.newMessagesPill.setAttribute("aria-label", "Jump to latest messages");
      return;
    }
    const pill = document.createElement("button");
    pill.type = "button";
    pill.dataset.aiSdrNewMessages = "";
    pill.setAttribute("aria-label", "Jump to latest messages");
    pill.setAttribute("aria-live", "polite");
    pill.textContent = copy.newMessages.replace("{count}", String(unreadCount));
    pill.addEventListener("click", () => {
      if (ui.transcript !== null) ui.transcript.scrollTop = ui.transcript.scrollHeight;
      hideNewMessagesPill();
      stickToBottom = true;
    });
    ui.panel.append(pill);
    ui.newMessagesPill = pill;
    announceStatus(copy.newMessages.replace("{count}", String(unreadCount)));
  }

  function hideNewMessagesPill() {
    if (ui.newMessagesPill !== null) {
      ui.newMessagesPill.remove();
      ui.newMessagesPill = null;
      unreadCount = 0;
    }
  }

  function handleDocumentKey(event) {
    if (!openState || ui.panel === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      widget.close();
      return;
    }
    if (event.key !== "Tab" || !isMobileBreakpoint()) return;
    const focusables = focusableElements(ui.panel);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inPanel = active instanceof Node && ui.panel.contains(active);
    if (!inPanel) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function attachDocumentKeydown() {
    if (documentKeydownAttached) return;
    document.addEventListener("keydown", handleDocumentKey, true);
    documentKeydownAttached = true;
  }

  function detachDocumentKeydown() {
    if (!documentKeydownAttached) return;
    document.removeEventListener("keydown", handleDocumentKey, true);
    documentKeydownAttached = false;
  }

  function markBackgroundInert() {
    if (ui.root === null) return;
    const body = document.body;
    if (body === null) return;
    const children = body.children;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!(child instanceof HTMLElement)) continue;
      if (child === ui.root || child.contains(ui.root)) continue;
      if (aiSdrLiveWidgetRoots.has(child)) continue;
      let containsOtherRoot = false;
      for (const otherRoot of aiSdrLiveWidgetRoots) {
        if (otherRoot !== ui.root && child.contains(otherRoot)) {
          containsOtherRoot = true;
          break;
        }
      }
      if (containsOtherRoot) continue;
      aiSdrAcquireInert(child);
      inertSiblings.push(child);
      aiSdrRegisterInertHolder(child);
    }
  }

  function restoreBackgroundInert() {
    while (inertSiblings.length > 0) {
      const element = inertSiblings.pop();
      if (element === undefined) continue;
      aiSdrReleaseInert(element);
      aiSdrUnregisterInertHolder(element);
    }
  }

  function syncResponsiveModalState() {
    if (ui.panel === null || !openState) return;
    restoreBackgroundInert();
    if (isMobileBreakpoint()) {
      ui.panel.setAttribute("aria-modal", "true");
      markBackgroundInert();
    } else {
      ui.panel.setAttribute("aria-modal", "false");
    }
  }

  function focusableElements(container) {
    const selector = 'button:not([disabled]), [href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const list = [];
    const nodes = container.querySelectorAll(selector);
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!(node instanceof HTMLElement)) continue;
      if (node.hidden) continue;
      // Stop button uses aria-hidden="true" + no data-visible when inactive — skip it
      if (node.getAttribute("aria-hidden") === "true") continue;
      list.push(node);
    }
    return list;
  }

  function announceStatus(message) {
    if (ui.statusRegion === null) return;
    ui.statusRegion.textContent = "";
    ui.statusRegion.textContent = message;
  }

  function showToast(message, kind, action, allowRetry) {
    if (ui.toast === null) return;
    const persist = kind === "error";
    ui.toast.hidden = false;
    ui.toast.setAttribute("role", "status");
    ui.toast.dataset.aiSdrToastKind = persist ? "error" : "info";
    ui.toast.replaceChildren();
    const text = document.createElement("span");
    text.textContent = message;
    ui.toast.append(text);
    const customAction = action === undefined ? null : action;
    if (customAction !== null) {
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.aiSdrToastAction = "";
      actionButton.textContent = customAction.label;
      actionButton.addEventListener("click", () => {
        hideToast();
        customAction.run();
      });
      ui.toast.append(actionButton);
    } else if (kind === "error" && allowRetry !== false) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.aiSdrToastRetry = "";
      retry.textContent = copy.retry;
      retry.addEventListener("click", () => {
        hideToast();
        void retryLastSend();
      });
      ui.toast.append(retry);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.dataset.aiSdrToastDismiss = "";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      hideToast();
    });
    ui.toast.append(dismiss);
    if (ui.toastTimer !== null) {
      clearTimeout(ui.toastTimer);
      ui.toastTimer = null;
    }
    if (!persist) {
      ui.toastTimer = setTimeout(() => {
        hideToast();
      }, 6000);
    }
  }

  function classifySendError(error) {
    const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
    if (status === 429) {
      return { message: "You're sending messages too quickly. Try again in a moment.", action: null, allowRetry: false, errorKind: "quota" };
    }
    if (status === 401 || status === 403 || status === 410) {
      return {
        message: copy.errorSessionExpired,
        action: {
          label: "Start new chat",
          run: () => {
            clearStoredSessionId();
            void widget.startNewChat();
          },
        },
        allowRetry: false,
        errorKind: "session",
      };
    }
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      return { message: copy.errorNetwork, action: null, allowRetry: false, errorKind: "network" };
    }
    return { message: copy.errorGeneric, action: null, allowRetry: true, errorKind: "generic" };
  }

  function hideToast() {
    if (ui.toast === null) return;
    ui.toast.hidden = true;
    ui.toast.replaceChildren();
    if (ui.toastTimer !== null) {
      clearTimeout(ui.toastTimer);
      ui.toastTimer = null;
    }
  }

  async function retryLastSend() {
    if (lastUserMessage === "" || sending || sessionId === null) return;
    await sendMessageText(lastUserMessage, true);
  }

  function clearEmptyState() {
    if (ui.transcript === null) return;
    const empty = ui.transcript.querySelector("[data-ai-sdr-empty]");
    if (empty !== null) empty.remove();
  }

  const appendMessage = (role, content) => {
    if (ui.transcript === null || destroyed) return null;
    clearEmptyState();
    const bubble = document.createElement("div");
    bubble.dataset.aiSdrRole = role;
    bubble.dataset.aiSdrBubble = "";
    if (role === "assistant") {
      bubble.dataset.aiSdrMessageText = content;
      const body = document.createElement("div");
      body.dataset.aiSdrBubbleBody = "";
      renderRichText(body, content);
      bubble.append(body);
      const actions = document.createElement("div");
      actions.dataset.aiSdrBubbleActions = "";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.aiSdrCopy = "";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        void copyText(bubble.dataset.aiSdrMessageText ?? "");
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      });
      actions.append(copy);
      bubble.append(actions);
    } else {
      bubble.textContent = content;
    }
    ui.transcript.append(bubble);
    if (stickToBottom) {
      ui.transcript.scrollTop = ui.transcript.scrollHeight;
    } else if (role === "assistant") {
      showNewMessagesPill();
    }
    return bubble;
  };

  async function copyText(text) {
    try {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined && typeof clipboard.writeText === "function") {
        await clipboard.writeText(text);
        announceStatus("Copied to clipboard");
      }
    } catch {
      return;
    }
  }

  function showRetryOnLastAssistant() {
    if (lastAssistantMessage === null) return;
    const existing = lastAssistantMessage.querySelector('[data-ai-sdr-retry]');
    if (existing !== null) return;
    const actions = lastAssistantMessage.querySelector('[data-ai-sdr-bubble-actions]');
    if (actions === null) return;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.aiSdrRetry = "";
    retry.textContent = copy.retry;
    retry.addEventListener("click", () => {
      void retryLastSend();
    });
    actions.append(retry);
  }

  async function sendCurrentMessage() {
    const message = ui.composer?.value.trim() ?? "";
    if (message === "" || sessionId === null || destroyed || sending) return;
    if (ui.composer !== null) ui.composer.value = "";
    await sendMessageText(message);
  }

  async function sendMessageText(message, skipUserBubble = false) {
    if (sessionId === null || destroyed || sending) return;
    if (isOffline()) {
      showOfflineBanner();
      updateSendState();
      return;
    }
    sending = true;
    lastSendError = null;
    hideToast();
    const sendVersion = conversationVersion;
    const controller = new AbortController();
    chatController = controller;
    updateSendState();
    if (ui.transcript !== null) ui.transcript.setAttribute("aria-busy", "true");
    if (!skipUserBubble) {
      lastUserBubble = appendMessage("user", message);
      lastUserMessage = message;
    }
    // On retry sends (skipUserBubble) reuse the persisted bubble so a repeat
    // failure can re-apply the failed decoration instead of losing it.
    const userBubbleRef = lastUserBubble;
    track("ai_sdr_message_sent", { messageLength: message.length });
    showPendingMessage();
    try {
      // Returning visitors may carry a stored session id that was evicted or expired on the
      // worker. Transparently recover once: clear the stale id, mint a fresh session, and retry.
      let recovered = false;
      const trySend = async (currentSessionId) => {
        try {
          await sendAiSdrChatMessage(options.api, { sessionId: currentSessionId, message }, {
            signal: controller.signal,
            onEvent: (event) => {
              if (sendVersion === conversationVersion) dispatchInternalEvent(event);
            },
          });
        } catch (sendError) {
          if (
            !recovered &&
            sendError instanceof AiSdrApiError &&
            sendError.status === 404 &&
            !destroyed &&
            sendVersion === conversationVersion
          ) {
            recovered = true;
            clearStoredSessionId();
            const nextSessionId = await createSession(controller.signal);
            if (destroyed || sendVersion !== conversationVersion) return;
            useSession(nextSessionId);
            await sendAiSdrChatMessage(options.api, { sessionId: nextSessionId, message }, {
              signal: controller.signal,
              onEvent: (event) => {
                if (sendVersion === conversationVersion) dispatchInternalEvent(event);
              },
            });
          } else {
            throw sendError;
          }
        }
      };
      await trySend(sessionId);
      if (userBubbleRef !== null) {
        delete userBubbleRef.dataset.aiSdrFailed;
        userBubbleRef.querySelector("[data-ai-sdr-inline-retry]")?.remove();
      }
    } catch (error) {
      if (sendVersion === conversationVersion && isAbortError(error)) {
        // user-initiated stop: re-enable composer, no error toast
      } else if (sendVersion === conversationVersion) {
        lastSendError = toError(error);
        const branded = classifySendError(error);
        showToast(branded.message, "error", branded.action, branded.allowRetry);
        if (branded.allowRetry) {
          showRetryOnLastAssistant();
        }
        if (userBubbleRef !== null) {
          userBubbleRef.dataset.aiSdrFailed = "";
          const existing = userBubbleRef.querySelector("[data-ai-sdr-inline-retry]");
          if (existing === null) {
            const inlineRetry = document.createElement("button");
            inlineRetry.type = "button";
            inlineRetry.dataset.aiSdrInlineRetry = "";
            inlineRetry.textContent = copy.retry;
            inlineRetry.addEventListener("click", () => {
              if (userBubbleRef !== null) {
                delete userBubbleRef.dataset.aiSdrFailed;
                userBubbleRef.querySelector("[data-ai-sdr-inline-retry]")?.remove();
              }
              void retryLastSend();
            });
            userBubbleRef.append(inlineRetry);
          }
        }
        options.callbacks?.onError?.(toError(error));
      }
    } finally {
      if (chatController === controller) chatController = null;
      if (sendVersion === conversationVersion) {
        finalizeStreamingMessages();
        hidePendingMessage();
        sending = false;
        if (ui.transcript !== null) ui.transcript.setAttribute("aria-busy", "false");
        updateSendState();
      }
    }
  }

  function updateSendState() {
    const message = ui.composer?.value.trim() ?? "";
    if (ui.stopButton !== null) {
      const wasVisible = "visible" in ui.stopButton.dataset;
      const willShow = sending;
      if (wasVisible && !willShow && document.activeElement === ui.stopButton && ui.composer !== null) {
        ui.composer.focus();
      }
      if (willShow) {
        ui.stopButton.dataset.visible = "";
        ui.stopButton.setAttribute("aria-hidden", "false");
        ui.stopButton.removeAttribute("inert");
      } else {
        delete ui.stopButton.dataset.visible;
        ui.stopButton.setAttribute("aria-hidden", "true");
        ui.stopButton.setAttribute("inert", "");
      }
    }
    if (ui.sendButton !== null) {
      ui.sendButton.disabled = message === "" || sessionId === null || destroyed || sending || isOffline();
      ui.sendButton.setAttribute("aria-disabled", String(ui.sendButton.disabled));
      if (sending) {
        ui.sendButton.replaceChildren();
        const spinner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        spinner.setAttribute("viewBox", "0 0 16 16");
        spinner.setAttribute("aria-hidden", "true");
        spinner.setAttribute("focusable", "false");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "8");
        circle.setAttribute("cy", "8");
        circle.setAttribute("r", "6");
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", "currentColor");
        circle.setAttribute("stroke-width", "2");
        circle.setAttribute("stroke-dasharray", "20 12");
        spinner.append(circle);
        const label = document.createElement("span");
        label.textContent = "Sending…";
        ui.sendButton.append(spinner, label);
      } else {
        ui.sendButton.replaceChildren();
        ui.sendButton.textContent = copy.send;
      }
    }
    if (ui.composer !== null) {
      ui.composer.disabled = destroyed;
      ui.composer.readOnly = sending;
      ui.composer.setAttribute("aria-busy", sending ? "true" : "false");
    }
  }

  function showPendingMessage() {
    hidePendingMessage();
    if (ui.transcript === null || destroyed) return;
    const typing = document.createElement("div");
    typing.dataset.aiSdrTyping = "";
    typing.dataset.aiSdrPending = "";
    typing.setAttribute("aria-live", "off");
    typing.setAttribute("aria-label", "Assistant is typing");
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    ui.transcript.append(typing);
    if (stickToBottom) ui.transcript.scrollTop = ui.transcript.scrollHeight;
    pendingMessage = typing;
  }

  function hidePendingMessage() {
    pendingMessage?.remove();
    pendingMessage = null;
  }

  function renderCta(label, url) {
    if (ui.transcript === null || destroyed) return;
    if (!isSafeLinkUrl(url)) return;
    const link = document.createElement("a");
    link.dataset.aiSdrCta = "";
    link.dataset.aiSdrPill = "";
    applySafeLink(link, url);
    link.textContent = label;
    ui.transcript.append(link);
  }

  function renderSource(source) {
    if (ui.sourcesList === null || destroyed || !isRecord(source)) return;
    sources.push(source);
    ui.sourcesList.hidden = false;
    const item = document.createElement("li");
    item.dataset.aiSdrSourceItem = "";
    if (typeof source.url === "string" && isSafeLinkUrl(source.url)) {
      const link = document.createElement("a");
      applySafeLink(link, source.url);
      link.textContent = typeof source.title === "string" && source.title !== "" ? source.title : source.url;
      item.append(link);
    } else {
      item.textContent = typeof source.title === "string" ? source.title : "Source";
    }
    ui.sourcesList.append(item);
  }

  function renderPlanRecommendation(recommendation) {
    if (ui.transcript === null || destroyed || !isRecord(recommendation)) return;
    const card = document.createElement("div");
    card.dataset.aiSdrPlanRecommendation = "";
    const reasonEl = document.createElement("p");
    reasonEl.dataset.aiSdrPlanReason = "";
    reasonEl.textContent = typeof recommendation.reason === "string" ? recommendation.reason : "";
    card.append(reasonEl);
    if (typeof recommendation.priceSummary === "string" && recommendation.priceSummary !== "") {
      const priceEl = document.createElement("p");
      priceEl.dataset.aiSdrPlanPrice = "";
      priceEl.textContent = recommendation.priceSummary;
      card.append(priceEl);
    }
    ui.transcript.append(card);
    if (stickToBottom) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function showHandoffBanner(status) {
    if (ui.handoffBanner === null) return;
    ui.handoffBanner.hidden = false;
    ui.handoffBanner.textContent = "Human handoff: " + status;
  }

  const createSession = async (signal) => {
    const requestOptions = signal === undefined ? {} : { signal };
    const response = await createAiSdrSession(options.api, options.session, requestOptions);
    return response.sessionId;
  };

  const useSession = (nextSessionId) => {
    writeStoredSessionId(nextSessionId);
    sessionId = nextSessionId;
    updateSendState();
    track("ai_sdr_widget_opened", { sessionId });
  };

  function renderEmptyState(target) {
    const empty = document.createElement("div");
    empty.dataset.aiSdrEmpty = "";
    empty.id = widgetIds.empty;
    const title = document.createElement("p");
    title.dataset.aiSdrEmptyTitle = "";
    title.textContent = copy.emptyHeading.replace("{productName}", brand.productName);
    const body = document.createElement("p");
    body.dataset.aiSdrEmptyBody = "";
    body.textContent = "Ask about pricing, fit, setup, or next steps.";
    const rawSuggestions = copy.emptySuggestions;
    if (rawSuggestions.length > 0) {
      const suggestions = document.createElement("div");
      suggestions.dataset.aiSdrSuggestions = "";
      suggestions.setAttribute("role", "group");
      suggestions.setAttribute("aria-label", "Suggested questions");
      for (const label of rawSuggestions) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.aiSdrSuggestion = "";
        chip.textContent = label;
        chip.addEventListener("click", () => {
          if (ui.composer !== null) {
            ui.composer.value = label;
            autosizeComposer();
            updateSendState();
            void sendCurrentMessage();
          }
        });
        suggestions.append(chip);
      }
      empty.append(title, body, suggestions);
    } else {
      empty.append(title, body);
    }
    target.append(empty);
  }

  function resetConversation() {
    if (ui.transcript !== null) {
      ui.transcript.replaceChildren();
      renderEmptyState(ui.transcript);
    }
    if (ui.sourcesList !== null) {
      ui.sourcesList.replaceChildren();
      ui.sourcesList.hidden = true;
    }
    if (ui.handoffBanner !== null) {
      ui.handoffBanner.hidden = true;
      ui.handoffBanner.textContent = "";
    }
    sources.length = 0;
    pendingMessage = null;
    lastAssistantMessage = null;
    lastSendError = null;
    lastUserMessage = "";
    lastUserBubble = null;
    assistantMessagesById.clear();
    completedAssistantMessageIds.clear();
    streamingCount = 0;
    unreadCount = 0;
    if (ui.transcript !== null) ui.transcript.setAttribute("aria-live", "polite");
  }

  function readStoredSessionId() {
    try {
      const stored = sessionStore?.getItem(sessionStoreKey) ?? null;
      if (stored === null || stored === "") return null;
      // A companion timestamp records when this id was minted. When present and
      // older than the worker TTL the id is certainly stale: discard it so the
      // caller mints a fresh session instead of firing a doomed /v1/chat. A
      // missing/invalid timestamp (legacy entries) is trusted — the 404
      // recovery path remains the backstop for those.
      const ts = sessionStore?.getItem(sessionStoreTimestampKey) ?? null;
      const mintedAt = ts === null ? Number.NaN : Number(ts);
      if (Number.isFinite(mintedAt) && Date.now() - mintedAt >= AI_SDR_SESSION_STORE_TTL_MS) {
        clearStoredSessionId();
        return null;
      }
      return stored;
    } catch {
      return null;
    }
  }

  function writeStoredSessionId(nextSessionId) {
    try {
      sessionStore?.setItem(sessionStoreKey, nextSessionId);
      sessionStore?.setItem(sessionStoreTimestampKey, String(Date.now()));
    } catch {
      return;
    }
  }

  function clearStoredSessionId() {
    try {
      sessionStore?.removeItem(sessionStoreKey);
      sessionStore?.removeItem(sessionStoreTimestampKey);
    } catch {
      return;
    }
  }

  function saveActiveElement() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      lastActiveElement = active;
    } else {
      lastActiveElement = null;
    }
  }

  function restoreActiveElement(fallback) {
    const saved = lastActiveElement;
    lastActiveElement = null;
    const target = saved !== null && document.contains(saved) ? saved : fallback;
    if (target !== null && typeof target.focus === "function") {
      target.focus();
    }
  }

  function openPanel() {
    if (ui.panel === null || ui.launcher === null) return;
    if (closingTransitionTimer !== null) {
      clearTimeout(closingTransitionTimer);
      closingTransitionTimer = null;
    }
    if (pendingTransitionEndListener !== null && ui.panel !== null) {
      ui.panel.removeEventListener("transitionend", pendingTransitionEndListener);
      pendingTransitionEndListener = null;
    }
    ui.panel.hidden = false;
    ui.launcher.setAttribute("aria-expanded", "true");
    ui.launcher.hidden = true;
    if (reducedMotion) {
      ui.panel.dataset.state = "open";
    } else {
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf === "function") {
        raf(() => {
          if (ui.panel !== null) ui.panel.dataset.state = "open";
        });
      } else {
        ui.panel.dataset.state = "open";
      }
    }
    autosizeComposer();
    if (ui.composer !== null) ui.composer.focus();
    syncResponsiveModalState();
    attachDocumentKeydown();
    attachViewportListeners();
    attachComposerResizeObserver();
    attachConnectivityListeners();
    attachComposerFocusScroll();
  }

  function attachViewportListeners() {
    const vv = globalThis.visualViewport;
    if (viewportResizeHandler !== null) return;
    const handler = () => {
      syncResponsiveModalState();
      const transcript = ui.transcript;
      if (transcript !== null && stickToBottom) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    };
    viewportResizeHandler = handler;
    if (vv !== undefined && vv !== null) {
      vv.addEventListener("resize", handler);
      vv.addEventListener("scroll", handler);
    }
    globalThis.window?.addEventListener("resize", handler);
  }

  function detachViewportListeners() {
    const vv = globalThis.visualViewport;
    if (viewportResizeHandler === null) return;
    if (vv !== undefined && vv !== null) {
      vv.removeEventListener("resize", viewportResizeHandler);
      vv.removeEventListener("scroll", viewportResizeHandler);
    }
    globalThis.window?.removeEventListener("resize", viewportResizeHandler);
    viewportResizeHandler = null;
  }

  function attachComposerResizeObserver() {
    const composer = ui.composer;
    if (composer === null || composerResizeObserver !== null) return;
    if (typeof globalThis.ResizeObserver !== "function") return;
    const observer = new globalThis.ResizeObserver(() => {
      autosizeComposer();
    });
    observer.observe(composer);
    composerResizeObserver = observer;
  }

  function detachComposerResizeObserver() {
    if (composerResizeObserver !== null) {
      composerResizeObserver.disconnect();
      composerResizeObserver = null;
    }
  }

  function attachComposerFocusScroll() {
    const composer = ui.composer;
    if (composer === null) return;
    composer.addEventListener("focus", handleComposerFocus);
  }

  function detachComposerFocusScroll() {
    const composer = ui.composer;
    if (composer === null) return;
    composer.removeEventListener("focus", handleComposerFocus);
  }

  function handleComposerFocus() {
    if (!isMobileBreakpoint()) return;
    const composer = ui.composer;
    if (composer !== null && typeof composer.scrollIntoView === "function") {
      composer.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }

  function attachConnectivityListeners() {
    if (onlineHandler !== null) return;
    const win = globalThis.window;
    if (win === undefined || win === null) return;
    onlineHandler = () => {
      hideOfflineBanner();
      updateSendState();
    };
    offlineHandler = () => {
      showOfflineBanner();
      updateSendState();
    };
    win.addEventListener("online", onlineHandler);
    win.addEventListener("offline", offlineHandler);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      showOfflineBanner();
      updateSendState();
    }
  }

  function detachConnectivityListeners() {
    const win = globalThis.window;
    if (win === undefined || win === null) return;
    if (onlineHandler !== null) {
      win.removeEventListener("online", onlineHandler);
      onlineHandler = null;
    }
    if (offlineHandler !== null) {
      win.removeEventListener("offline", offlineHandler);
      offlineHandler = null;
    }
  }

  function showLoadingState() {
    if (ui.loadingEl === null || ui.transcript === null) return;
    ui.loadingEl.hidden = false;
    ui.transcript.hidden = true;
  }

  function hideLoadingState() {
    if (ui.loadingEl === null || ui.transcript === null) return;
    ui.loadingEl.hidden = true;
    ui.transcript.hidden = false;
  }

  function showOfflineBanner() {
    if (ui.panel === null) return;
    if (offlineBanner !== null) return;
    const banner = document.createElement("div");
    banner.dataset.aiSdrOfflineBanner = "";
    banner.setAttribute("role", "status");
    banner.textContent = copy.offlineBanner;
    const composer = ui.panel.querySelector('[data-ai-sdr-composer]');
    if (composer !== null) {
      ui.panel.insertBefore(banner, composer);
    } else {
      ui.panel.append(banner);
    }
    offlineBanner = banner;
  }

  function hideOfflineBanner() {
    if (offlineBanner !== null) {
      offlineBanner.remove();
      offlineBanner = null;
    }
  }

  function isOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  function finalizePanelClose() {
    if (ui.panel === null) return;
    ui.panel.hidden = true;
    delete ui.panel.dataset.state;
  }

  function closePanel() {
    if (ui.panel === null || ui.launcher === null) return;
    ui.launcher.setAttribute("aria-expanded", "false");
    ui.launcher.hidden = false;
    chatController?.abort();
    detachDocumentKeydown();
    detachViewportListeners();
    detachComposerResizeObserver();
    detachComposerFocusScroll();
    detachConnectivityListeners();
    hideOfflineBanner();
    restoreBackgroundInert();
    if (pendingTransitionEndListener !== null) {
      ui.panel.removeEventListener("transitionend", pendingTransitionEndListener);
      pendingTransitionEndListener = null;
    }
    if (reducedMotion) {
      finalizePanelClose();
    } else {
      ui.panel.dataset.state = "exiting";
      const panelRef = ui.panel;
      const onEnd = (event) => {
        if (event !== undefined && event.target !== panelRef) return;
        panelRef.removeEventListener("transitionend", onEnd);
        if (pendingTransitionEndListener === onEnd) pendingTransitionEndListener = null;
        if (closingTransitionTimer !== null) {
          clearTimeout(closingTransitionTimer);
          closingTransitionTimer = null;
        }
        if (ui.panel === panelRef) finalizePanelClose();
      };
      pendingTransitionEndListener = onEnd;
      panelRef.addEventListener("transitionend", onEnd);
      closingTransitionTimer = setTimeout(onEnd, 220);
    }
    restoreActiveElement(ui.launcher);
  }

  const widget = {
    async open() {
      if (destroyed) throw new Error("Widget destroyed");
      saveActiveElement();
      ensureRoot();
      openState = true;
      openPanel();
      if (sessionId !== null) return;
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
      showLoadingState();
      try {
        const nextSessionId = await createSession(controller.signal);
        if (destroyed) throw new Error("Widget destroyed");
        if (requestVersion !== sessionRequestVersion) return;
        hideLoadingState();
        useSession(nextSessionId);
      } catch (error) {
        hideLoadingState();
        const normalized = destroyed ? new Error("Widget destroyed") : toError(error);
        options.callbacks?.onError?.(normalized);
        showToast("Could not start chat. Please try again.", "error");
        openState = false;
        if (ui.panel !== null) ui.panel.hidden = true;
        if (ui.launcher !== null) {
          ui.launcher.setAttribute("aria-expanded", "false");
          ui.launcher.hidden = false;
        }
        detachDocumentKeydown();
        restoreBackgroundInert();
        restoreActiveElement(ui.launcher);
        throw normalized;
      } finally {
        if (startupController === controller) startupController = null;
      }
    },
    close() {
      const wasOpen = openState;
      openState = false;
      // Always abort any in-flight stream and reset transient send state so
      // a subsequent reopen starts clean (stop button hidden, not loading).
      if (chatController !== null) {
        chatController.abort();
        chatController = null;
      }
      sending = false;
      if (ui.stopButton !== null) {
        delete ui.stopButton.dataset.visible;
        ui.stopButton.setAttribute("aria-hidden", "true");
        ui.stopButton.setAttribute("inert", "");
      }
      if (ui.loadingEl !== null) {
        ui.loadingEl.hidden = true;
        if (ui.transcript !== null) ui.transcript.hidden = false;
      }
      unreadCount = 0;
      if (wasOpen && ui.panel !== null) {
        closePanel();
        return;
      }
      detachDocumentKeydown();
      detachViewportListeners();
      detachComposerResizeObserver();
      detachComposerFocusScroll();
      detachConnectivityListeners();
      hideOfflineBanner();
      restoreBackgroundInert();
      if (ui.root !== null) aiSdrLiveWidgetRoots.delete(ui.root);
      ui.root?.remove();
      ui.root = null;
      ui.launcher = null;
      ui.panel = null;
      ui.header = null;
      ui.closeButton = null;
      ui.transcript = null;
      ui.composer = null;
      ui.sendButton = null;
      ui.stopButton = null;
      ui.loadingEl = null;
      ui.newMessagesPill = null;
      ui.handoffBanner = null;
      ui.sourcesList = null;
      ui.toast = null;
      ui.statusRegion = null;
      ui.emptyDescription = null;
      if (ui.toastTimer !== null) {
        clearTimeout(ui.toastTimer);
        ui.toastTimer = null;
      }
      if (closingTransitionTimer !== null) {
        clearTimeout(closingTransitionTimer);
        closingTransitionTimer = null;
      }
      pendingTransitionEndListener = null;
      streamingCount = 0;
      unreadCount = 0;
      if (ui.styleEl !== null) {
        ui.styleEl.remove();
        ui.styleEl = null;
      }
      pendingMessage = null;
      lastAssistantMessage = null;
      sources.length = 0;
      assistantMessagesById.clear();
      completedAssistantMessageIds.clear();
      stickToBottom = true;
      restoreActiveElement(null);
    },
    destroy() {
      destroyed = true;
      startupController?.abort();
      chatController?.abort();
      openState = false;
      detachDocumentKeydown();
      detachViewportListeners();
      detachComposerResizeObserver();
      detachComposerFocusScroll();
      detachConnectivityListeners();
      hideOfflineBanner();
      restoreBackgroundInert();
      if (ui.toastTimer !== null) {
        clearTimeout(ui.toastTimer);
        ui.toastTimer = null;
      }
      if (ui.root !== null) aiSdrLiveWidgetRoots.delete(ui.root);
      ui.root?.remove();
      ui.root = null;
      ui.launcher = null;
      ui.panel = null;
      ui.header = null;
      ui.closeButton = null;
      ui.transcript = null;
      ui.composer = null;
      ui.sendButton = null;
      ui.stopButton = null;
      ui.loadingEl = null;
      ui.newMessagesPill = null;
      ui.handoffBanner = null;
      ui.sourcesList = null;
      ui.toast = null;
      ui.statusRegion = null;
      ui.emptyDescription = null;
      if (closingTransitionTimer !== null) {
        clearTimeout(closingTransitionTimer);
        closingTransitionTimer = null;
      }
      pendingTransitionEndListener = null;
      streamingCount = 0;
      unreadCount = 0;
      if (ui.styleEl !== null) {
        ui.styleEl.remove();
        ui.styleEl = null;
      }
      pendingMessage = null;
      lastAssistantMessage = null;
      sources.length = 0;
      assistantMessagesById.clear();
      completedAssistantMessageIds.clear();
      stickToBottom = true;
      restoreActiveElement(null);
    },
    isOpen() {
      return openState;
    },
    getSessionId() {
      return sessionId;
    },
    getLastError() {
      return lastSendError;
    },
    async startNewChat() {
      if (destroyed) throw new Error("Widget destroyed");
      saveActiveElement();
      ensureRoot();
      openState = true;
      openPanel();
      const requestVersion = sessionRequestVersion + 1;
      sessionRequestVersion = requestVersion;
      const controller = new AbortController();
      startupController = controller;
      try {
        const nextSessionId = await createSession(controller.signal);
        if (destroyed) throw new Error("Widget destroyed");
        if (requestVersion !== sessionRequestVersion) return;
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
        if (startupController === controller) startupController = null;
      }
    },
    handleEvent(event) {
      dispatchInternalEvent(event);
    },
    async requestHandoff(request = {}) {
      if (destroyed || sessionId === null) return null;
      try {
        const response = await requestAiSdrHandoff(options.api, { sessionId, ...request });
        showHandoffBanner(response.status);
        return response;
      } catch (error) {
        options.callbacks?.onError?.(toError(error));
        return null;
      }
    },
  };

  // When a send fails mid-stream (e.g. a malformed SSE frame aborts the read
  // before message.done arrives), any in-flight assistant bubble would otherwise
  // stay flagged data-ai-sdr-streaming with the transcript stuck at aria-live:off
  // and a non-zero streamingCount. Finalize whatever text was received so the
  // bubble is rendered cleanly and the streaming state is fully unwound.
  function finalizeStreamingMessages() {
    for (const message of assistantMessagesById.values()) {
      delete message.dataset.aiSdrStreaming;
      const finalText = message.dataset.aiSdrMessageText ?? "";
      const body = message.querySelector('[data-ai-sdr-bubble-body]');
      if (body !== null) renderRichText(body, finalText);
    }
    assistantMessagesById.clear();
    streamingCount = 0;
    if (ui.transcript !== null) ui.transcript.setAttribute("aria-live", "polite");
  }

  function dispatchInternalEvent(event) {
    if (destroyed) return;
    if (
      event.event === "message.delta" ||
      event.event === "message.done" ||
      event.event === "error"
    ) {
      hidePendingMessage();
    }
    if (event.event === "message.delta") {
      let message = assistantMessagesById.get(event.data.messageId) ?? null;
      const isFirstDelta = message === null && !completedAssistantMessageIds.has(event.data.messageId);
      if (isFirstDelta) {
        message = appendMessage("assistant", "");
        if (message !== null) {
          assistantMessagesById.set(event.data.messageId, message);
          lastAssistantMessage = message;
          message.dataset.aiSdrStreaming = "";
          streamingCount += 1;
          if (streamingCount === 1 && ui.transcript !== null) {
            ui.transcript.setAttribute("aria-live", "off");
          }
        }
      }
      if (message !== null) {
        const current = message.dataset.aiSdrMessageText ?? "";
        const next = current + event.data.delta;
        message.dataset.aiSdrMessageText = next;
        const body = message.querySelector('[data-ai-sdr-bubble-body]');
        if (body !== null) renderRichTextIncremental(body, current, next);
        const transcript = ui.transcript;
        if (transcript !== null) {
          if (stickToBottom) {
            transcript.scrollTop = transcript.scrollHeight;
          } else {
            showNewMessagesPill(isFirstDelta);
          }
        }
      }
    } else if (event.event === "message.done") {
      const message = assistantMessagesById.get(event.data.messageId) ?? null;
      if (message !== null) {
        delete message.dataset.aiSdrStreaming;
        const finalText = message.dataset.aiSdrMessageText ?? "";
        const body = message.querySelector('[data-ai-sdr-bubble-body]');
        if (body !== null) renderRichText(body, finalText);
        if (streamingCount > 0) {
          streamingCount -= 1;
          if (streamingCount === 0 && ui.transcript !== null) {
            ui.transcript.setAttribute("aria-live", "polite");
          }
        }
      }
      completedAssistantMessageIds.add(event.data.messageId);
      assistantMessagesById.delete(event.data.messageId);
      const finalMessage = lastAssistantMessage;
      const finalText = finalMessage?.dataset.aiSdrMessageText ?? "";
      announceStatus(finalText === "" ? "Assistant responded." : "Assistant responded: " + finalText);
      track("ai_sdr_message_received", { messageId: event.data.messageId });
    } else if (event.event === "trial.cta") {
      renderCta(event.data.cta.label, event.data.cta.url);
      track("ai_sdr_trial_cta_shown", { label: event.data.cta.label, url: event.data.cta.url });
    } else if (event.event === "source") {
      renderSource(event.data.source);
    } else if (event.event === "plan.recommendation") {
      renderPlanRecommendation(event.data.recommendation);
      track("ai_sdr_plan_recommendation_shown", { planId: event.data.recommendation.planId });
    } else if (event.event === "handoff.requested") {
      showHandoffBanner("requested");
    } else if (event.event === "lead.captured") {
      // Internal signal that the worker captured and pushed the lead to the CRM.
      // No visible UI — the visitor never asked to be "saved", so a confirmation
      // would read as creepy. Analytics only, and only privacy-safe fields
      // (status is an enum; no name/email/company ever crosses this boundary).
      // Embedders still receive the full event via the onEvent callback below.
      track("ai_sdr_lead_captured", { status: event.data.status });
    } else if (event.event === "error") {
      options.callbacks?.onError?.(new Error(event.data.message));
    }
    options.callbacks?.onEvent?.(event);
  }

  // Mount the launcher eagerly so embedding the widget with init() alone gives
  // visitors a clickable entry point. The panel is built hidden and no session
  // is created until the launcher is clicked (or open() is called), so this is
  // purely DOM — no network and no background inerting happen here. Guarded so
  // constructing the widget in a non-DOM context (SSR, the served-module smoke
  // check) stays inert instead of throwing on a missing document.
  if (typeof document !== "undefined") {
    ensureRoot();
  }

  return widget;
}

function aiSdrInit(config) {
  if (!isRecord(config)) throw new Error("AiSdr.init requires a config object");
  if (typeof globalThis.__ventoraAiSdrWidget !== "undefined" && globalThis.__ventoraAiSdrWidget !== null) {
    console.warn("VentoraAiSdr: init called more than once — returning existing widget instance.");
    return globalThis.__ventoraAiSdrWidget;
  }
  if (typeof document !== "undefined" && document.querySelector("[data-ai-sdr-widget]") !== null) {
    console.warn("VentoraAiSdr: an AI-SDR widget is already mounted in the document — returning without mounting a second.");
    return globalThis.__ventoraAiSdrWidget ?? null;
  }
  const target = resolveInitTarget(config);
  const widget = createAiSdrWidget({
    api: {
      baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
      signRequest: typeof config.signRequest === "function" ? config.signRequest : undefined,
    },
    session: isRecord(config.session) ? config.session : { productId: typeof config.productId === "string" ? config.productId : "ventora" },
    brand: isRecord(config.brand) ? config.brand : undefined,
    subtitle: typeof config.subtitle === "string" ? config.subtitle : undefined,
    copy: isRecord(config.copy) ? config.copy : undefined,
    target,
    callbacks: isRecord(config.callbacks) ? config.callbacks : undefined,
    analytics: isRecord(config.analytics) ? config.analytics : undefined,
    sessionStore: config.sessionStore,
  });
  globalThis.__ventoraAiSdrWidget = widget;
  const originalDestroy = widget.destroy.bind(widget);
  widget.destroy = function aiSdrInitWidgetDestroy() {
    globalThis.__ventoraAiSdrWidget = null;
    originalDestroy();
  };
  if (config.autoOpen === true) {
    // See the launcher click handler: open() owns its own failure UX, so a
    // rejected session-create here must not become an unhandled rejection.
    void widget.open().catch(() => {});
  }
  return widget;
}

function resolveInitTarget(config) {
  if (config.target instanceof HTMLElement) return config.target;
  if (typeof config.target === "string") {
    const el = document.querySelector(config.target);
    if (el instanceof HTMLElement) return el;
  }
  return document.body;
}

async function postJson(config, path, body, signal) {
  const response = await post(config, path, body, signal);
  const text = await response.text();
  const json = parseJsonOrNull(text);
  if (!response.ok) throw new AiSdrApiError(errorMessage(json, response.statusText), response.status);
  return json;
}

async function post(config, path, body, signal) {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (fetchFn === undefined) throw new Error("No fetch implementation available");
  const serializedBody = JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json" });
  if (typeof config.signRequest === "function") {
    const assertion = await config.signRequest({ method: "POST", path, body, serializedBody });
    headers.set("X-Ventora-Timestamp", assertion.timestamp);
    headers.set("X-Ventora-Nonce", assertion.nonce);
    headers.set("X-Ventora-Signature", assertion.signature);
  } else if (config.clientAssertion !== undefined) {
    headers.set("X-Ventora-Timestamp", config.clientAssertion.timestamp);
    headers.set("X-Ventora-Nonce", config.clientAssertion.nonce);
    headers.set("X-Ventora-Signature", config.clientAssertion.signature);
  }
  const init = {
    method: "POST",
    headers,
    body: serializedBody,
  };
  if (signal !== undefined) init.signal = signal;
  return fetchFn(config.baseUrl.replace(/\/+$/, "") + path, init);
}

function parseJsonOrNull(text) {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(value, fallback) {
  if (isRecord(value)) {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }
  return fallback === "" ? "AI-SDR request failed" : fallback;
}

function isAiSdrSseEvent(value) {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) return false;
  const data = value.data;
  switch (value.event) {
    case "session.created":
      return typeof data.sessionId === "string";
    case "message.delta":
      return typeof data.messageId === "string" && typeof data.delta === "string";
    case "source":
      return isRecord(data.source);
    case "plan.recommendation":
      return isRecord(data.recommendation);
    case "trial.cta":
      return isRecord(data.cta);
    case "handoff.requested":
      return typeof data.handoffId === "string";
    case "message.done":
      return typeof data.messageId === "string";
    case "error":
      return typeof data.code === "string" && typeof data.message === "string";
    case "heartbeat":
      return typeof data.timestamp === "string";
    default:
      return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error) {
  return isRecord(error) && error.name === "AbortError";
}

function resolvePosthog(explicit) {
  if (explicit !== undefined) return explicit;
  const candidate = globalThis.posthog;
  return isRecord(candidate) && typeof candidate.capture === "function"
    ? { capture: (event, properties) => candidate.capture(event, properties) }
    : undefined;
}

function resolveSessionStore(explicit) {
  if (explicit !== undefined) return explicit;
  try {
    const candidate = globalThis.localStorage;
    if (!isSessionStore(candidate)) return undefined;
    return {
      getItem(key) {
        try { return candidate.getItem(key); } catch { return null; }
      },
      setItem(key, value) {
        try { candidate.setItem(key, value); } catch { return; }
      },
      removeItem(key) {
        try { candidate.removeItem(key); } catch { return; }
      },
    };
  } catch {
    return undefined;
  }
}

function isSessionStore(value) {
  return (
    isRecord(value) &&
    typeof value.getItem === "function" &&
    typeof value.setItem === "function" &&
    typeof value.removeItem === "function"
  );
}

function aiSdrSessionStoreKey(session) {
  const rawProductId = typeof session.productId === "string" ? session.productId : "";
  const productId = rawProductId.trim().toLowerCase() || "ventora";
  const visitorId = session.visitorId?.trim() || "anonymous";
  return "ventora:ai-sdr:session:" + encodeURIComponent(productId) + ":" + encodeURIComponent(visitorId);
}

function prefersReducedMotion() {
  try {
    const mql = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    return mql !== undefined && mql !== null && mql.matches === true;
  } catch {
    return false;
  }
}

function detectRtl() {
  const root = globalThis.document?.documentElement;
  if (root === undefined || root === null) return false;
  return root.getAttribute("dir") === "rtl";
}

function widgetStyleSheet(reducedMotion) {
  const motion = reducedMotion ? "none" : "transform var(--ai-sdr-motion-base) ease, opacity var(--ai-sdr-motion-base) ease";
  return [
    "[data-ai-sdr-widget]{--ai-sdr-space-1:4px;--ai-sdr-space-2:8px;--ai-sdr-space-3:12px;--ai-sdr-space-4:16px;--ai-sdr-space-5:24px;--ai-sdr-radius-sm:8px;--ai-sdr-radius-md:12px;--ai-sdr-radius-lg:14px;--ai-sdr-radius-pill:9999px;--ai-sdr-motion-fast:140ms;--ai-sdr-motion-base:200ms;--ai-sdr-stick-threshold:24px;--ai-sdr-focus-ring:0 0 0 3px var(--ai-sdr-focus-ring-color,color-mix(in srgb, var(--ai-sdr-accent) 25%, transparent));--ai-sdr-focus-outline:2px solid var(--ai-sdr-accent);--ai-sdr-error-bg:#7f1d1d;--ai-sdr-error-text:#ffffff;--ai-sdr-warning-bg:rgba(245,158,11,.15);--ai-sdr-warning-text:#92400e;--ai-sdr-offline-bg:color-mix(in srgb, var(--ai-sdr-text) 8%, transparent);--ai-sdr-offline-text:var(--ai-sdr-text);--ai-sdr-composer-max-height:120px;position:fixed;z-index:2147483646;bottom:max(var(--ai-sdr-space-4),env(safe-area-inset-bottom));right:max(var(--ai-sdr-space-4),env(safe-area-inset-right));font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif,'Apple Color Emoji','Segoe UI Emoji';line-height:1.5;color:var(--ai-sdr-text);--ai-sdr-bubble-assistant-bg:color-mix(in srgb, var(--ai-sdr-accent) 6%, var(--ai-sdr-surface));--ai-sdr-composer-bg:var(--ai-sdr-surface);--ai-sdr-bubble-assistant-bg-fallback:rgba(15,23,42,.06);--ai-sdr-composer-bg-fallback:#ffffff;}",
    "[data-ai-sdr-widget],[data-ai-sdr-widget] *,[data-ai-sdr-widget] *::before,[data-ai-sdr-widget] *::after{box-sizing:border-box;}",
    "[data-ai-sdr-widget] .ai-sdr-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;}",
    "[data-ai-sdr-widget] ::selection{background:color-mix(in srgb,var(--ai-sdr-accent) 35%,transparent);}",
    "[data-ai-sdr-pill]{border-radius:var(--ai-sdr-radius-pill);}",
    "[data-ai-sdr-subtitle]{display:block;font-size:12px;opacity:.85;font-weight:500;line-height:1.3;}",
    "[data-ai-sdr-heading-wrap]{display:flex;flex-direction:column;flex:1;min-width:0;}",
    "[data-ai-sdr-offline-banner]{padding:var(--ai-sdr-space-2) var(--ai-sdr-space-4);background:var(--ai-sdr-offline-bg);color:var(--ai-sdr-offline-text);font-size:13px;text-align:center;}",
    "[data-ai-sdr-bubble]{overflow-wrap:anywhere;word-break:break-word;}",
    "[data-ai-sdr-bubble] a{color:currentColor;text-decoration:underline;text-underline-offset:2px;}",
    "[data-ai-sdr-bubble] a:hover{text-decoration-thickness:2px;}",
    "[data-ai-sdr-bubble] code{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:0.92em;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent);}",
    "[data-ai-sdr-bubble] pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,currentColor 8%,transparent);overflow-x:auto;}",
    "[data-ai-sdr-streaming]::after{content:\"\";display:inline-block;width:2px;height:1em;background:currentColor;margin-left:2px;vertical-align:-2px;animation:ai-sdr-caret 1s steps(2) infinite;}",
    "@keyframes ai-sdr-caret{50%{opacity:0;}}",
    "@supports not (background: color-mix(in srgb, red, blue)){[data-ai-sdr-bubble][data-ai-sdr-role=\"assistant\"]{background:rgba(15,23,42,.06);border:1px solid rgba(15,23,42,.08);}[data-ai-sdr-suggestion]{background:rgba(15,23,42,.04);}}",
    '[data-ai-sdr-widget][data-ai-sdr-dir="rtl"]{right:auto;left:max(var(--ai-sdr-space-4),env(safe-area-inset-left));}',
    "[data-ai-sdr-launcher]{background:var(--ai-sdr-accent);color:var(--ai-sdr-accent-text);border:0;border-radius:var(--ai-sdr-radius-pill);padding:var(--ai-sdr-space-3) 18px;cursor:pointer;box-shadow:0 8px 24px color-mix(in srgb, var(--ai-sdr-text) 18%, transparent);min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;transition:" + motion + ", box-shadow var(--ai-sdr-motion-base) ease;}",
    "[data-ai-sdr-launcher][hidden]{display:none;}",
    "[data-ai-sdr-launcher]:hover{transform:translateY(-2px);box-shadow:0 12px 30px color-mix(in srgb, var(--ai-sdr-text) 22%, transparent);}",
    "[data-ai-sdr-launcher]:active{transform:translateY(0);}",
    "[data-ai-sdr-launcher]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:3px;box-shadow:var(--ai-sdr-focus-ring);}",
    "[data-ai-sdr-panel]{position:fixed;right:var(--ai-sdr-space-4);bottom:var(--ai-sdr-space-4);width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100dvh - 24px);background:var(--ai-sdr-surface);color:var(--ai-sdr-text);border-radius:var(--ai-sdr-radius-lg);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px color-mix(in srgb, var(--ai-sdr-text) 24%, transparent);transform:translateY(8px) scale(.98);opacity:0;visibility:hidden;pointer-events:none;transform-origin:bottom right;transition:transform 200ms cubic-bezier(.18,.95,.32,1),opacity 200ms cubic-bezier(.18,.95,.32,1);}",
    "[data-ai-sdr-panel][hidden]{display:none;}",
    '[data-ai-sdr-panel][data-state="open"]{transform:none;opacity:1;visibility:visible;pointer-events:auto;}',
    '[data-ai-sdr-panel][data-state="exiting"]{transform:translateY(8px) scale(.98);opacity:0;visibility:visible;pointer-events:none;}',
    '[data-ai-sdr-widget][data-ai-sdr-dir="rtl"] [data-ai-sdr-panel]{right:auto;left:var(--ai-sdr-space-4);transform-origin:bottom left;}',
    "@media (max-width:640px){[data-ai-sdr-panel]{position:fixed;right:0;left:0;bottom:0;top:0;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0;padding-bottom:env(safe-area-inset-bottom);}[data-ai-sdr-header]{padding-top:calc(var(--ai-sdr-space-3) + env(safe-area-inset-top));}[data-ai-sdr-composer]{padding-bottom:calc(var(--ai-sdr-space-3) + env(safe-area-inset-bottom));}[data-ai-sdr-input]{font-size:16px;}}",
    "[data-ai-sdr-header]{display:flex;align-items:center;justify-content:space-between;gap:var(--ai-sdr-space-2);padding:var(--ai-sdr-space-3) var(--ai-sdr-space-4);background:var(--ai-sdr-accent);color:var(--ai-sdr-accent-text);}",
    "[data-ai-sdr-heading]{margin:0;font-size:16px;font-weight:600;flex:1;}",
    "[data-ai-sdr-close]{background:transparent;color:inherit;border:0;font-size:20px;cursor:pointer;padding:var(--ai-sdr-space-1) var(--ai-sdr-space-2);border-radius:var(--ai-sdr-radius-pill);min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;transition:background var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-close]:hover{background:rgba(255,255,255,.12);}",
    "[data-ai-sdr-close]:focus-visible{outline:2px solid var(--ai-sdr-accent-text);outline-offset:2px;background:rgba(255,255,255,.12);}",
    "[data-ai-sdr-close]:active{background:rgba(255,255,255,.18);}",
    "[data-ai-sdr-close] svg{width:18px;height:18px;display:block;}",
    "[data-ai-sdr-transcript]{flex:1;overflow-y:auto;padding:var(--ai-sdr-space-3) var(--ai-sdr-space-4);display:flex;flex-direction:column;gap:var(--ai-sdr-space-2);line-height:1.5;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 30%,transparent) transparent;}",
    "[data-ai-sdr-transcript][hidden]{display:none;}",
    "@keyframes ai-sdr-bubble-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}",
    "[data-ai-sdr-bubble]{animation:ai-sdr-bubble-in 170ms ease-out;line-height:1.5;}",
    '[data-ai-sdr-bubble][data-ai-sdr-role="user"]{align-self:flex-end;background:var(--ai-sdr-accent);color:var(--ai-sdr-accent-text);padding:var(--ai-sdr-space-2) var(--ai-sdr-space-3);border-radius:var(--ai-sdr-radius-md);border-bottom-right-radius:var(--ai-sdr-space-1);max-width:min(88%,34rem);overflow-wrap:anywhere;}',
    '[data-ai-sdr-widget][data-ai-sdr-dir="rtl"] [data-ai-sdr-bubble][data-ai-sdr-role="user"]{align-self:flex-start;border-bottom-right-radius:var(--ai-sdr-radius-md);border-bottom-left-radius:var(--ai-sdr-space-1);}',
    '[data-ai-sdr-bubble][data-ai-sdr-role="assistant"]{align-self:flex-start;background:var(--ai-sdr-bubble-assistant-bg, rgba(15,23,42,.06));border:1px solid color-mix(in srgb, var(--ai-sdr-text) 8%, transparent);padding:var(--ai-sdr-space-2) var(--ai-sdr-space-3);border-radius:var(--ai-sdr-radius-md);border-bottom-left-radius:var(--ai-sdr-space-1);max-width:min(88%,34rem);overflow-wrap:anywhere;}',
    '[data-ai-sdr-widget][data-ai-sdr-dir="rtl"] [data-ai-sdr-bubble][data-ai-sdr-role="assistant"]{align-self:flex-end;border-bottom-left-radius:var(--ai-sdr-radius-md);border-bottom-right-radius:var(--ai-sdr-space-1);}',
    "[data-ai-sdr-bubble-actions]{display:flex;gap:var(--ai-sdr-space-1);margin-top:var(--ai-sdr-space-1);opacity:0.35;transition:opacity var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-bubble]:hover [data-ai-sdr-bubble-actions],[data-ai-sdr-bubble]:focus-within [data-ai-sdr-bubble-actions]{opacity:1;}",
    "[data-ai-sdr-bubble-actions] button{background:transparent;color:inherit;border:1px solid color-mix(in srgb, var(--ai-sdr-text) 20%, transparent);border-radius:var(--ai-sdr-radius-pill);padding:2px var(--ai-sdr-space-2);font-size:12px;cursor:pointer;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;}",
    "[data-ai-sdr-bubble-actions] button:hover{background:color-mix(in srgb, var(--ai-sdr-text) 5%, transparent);}",
    "[data-ai-sdr-bubble-actions] button:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "[data-ai-sdr-typing]{align-self:flex-start;background:var(--ai-sdr-bubble-assistant-bg, rgba(15,23,42,.06));border-radius:var(--ai-sdr-radius-md);border-bottom-left-radius:var(--ai-sdr-space-1);padding:var(--ai-sdr-space-3) 14px;display:inline-flex;gap:var(--ai-sdr-space-1);}",
    "[data-ai-sdr-typing] span{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4;animation:ai-sdr-typing 1.2s infinite ease-in-out;}",
    "[data-ai-sdr-typing] span:nth-child(2){animation-delay:.15s;}",
    "[data-ai-sdr-typing] span:nth-child(3){animation-delay:.3s;}",
    "@keyframes ai-sdr-typing{0%,60%,100%{transform:translateY(0);opacity:.4;}30%{transform:translateY(-3px);opacity:1;}}",
    "[data-ai-sdr-composer]{display:flex;gap:var(--ai-sdr-space-2);padding:var(--ai-sdr-space-3) var(--ai-sdr-space-4);border-top:1px solid color-mix(in srgb, var(--ai-sdr-text) 8%, transparent);align-items:flex-end;transition:border-top-color var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-composer]:focus-within{border-top-color:var(--ai-sdr-accent);}",
    "[data-ai-sdr-input]{flex:1;resize:none;min-height:44px;max-height:var(--ai-sdr-composer-max-height,120px);padding:var(--ai-sdr-space-2);border:1px solid color-mix(in srgb, var(--ai-sdr-text) 15%, transparent);border-radius:10px;font:inherit;line-height:1.5;color:inherit;background:var(--ai-sdr-composer-bg, color-mix(in srgb, var(--ai-sdr-text) 4%, var(--ai-sdr-surface)));transition:border-color var(--ai-sdr-motion-fast) ease, box-shadow var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-input]:focus{outline:none;border-color:var(--ai-sdr-accent);box-shadow:var(--ai-sdr-focus-ring);}",
    "[data-ai-sdr-send]{background:var(--ai-sdr-accent);color:var(--ai-sdr-accent-text);border:0;padding:var(--ai-sdr-space-2) var(--ai-sdr-space-4);border-radius:var(--ai-sdr-radius-pill);cursor:pointer;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:var(--ai-sdr-space-1);transition:filter var(--ai-sdr-motion-fast) ease, transform var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-send]:not([disabled]):hover{filter:brightness(1.08);}",
    "[data-ai-sdr-send]:not([disabled]):active{transform:translateY(1px);filter:brightness(.95);}",
    "[data-ai-sdr-send]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "[data-ai-sdr-send][disabled]{opacity:.5;cursor:not-allowed;}",
    "[data-ai-sdr-send] svg{width:14px;height:14px;animation:ai-sdr-spin 1s linear infinite;}",
    "@keyframes ai-sdr-spin{from{transform:rotate(0);}to{transform:rotate(360deg);}}",
    "[data-ai-sdr-handoff-banner]{padding:var(--ai-sdr-space-2) var(--ai-sdr-space-4);background:var(--ai-sdr-warning-bg);color:var(--ai-sdr-warning-text);font-size:13px;}",
    "[data-ai-sdr-sources]{padding:var(--ai-sdr-space-2) var(--ai-sdr-space-4);margin:0;list-style:none;font-size:12px;border-top:1px solid var(--ai-sdr-offline-bg);display:flex;flex-wrap:wrap;gap:var(--ai-sdr-space-2);align-items:center;}",
    "[data-ai-sdr-sources][hidden]{display:none;}",
    "[data-ai-sdr-source-item]{display:inline-flex;}",
    "[data-ai-sdr-source-item] a{border:1px solid color-mix(in srgb,var(--ai-sdr-text) 20%,transparent);border-radius:9999px;padding:4px 12px;font-size:12px;text-decoration:none;color:var(--ai-sdr-accent);background:transparent;}",
    "[data-ai-sdr-source-item] a:hover{background:color-mix(in srgb,var(--ai-sdr-text) 6%,transparent);}",
    "[data-ai-sdr-source-item] a:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "@supports not (border: 1px solid color-mix(in srgb, red, blue)){[data-ai-sdr-source-item] a{border:1px solid rgba(15,23,42,.2);}[data-ai-sdr-source-item] a:hover{background:rgba(15,23,42,.06);}}",
    "[data-ai-sdr-toast]{position:absolute;bottom:84px;left:var(--ai-sdr-space-4);right:var(--ai-sdr-space-4);background:var(--ai-sdr-error-bg);color:var(--ai-sdr-error-text);padding:var(--ai-sdr-space-2) var(--ai-sdr-space-3);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:var(--ai-sdr-space-2);}",
    "[data-ai-sdr-toast][hidden]{display:none;}",
    "[data-ai-sdr-bubble-actions]{display:flex;justify-content:flex-start;margin-top:var(--ai-sdr-space-1);}",
    "[data-ai-sdr-copy]{appearance:none;background:transparent;border:1px solid color-mix(in srgb,var(--ai-sdr-text) 22%,transparent);color:color-mix(in srgb,var(--ai-sdr-text) 72%,transparent);border-radius:var(--ai-sdr-radius-pill);padding:2px var(--ai-sdr-space-2);font:inherit;font-size:12px;line-height:1.4;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;transition:background var(--ai-sdr-motion-fast) ease,color var(--ai-sdr-motion-fast) ease;}",
    "[data-ai-sdr-copy]:hover{background:color-mix(in srgb,var(--ai-sdr-text) 6%,transparent);color:var(--ai-sdr-text);}",
    "[data-ai-sdr-copy]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "[data-ai-sdr-toast] button{background:transparent;color:var(--ai-sdr-error-text);border:1px solid rgba(255,255,255,.4);border-radius:var(--ai-sdr-radius-pill);padding:2px var(--ai-sdr-space-2);cursor:pointer;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;}",
    "[data-ai-sdr-new-messages]{position:absolute;bottom:84px;inset-inline-end:var(--ai-sdr-space-3);inset-inline-start:auto;background:var(--ai-sdr-accent);color:var(--ai-sdr-accent-text);border:0;border-radius:var(--ai-sdr-radius-pill);padding:6px var(--ai-sdr-space-3);font-size:12px;cursor:pointer;box-shadow:0 4px 12px color-mix(in srgb, var(--ai-sdr-text) 18%, transparent);min-height:44px;}",
    "[data-ai-sdr-widget][data-ai-sdr-dir=\"rtl\"] [data-ai-sdr-new-messages]{inset-inline-end:auto;inset-inline-start:var(--ai-sdr-space-3);}",
    "@media (max-width:380px){[data-ai-sdr-new-messages]{bottom:calc(var(--ai-sdr-space-6,24px) * 3);}[data-ai-sdr-suggestion]{min-height:44px;}}",
    "[data-ai-sdr-empty]{display:flex;flex-direction:column;gap:var(--ai-sdr-space-3);padding:var(--ai-sdr-space-2) 0;}",
    "[data-ai-sdr-empty-title]{margin:0;font-size:15px;font-weight:600;}",
    "[data-ai-sdr-empty-body]{margin:0;font-size:13px;opacity:.8;}",
    "[data-ai-sdr-suggestions]{display:flex;flex-wrap:wrap;gap:var(--ai-sdr-space-2);}",
    "[data-ai-sdr-suggestion]{font-size:13px;padding:var(--ai-sdr-space-2) 14px;border-radius:var(--ai-sdr-radius-pill);border:1px solid color-mix(in srgb,var(--ai-sdr-text) 20%,transparent);min-height:44px;background:transparent;color:inherit;cursor:pointer;transition:background var(--ai-sdr-motion-fast) ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
    "[data-ai-sdr-suggestion]:hover{background:color-mix(in srgb,var(--ai-sdr-text) 6%,transparent);}",
    "[data-ai-sdr-suggestion]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "@media (prefers-color-scheme: dark){[data-ai-sdr-widget]:not([data-ai-sdr-theme]){--ai-sdr-surface:#0f172a;--ai-sdr-text:#f1f5f9;--ai-sdr-bubble-assistant-bg:color-mix(in srgb, var(--ai-sdr-accent) 6%, var(--ai-sdr-surface));--ai-sdr-composer-bg:#1e293b;--ai-sdr-focus-ring-color:color-mix(in srgb, var(--ai-sdr-accent) 35%, transparent);--ai-sdr-warning-bg:rgba(245,158,11,.08);--ai-sdr-warning-text:#fbbf24;}[data-ai-sdr-widget]:not([data-ai-sdr-theme]) [data-ai-sdr-input]{border-color:color-mix(in srgb, var(--ai-sdr-text) 14%, transparent);}[data-ai-sdr-widget]:not([data-ai-sdr-theme]) [data-ai-sdr-composer]{border-top-color:color-mix(in srgb, var(--ai-sdr-text) 8%, transparent);}}",
    "@media (prefers-reduced-motion: reduce){[data-ai-sdr-send] svg,[data-ai-sdr-typing] span{animation:none !important;}[data-ai-sdr-streaming]::after{animation:none !important;}[data-ai-sdr-stop-generating]{transition:background var(--ai-sdr-motion-fast) ease;}}",
    "[data-ai-sdr-composer-hint]{display:block;font-size:11px;opacity:0.6;color:var(--ai-sdr-text);padding:2px var(--ai-sdr-space-4) var(--ai-sdr-space-1);}",
    "@media (max-width:380px){[data-ai-sdr-composer-hint]{display:none;}}",
    "@media (forced-colors: active){[data-ai-sdr-panel],[data-ai-sdr-bubble]{border:1px solid CanvasText;}[data-ai-sdr-launcher],[data-ai-sdr-send]{border:1px solid ButtonText;forced-color-adjust:none;}[data-ai-sdr-close]:focus-visible,[data-ai-sdr-launcher]:focus-visible,[data-ai-sdr-send]:focus-visible{outline:2px solid Highlight;}}",
    '[data-ai-sdr-widget][data-ai-sdr-reduced-motion] *{transform:none !important;animation:none !important;}',
    '[data-ai-sdr-widget][data-ai-sdr-reduced-motion] [data-ai-sdr-streaming]::after{animation:none !important;opacity:1;}',
    '[data-ai-sdr-widget][data-ai-sdr-reduced-motion] [data-ai-sdr-stop-generating]{transition:none !important;}',
    "[data-ai-sdr-stop-generating]{display:flex;align-items:center;justify-content:center;margin:0 auto var(--ai-sdr-space-2);padding:var(--ai-sdr-space-2) var(--ai-sdr-space-4);background:transparent;color:var(--ai-sdr-text);border:1px solid color-mix(in srgb,var(--ai-sdr-text) 30%,transparent);border-radius:var(--ai-sdr-radius-pill);font-size:13px;cursor:pointer;min-height:44px;min-width:44px;opacity:0;transform:translateY(4px);pointer-events:none;transition:background var(--ai-sdr-motion-fast) ease,opacity var(--ai-sdr-motion-fast) cubic-bezier(.18,.95,.32,1),transform var(--ai-sdr-motion-fast) cubic-bezier(.18,.95,.32,1);}",
    "[data-ai-sdr-stop-generating][data-visible]{opacity:1;transform:translateY(0);pointer-events:auto;}",
    "[data-ai-sdr-stop-generating]:hover{background:color-mix(in srgb,var(--ai-sdr-text) 8%,transparent);}",
    "[data-ai-sdr-stop-generating]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
    "[data-ai-sdr-loading]{display:flex;align-items:center;justify-content:center;padding:var(--ai-sdr-space-4);font-size:13px;opacity:.7;}",
    "[data-ai-sdr-loading][hidden]{display:none;}",
    "[data-ai-sdr-bubble][data-ai-sdr-failed]{border:1px solid var(--ai-sdr-warning-text);background:var(--ai-sdr-warning-bg);}",
    "[data-ai-sdr-inline-retry]{display:block;margin-top:var(--ai-sdr-space-1);background:transparent;color:var(--ai-sdr-warning-text);border:1px solid var(--ai-sdr-warning-text);border-radius:var(--ai-sdr-radius-pill);padding:2px var(--ai-sdr-space-2);font-size:12px;cursor:pointer;min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;}",
    "[data-ai-sdr-inline-retry]:hover{background:var(--ai-sdr-warning-bg);}",
    "[data-ai-sdr-inline-retry]:focus-visible{outline:var(--ai-sdr-focus-outline);outline-offset:2px;}",
  ].join("\n");
}

let widgetSequence = 0;

function resolveWidgetIds(productId) {
  widgetSequence += 1;
  const base = productId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ventora";
  return {
    heading: "ai-sdr-" + base + "-heading-" + widgetSequence,
    empty: "ai-sdr-" + base + "-empty-" + widgetSequence,
    panel: "ai-sdr-" + base + "-panel-" + widgetSequence,
    describe: "ai-sdr-" + base + "-describe-" + widgetSequence,
  };
}

function renderRichTextIncremental(target, oldText, newText) {
  if (oldText !== "" && newText.startsWith(oldText)) {
    const deltaText = newText.slice(oldText.length);
    if (deltaText === "") return;
    let tail = target.lastChild;
    while (tail !== null && tail.nodeType !== 3 && tail.lastChild !== null) {
      tail = tail.lastChild;
    }
    if (tail !== null && tail.nodeType === 3) {
      tail.appendData(deltaText);
      return;
    }
    target.append(document.createTextNode(deltaText));
    return;
  }
  renderRichText(target, newText);
}

function renderRichText(target, raw) {
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
    } else if (block.kind === "table") {
      target.append(buildMarkdownTable(block));
    } else {
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, block.text);
      target.append(paragraph);
    }
  }
}

function buildMarkdownTable(block) {
  const table = document.createElement("table");
  table.dataset.aiSdrTable = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of block.headers) {
    const th = document.createElement("th");
    appendInlineMarkdown(th, header);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    for (let columnIndex = 0; columnIndex < block.headers.length; columnIndex += 1) {
      const td = document.createElement("td");
      appendInlineMarkdown(td, row[columnIndex] ?? "");
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function markdownBlocks(raw) {
  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ kind: "list", items: listItems });
      listItems = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const next = lines[index + 1] ?? "";
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(next)) {
      flushParagraph();
      flushList();
      const headers = tableCells(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && isMarkdownTableRow(lines[cursor] ?? "")) {
        rows.push(tableCells(lines[cursor] ?? ""));
        cursor += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      index = cursor - 1;
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      const itemText = (listMatch[1] ?? "").trim();
      if (itemText === "") continue;
      flushParagraph();
      listItems.push(itemText);
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks.length > 0 ? blocks : [{ kind: "paragraph", text: "" }];
}

function isMarkdownTableRow(line) {
  return line.includes("|") && tableCells(line).length > 1;
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
}

function isSafeLinkUrl(url) {
  // The WHATWG URL parser trims leading/trailing C0 controls + space from the
  // raw URL input before scheme detection, so trimming before our allowlist
  // check matches what the browser would resolve at navigation time.
  if (typeof url !== "string" || url === "") return false;
  const trimmed = url.trim();
  if (trimmed === "") return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("mailto:")) return true;
  return false;
}

function applySafeLink(link, url) {
  link.href = url;
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
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
      const label = token.slice(1, closeBracket);
      const url = token.slice(closeBracket + 2, -1);
      if (isSafeLinkUrl(url)) {
        const link = document.createElement("a");
        link.textContent = label;
        applySafeLink(link, url);
        parent.append(link);
      } else {
        parent.append(document.createTextNode(token));
      }
    }
    lastIndex = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(lastIndex)));
}

const productBrands = {
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
  lextract: {
    productId: "lextract",
    productName: "Lextract",
    accentColor: "#b45309",
    accentTextColor: "#ffffff",
    surfaceColor: "#fffdfa",
    textColor: "#1d1712",
  },
};

function resolveWidgetBrand(productId, override = {}) {
  const key = productId.trim().toLowerCase();
  const fallback = {
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
    iconUrl: typeof override.iconUrl === "string" && override.iconUrl !== "" ? override.iconUrl : undefined,
  };
}

function titleCaseProduct(productId) {
  const cleaned = productId.trim();
  if (cleaned === "") return "Ventora";
  return cleaned
    .split(/[-_\s]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
`;

const hostedClientExports =
  "export { AiSdrApiError, aiSdrInit, aiSdrSessionStoreKey, createAiSdrSession, createAiSdrSseParser, createAiSdrWidget, requestAiSdrHandoff, sendAiSdrChatMessage };";

const hostedClientGlobal =
  "globalThis.VentoraAiSdr = { AiSdrApiError, aiSdrInit, aiSdrSessionStoreKey, createAiSdrSession, createAiSdrSseParser, createAiSdrWidget, requestAiSdrHandoff, sendAiSdrChatMessage };\nglobalThis.AiSdr = { init: aiSdrInit };";

export const hostedClientModule = `${hostedClientCore}\n${hostedClientExports}\n`;

export const hostedClientGlobalModule = `${hostedClientCore}\n${hostedClientGlobal}\n`;

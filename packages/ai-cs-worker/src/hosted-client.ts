const BACKTICK = "`";
const hostedClientCorePart1 = String.raw`
class AiCsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AiCsApiError";
    this.status = status;
  }
}

function createAiCsSseParser(options = {}) {
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
    if (!isAiCsSseEvent(event)) {
      options.onError?.(new Error("Invalid AI-CS SSE event"));
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
    feed(chunk) { buffer += chunk; return drain(false); },
    end() { return drain(true); },
    reset() { buffer = ""; },
  };
}

async function createAiCsSession(config, assertion, options = {}) {
  const json = await postJson(config, "/v1/sessions", assertion.body, assertion.headers, options.signal);
  if (isRecord(json) && typeof json.sessionId === "string") return { sessionId: json.sessionId };
  throw new Error("Invalid create AI-CS session response");
}

async function sendAiCsChatMessage(config, assertion, options = {}) {
  const response = await post(config, "/v1/chat", assertion.body, assertion.headers, options.signal);
  if (!response.ok) {
    const text = await response.text();
    throw new AiCsApiError(errorMessage(parseJsonOrNull(text), response.statusText), response.status);
  }
  const errors = [];
  const events = [];
  const parser = createAiCsSseParser({
    onEvent(event) { events.push(event); options.onEvent?.(event); },
    onError(error) { errors.push(error); },
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
  if (events.length === 0) throw new Error("Invalid AI-CS SSE event");
  return events;
}

async function requestAiCsEscalation(config, assertion, options = {}) {
  const json = await postJson(config, "/v1/escalations", assertion.body, assertion.headers, options.signal);
  if (isRecord(json) && typeof json.escalationId === "string" && typeof json.status === "string") {
    return { escalationId: json.escalationId, status: json.status };
  }
  throw new Error("Invalid AI-CS escalation response");
}

const STYLE_ID = "ventora-ai-cs-styles";

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = AI_CS_STYLES;
  doc.head.append(style);
}

function isSafeLinkUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  const lower = value.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}

function isUsefulNavigationTarget(target) {
  const path = normalizeNavigationPath(target.path);
  if (path === "") return false;
  if (String(target.path ?? "").startsWith("/") && (path === "/" || path === "/home")) return false;
  const label = String(target.label ?? "").trim().toLowerCase();
  if (label === "" || label === "home" || label.includes("positioning")) return false;
  return true;
}

function normalizeNavigationPath(value) {
  try {
    const path = new URL(value, "https://app.local").pathname.replace(/\/+$/, "");
    return path === "" ? "/" : path.toLowerCase();
  } catch {
    return "";
  }
}

function safeHostname(value) {
  try {
    return new URL(value, "https://placeholder.invalid").hostname;
  } catch {
    return "";
  }
}

const VENTORA_INERT_REGISTRY_KEY = Symbol.for("ventora.chat.inertRegistry");
const VENTORA_LIVE_WIDGET_ROOTS_KEY = Symbol.for("ventora.chat.liveWidgetRoots");
const VENTORA_INERT_HOLDERS_KEY = Symbol.for("ventora.chat.inertHolders");
const aiCsGlobalScope = globalThis;
function getSharedInertRegistry() {
  const slot = aiCsGlobalScope[VENTORA_INERT_REGISTRY_KEY];
  if (slot instanceof WeakMap) return slot;
  const fresh = new WeakMap();
  aiCsGlobalScope[VENTORA_INERT_REGISTRY_KEY] = fresh;
  return fresh;
}
function getSharedLiveWidgetRoots() {
  const slot = aiCsGlobalScope[VENTORA_LIVE_WIDGET_ROOTS_KEY];
  if (slot instanceof Set) return slot;
  const fresh = new Set();
  aiCsGlobalScope[VENTORA_LIVE_WIDGET_ROOTS_KEY] = fresh;
  return fresh;
}
function getSharedInertHolders() {
  const slot = aiCsGlobalScope[VENTORA_INERT_HOLDERS_KEY];
  if (slot instanceof Set) return slot;
  const fresh = new Set();
  aiCsGlobalScope[VENTORA_INERT_HOLDERS_KEY] = fresh;
  return fresh;
}
function isMobileViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 640px)").matches
    : false;
}
function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
function acquireInert(element) {
  const registry = getSharedInertRegistry();
  const entry = registry.get(element);
  if (entry !== undefined) {
    entry.refCount += 1;
    return;
  }
  registry.set(element, {
    refCount: 1,
    prevInert: element.hasAttribute("inert"),
    prevAriaHidden: element.getAttribute("aria-hidden"),
  });
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}
function releaseInertOne(element) {
  const registry = getSharedInertRegistry();
  const entry = registry.get(element);
  if (entry === undefined) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  registry.delete(element);
  if (entry.prevInert) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
  if (entry.prevAriaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", entry.prevAriaHidden);
  }
}
function applyInertToSiblings(panel) {
  if (panel === null || panel.parentNode === null) return [];
  if (!isMobileViewport()) return [];
  const liveRoots = getSharedLiveWidgetRoots();
  const inerted = [];
  const siblings = Array.from(document.body.children).filter((node) => !node.contains(panel) && !liveRoots.has(node));
  for (const sibling of siblings) {
    acquireInert(sibling);
    inerted.push(sibling);
  }
  if (inerted.length > 0) {
    const holders = getSharedInertHolders();
    for (const sibling of inerted) holders.add(sibling);
  }
  return inerted;
}
function releaseInert(siblings) {
  const holders = getSharedInertHolders();
  for (const sibling of siblings) {
    releaseInertOne(sibling);
    holders.delete(sibling);
  }
}
function detectRtl() {
  if (typeof document === "undefined") return false;
  const docDir = document.documentElement.dir;
  const bodyDir = document.body?.dir ?? "";
  if (docDir === "rtl" || bodyDir === "rtl") return true;
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    try {
      const computed = window.getComputedStyle(document.documentElement).direction;
      if (computed === "rtl") return true;
    } catch {
      return false;
    }
  }
  return false;
}

const AI_CS_FOCUSABLE = "a[href],area[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex='-1'])";
// A control is unreachable when it — or any ancestor host such as the composer
// form or the stop host — is hidden or marked aria-hidden. closest() makes the
// check ancestor-aware, which matters because the wrapper carries [hidden]
// while the focusable child (textarea, button) does not.
const AI_CS_FOCUS_BLOCKED = "[hidden],[aria-hidden='true']";

const AI_CS_STYLES = `;
const hostedClientCorePart2 = String.raw`
[data-aics-root]{position:fixed;z-index:2147483646;color:var(--aics-text,#0f172a);--aics-space-1:4px;--aics-space-2:8px;--aics-space-3:12px;--aics-space-4:16px;--aics-space-5:20px;--aics-space-6:24px;--aics-radius-sm:8px;--aics-radius-md:12px;--aics-radius-lg:14px;--aics-radius-pill:9999px;--aics-motion-fast:140ms;--aics-motion-base:200ms;--aics-stick-threshold:24px;--aics-error-bg:#fef2f2;--aics-error-text:#991b1b;--aics-success-bg:#ecfdf5;--aics-success-text:#065f46;--aics-warning-bg:rgba(245,158,11,.15);--aics-warning-text:#92400e;--aics-muted-text:color-mix(in srgb,var(--aics-text,#0f172a) 65%,transparent);--aics-focus-ring:var(--aics-accent,#0f172a);--aics-composer-max-height:120px;}
[data-aics-root][data-aics-position="bottom-right"]{inset-inline-end:var(--aics-space-6);bottom:var(--aics-space-6);}
[data-aics-root][data-aics-position="bottom-left"]{inset-inline-start:var(--aics-space-6);bottom:var(--aics-space-6);}
.aics-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}
[data-aics-launcher]{appearance:none;border:0;border-radius:var(--aics-radius-pill);padding:var(--aics-space-3) var(--aics-space-4);background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);font-weight:600;cursor:pointer;box-shadow:0 8px 24px color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);display:inline-flex;align-items:center;gap:var(--aics-space-2);min-height:44px;position:relative;}
[data-aics-launcher][hidden]{display:none;}
[data-aics-launcher]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;box-shadow:0 0 0 6px color-mix(in srgb,var(--aics-focus-ring,var(--aics-accent,#0f172a)) 25%,transparent);}
[data-aics-launcher-icon]{display:inline-flex;align-items:center;justify-content:center;}
[data-aics-panel]{position:absolute;bottom:64px;width:380px;max-height:600px;background:var(--aics-surface,#fff);border-radius:var(--aics-radius-lg);box-shadow:0 24px 60px color-mix(in srgb,var(--aics-text,#0f172a) 22%,transparent);display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);transform-origin:bottom right;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif,'Apple Color Emoji','Segoe UI Emoji';}
[data-aics-root][data-aics-position="bottom-right"] [data-aics-panel]{inset-inline-end:0;}
[data-aics-root][data-aics-position="bottom-left"] [data-aics-panel]{inset-inline-start:0;transform-origin:bottom left;}
[data-aics-header]{display:flex;align-items:center;justify-content:space-between;padding:var(--aics-space-3) var(--aics-space-4);background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);gap:var(--aics-space-2);}
[data-aics-header-text]{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;}
[data-aics-title]{margin:0;font-size:15px;font-weight:600;}
[data-aics-subtitle]{font-size:12px;opacity:.85;font-weight:500;}
[data-aics-overflow]{position:relative;}
[data-aics-overflow-button],[data-aics-close]{background:transparent;border:0;color:inherit;cursor:pointer;font-size:18px;padding:6px 8px;border-radius:9999px;min-width:44px;min-height:44px;}
[data-aics-overflow-button]:focus-visible,[data-aics-close]:focus-visible{outline:2px solid var(--aics-accent-text,#fff);outline-offset:1px;}
[data-aics-overflow-menu]{position:absolute;inset-inline-end:0;top:38px;background:var(--aics-surface,#fff);color:var(--aics-text,#0f172a);border-radius:var(--aics-radius-sm);box-shadow:0 12px 36px color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);min-width:180px;padding:6px;z-index:1;}
[data-aics-overflow-menu] button{display:block;width:100%;text-align:start;padding:var(--aics-space-2) var(--aics-space-3);background:transparent;border:0;border-radius:var(--aics-radius-pill);cursor:pointer;font:inherit;color:inherit;min-height:44px;}
[data-aics-overflow-menu] button:hover,[data-aics-overflow-menu] button:focus-visible{background:color-mix(in srgb,var(--aics-text,#0f172a) 6%,transparent);outline:none;}
[data-aics-transcript]{flex:1 1 auto;overflow-y:auto;padding:var(--aics-space-3) var(--aics-space-4);display:flex;flex-direction:column;gap:10px;background:color-mix(in srgb,var(--aics-surface,#fff) 96%,var(--aics-accent,#0f172a) 4%);scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 30%,transparent) transparent;}
[data-aics-transcript]::-webkit-scrollbar{width:8px;}
[data-aics-transcript]::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 30%,transparent);border-radius:4px;}
[data-aics-loading]{display:flex;align-items:center;justify-content:center;padding:var(--aics-space-6) var(--aics-space-3);color:var(--aics-muted-text,rgba(15,23,42,.7));font-size:13px;}
[data-aics-bubble]{max-width:min(88%,34rem);overflow-wrap:anywhere;padding:10px var(--aics-space-3);border-radius:var(--aics-radius-md);font-size:14px;line-height:1.45;white-space:pre-wrap;position:relative;}
[data-aics-bubble] a{color:currentColor;text-decoration:underline;text-underline-offset:2px;}
[data-aics-bubble] code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;padding:1px 4px;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent);}
[data-aics-root] ::selection{background:color-mix(in srgb,var(--aics-accent,#0f172a) 35%,transparent);}
[data-aics-bubble][data-aics-role="user"]{align-self:flex-end;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);border-end-inline-end-radius:4px;}
[data-aics-bubble][data-aics-role="assistant"]{--aics-assistant-bubble-bg:color-mix(in srgb,var(--aics-accent,#0f172a) 6%,var(--aics-surface,#fff));align-self:flex-start;background:var(--aics-assistant-bubble-bg);border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);border-end-inline-start-radius:4px;}
[data-aics-bubble][data-aics-failed]{outline:2px solid var(--aics-warning-bg,rgba(245,158,11,.15));outline-offset:2px;}
[data-aics-retry-row]{display:flex;gap:8px;padding:4px 0;}
[data-aics-retry-inline]{background:transparent;border:1px solid var(--aics-warning-text,#92400e);color:var(--aics-warning-text,#92400e);border-radius:9999px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;min-height:44px;}
[data-aics-retry-inline]:focus-visible{outline:2px solid var(--aics-warning-text,#92400e);outline-offset:2px;}
[data-aics-stop-host]{display:flex;padding:var(--aics-space-2) var(--aics-space-4);border-top:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);background:var(--aics-surface,#fff);}
[data-aics-stop-host][hidden]{display:none;}
[data-aics-stop]{appearance:none;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);border-radius:9999px;padding:var(--aics-space-2) var(--aics-space-3);background:var(--aics-surface,#fff);color:var(--aics-text,#0f172a);font-weight:600;cursor:pointer;min-height:44px;font:inherit;width:100%;display:flex;align-items:center;justify-content:center;gap:var(--aics-space-2);}
[data-aics-stop]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;}
[data-aics-typing]{align-self:flex-start;background:color-mix(in srgb,var(--aics-accent,#0f172a) 6%,var(--aics-surface,#fff));border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);border-radius:var(--aics-radius-md);border-end-inline-start-radius:4px;padding:var(--aics-space-3) 14px;display:inline-flex;gap:var(--aics-space-1);}
[data-aics-typing] span{width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,var(--aics-text,#0f172a) 50%,transparent);animation:aics-typing 1.2s infinite;}
[data-aics-typing] span:nth-child(2){animation-delay:.15s;}
[data-aics-typing] span:nth-child(3){animation-delay:.3s;}
@keyframes aics-typing{0%,80%,100%{transform:translateY(0);opacity:.4;}40%{transform:translateY(-3px);opacity:1;}}
[data-aics-actions]{display:flex;gap:6px;margin-top:6px;}
[data-aics-actions] button{font-size:11px;padding:2px var(--aics-space-2);border-radius:9999px;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);background:transparent;color:inherit;cursor:pointer;min-height:44px;}
[data-aics-actions] button:hover{background:color-mix(in srgb,var(--aics-text,#0f172a) 6%,transparent);}
[data-aics-actions] button:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:1px;}
[data-aics-sources]{margin-top:6px;font-size:12px;}
[data-aics-sources] summary{list-style:none;cursor:pointer;color:var(--aics-accent,#0f172a);font-weight:600;display:inline-flex;align-items:center;gap:var(--aics-space-1);padding:var(--aics-space-1) 10px;border-radius:var(--aics-radius-pill);margin:-4px -10px;min-height:44px;}
[data-aics-sources] summary::-webkit-details-marker{display:none;}
[data-aics-sources] summary::before{content:"▸";transition:transform var(--aics-motion-fast);}
[data-aics-sources][open] summary::before{transform:rotate(90deg);}
[data-aics-sources] summary:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 10%,transparent);}
[data-aics-sources] a{color:var(--aics-accent,#0f172a);text-decoration:underline;display:block;padding:var(--aics-space-1) 0;}
[data-aics-source-host]{display:block;color:var(--aics-muted-text,rgba(15,23,42,.6));font-weight:400;font-size:11px;text-decoration:none;}
[data-aics-workflow]{margin:10px 0;padding:10px;background:color-mix(in srgb,var(--aics-text,#0f172a) 4%,transparent);border-radius:10px;}
[data-aics-workflow] summary{cursor:pointer;font-weight:600;font-size:13px;}
[data-aics-workflow] ol{list-style:none;margin:var(--aics-space-2) 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}
[data-aics-workflow] li{display:flex;align-items:flex-start;gap:var(--aics-space-2);font-size:13px;}
[data-aics-workflow] li::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--aics-text,#0f172a) 30%,transparent);flex-shrink:0;margin-top:2px;}
[data-aics-workflow] li[data-aics-status="done"]::before{background:var(--aics-accent,#0f172a);border-color:var(--aics-accent,#0f172a);}
[data-aics-workflow] li[data-aics-status="current"]::before{border-color:var(--aics-accent,#0f172a);box-shadow:0 0 0 3px color-mix(in srgb,var(--aics-accent,#0f172a) 20%,transparent);}
[data-aics-workflow] li[data-aics-status="current"]{font-weight:600;}
[data-aics-workflow] li[data-aics-status="done"]{opacity:.7;text-decoration:none;}
[data-aics-escalate-host]{padding:0 var(--aics-space-4) var(--aics-space-2);}
[data-aics-escalate]{background:color-mix(in srgb,var(--aics-accent,#0f172a) 12%,white);color:var(--aics-accent,#0f172a);border:1px solid color-mix(in srgb,var(--aics-accent,#0f172a) 30%,transparent);font-weight:600;padding:var(--aics-space-2) 14px;border-radius:var(--aics-radius-pill);display:inline-flex;align-items:center;gap:6px;min-height:44px;cursor:pointer;font:inherit;}
[data-aics-escalate]:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 18%,white);}
[data-aics-escalate]:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[data-aics-jump]{position:absolute;inset-inline-start:50%;transform:translateX(-50%);bottom:calc(var(--aics-space-6) * 3 + var(--aics-space-3));background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);border:0;border-radius:var(--aics-radius-pill);padding:6px var(--aics-space-3);font-size:12px;cursor:pointer;box-shadow:0 8px 20px color-mix(in srgb,var(--aics-text,#0f172a) 30%,transparent);min-height:44px;min-width:44px;}
[data-aics-jump]:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[dir="rtl"] [data-aics-jump]{transform:translateX(50%);}
[data-aics-navigation]{display:flex;flex-wrap:wrap;gap:6px;padding:6px var(--aics-space-4);border-top:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);background:var(--aics-surface,#fff);}
[data-aics-navigation][hidden]{display:none;}
[data-aics-navigation] button{appearance:none;border:1px solid var(--aics-accent,#0f172a);background:transparent;color:var(--aics-accent,#0f172a);border-radius:var(--aics-radius-pill);padding:6px var(--aics-space-3);font-size:12px;cursor:pointer;min-height:44px;}
[data-aics-navigation] button:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 10%,transparent);}
[data-aics-navigation] button:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[data-aics-composer]{display:flex;gap:var(--aics-space-2);padding:var(--aics-space-3) var(--aics-space-4);border-top:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);background:var(--aics-surface,#fff);}
[data-aics-composer][hidden]{display:none;}
[data-aics-composer] textarea{flex:1 1 auto;resize:none;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);border-radius:10px;padding:var(--aics-space-2) 10px;font:inherit;color:inherit;background:#fff;min-height:44px;max-height:var(--aics-composer-max-height,120px);}
[data-aics-composer] textarea:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:0;}
[data-aics-send]{appearance:none;border:0;border-radius:9999px;padding:var(--aics-space-2) 14px;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);font-weight:600;cursor:pointer;min-width:64px;min-height:44px;}
[data-aics-send]:disabled{background:color-mix(in srgb,var(--aics-accent,#0f172a) 30%,#e5e7eb);color:rgba(255,255,255,.85);opacity:1;cursor:not-allowed;box-shadow:none;}
[data-aics-send]:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[data-aics-banner]{padding:10px var(--aics-space-3);border-radius:10px;background:var(--aics-success-bg,#ecfdf5);color:var(--aics-success-text,#065f46);font-size:13px;margin:var(--aics-space-2) var(--aics-space-4) 0;display:flex;align-items:center;gap:var(--aics-space-2);justify-content:space-between;}
[data-aics-banner][data-aics-status="error"]{background:var(--aics-error-bg,#fef2f2);color:var(--aics-error-text,#991b1b);}
[data-aics-banner-action]{background:transparent;border:1px solid currentColor;color:inherit;border-radius:9999px;padding:var(--aics-space-1) var(--aics-space-2);font:inherit;font-size:12px;font-weight:600;cursor:pointer;min-height:44px;}
[data-aics-banner-action]:focus-visible{outline:2px solid currentColor;outline-offset:2px;}
[data-aics-banner-dismiss]{background:transparent;border:0;color:inherit;cursor:pointer;font-size:16px;padding:4px 8px;border-radius:9999px;margin-inline-start:auto;min-height:44px;min-width:44px;}
[data-aics-banner-dismiss]:focus-visible{outline:2px solid currentColor;outline-offset:2px;}
[data-aics-toast]{position:absolute;inset-inline-start:50%;transform:translateX(-50%);bottom:calc(var(--aics-space-6) * 3 + var(--aics-space-2));background:#0f172a;color:#fff;padding:var(--aics-space-2) var(--aics-space-3);border-radius:var(--aics-radius-sm);font-size:12px;box-shadow:0 8px 20px color-mix(in srgb,var(--aics-text,#0f172a) 30%,transparent);display:flex;align-items:center;gap:var(--aics-space-2);}
[data-aics-toast-dismiss]{background:transparent;border:0;color:inherit;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:9999px;min-height:44px;min-width:44px;}
[data-aics-toast-dismiss]:focus-visible{outline:2px solid #fff;outline-offset:2px;}
[dir="rtl"] [data-aics-toast]{transform:translateX(50%);}
[data-aics-empty]{font-size:13px;color:var(--aics-muted-text,rgba(15,23,42,.7));text-align:center;padding:var(--aics-space-6) var(--aics-space-3);}
[dir="rtl"] [data-aics-bubble][data-aics-role="user"]{align-self:flex-start;}
[dir="rtl"] [data-aics-bubble][data-aics-role="assistant"]{align-self:flex-end;}
[dir="rtl"] [data-aics-panel]{transform-origin:bottom left;}
[dir="rtl"] [data-aics-root][data-aics-position="bottom-right"] [data-aics-panel]{inset-inline-end:0;inset-inline-start:auto;}
[dir="rtl"] [data-aics-root][data-aics-position="bottom-left"] [data-aics-panel]{inset-inline-start:0;inset-inline-end:auto;}
@media (prefers-reduced-motion: no-preference){
  [data-aics-panel]{animation:aics-pop 200ms cubic-bezier(.18,.95,.32,1);}
  [data-aics-bubble]{animation:aics-bubble-in 170ms ease-out;}
  [data-aics-loading]{animation:aics-fade-in 170ms ease-out;}
  [data-aics-stop-host]{transition:opacity 140ms ease;}
  [data-aics-toast]{animation:aics-toast-in var(--aics-motion-fast) ease-out;}
  [data-aics-toast][data-aics-leaving]{animation:aics-toast-out var(--aics-motion-fast) ease-in forwards;}
  [data-aics-launcher]:active,[data-aics-send]:active{transform:translateY(1px);}
  [data-aics-escalate]{animation:aics-escalate-in 200ms ease-out;}
  [data-aics-streaming]::after{animation:aics-caret 1s steps(2) infinite;}
}
[data-aics-streaming]::after{content:"";display:inline-block;width:2px;height:1em;background:currentColor;margin-left:2px;vertical-align:-2px;}
@keyframes aics-pop{from{opacity:0;transform:translateY(8px) scale(.96);}to{opacity:1;transform:none;}}
@keyframes aics-bubble-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@keyframes aics-fade-in{from{opacity:0;}to{opacity:1;}}
@keyframes aics-escalate-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@keyframes aics-caret{50%{opacity:0;}}
@keyframes aics-toast-in{from{opacity:0;transform:translate(-50%,4px);}to{opacity:1;transform:translate(-50%,0);}}
@keyframes aics-toast-out{from{opacity:1;}to{opacity:0;transform:translate(-50%,4px);}}
@supports not (background: color-mix(in srgb, red, blue)){
  [data-aics-bubble][data-aics-role="assistant"]{background:#f1f5f9;border-color:rgba(15,23,42,.08);}
  [data-aics-escalate]{background:#e2e8f0;border-color:#94a3b8;}
  [data-aics-banner]{background:#ecfdf5;}
  [data-aics-sources] summary:hover{background:#e2e8f0;}
  [data-aics-navigation] button:hover{background:#e2e8f0;}
  [data-aics-launcher]:focus-visible{box-shadow:0 0 0 6px rgba(15,23,42,.25);}
}
@media (prefers-reduced-motion: reduce){[data-aics-root] *{transition:none!important;animation:none!important;}}
[data-aics-root][data-aics-reduced-motion] *,[data-aics-root][data-aics-reduced-motion] *::before,[data-aics-root][data-aics-reduced-motion] *::after{animation:none!important;transition:none!important;}
@media (prefers-color-scheme: dark){
  [data-aics-root]:not([data-aics-theme]){--aics-surface:#0f172a;--aics-text:#f1f5f9;--aics-focus-ring:#94a3b8;--aics-muted-text:rgba(241,245,249,.65);--aics-error-bg:#3b0a0a;--aics-error-text:#fca5a5;--aics-success-bg:#052e16;--aics-success-text:#86efac;}
  [data-aics-root]:not([data-aics-theme]) [data-aics-bubble]{background:#1e293b;border-color:rgba(255,255,255,.08);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-bubble][data-aics-role="user"]{background:var(--aics-accent,#0f172a);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-typing]{background:#1e293b;border-color:rgba(255,255,255,.08);}
}
@media (forced-colors: active){
  [data-aics-panel]{border:1px solid CanvasText;}
  [data-aics-bubble]{border:1px solid CanvasText;}
  [data-aics-launcher],[data-aics-send]{border:2px solid ButtonText;}
  [data-aics-launcher]:focus-visible,[data-aics-send]:focus-visible{outline:3px solid Highlight;}
}
@media (max-width:640px){
  [data-aics-panel]{position:fixed;inset:0;width:100vw;height:100dvh;height:100svh;max-height:none;border-radius:0;bottom:0;inset-inline-start:0;inset-inline-end:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-inline-start:env(safe-area-inset-left);padding-inline-end:env(safe-area-inset-right);box-sizing:border-box;}
  [data-aics-composer] textarea{font-size:16px;}
  [data-aics-close]{min-width:44px;min-height:44px;}
  [data-aics-navigation] button{min-height:44px;}
  [data-aics-escalate]{min-height:44px;}
  [data-aics-jump]{min-height:44px;min-width:44px;}
  [data-aics-retry-inline]{min-height:44px;}
  [data-aics-banner-action]{min-height:44px;}
}
@media (max-height:540px) and (orientation:landscape){
  [data-aics-panel]{position:fixed;inset:0;width:100vw;height:100dvh;max-height:none;border-radius:0;}
}
`;
const hostedClientCorePart3 = String.raw`;

function createAiCsWidget(options) {
  let root = null;
  let panel = null;
  let transcript = null;
  let liveRegion = null;
  let unreadLiveRegion = null;
  let composer = null;
  let composerInput = null;
  let sendButton = null;
  let stopHost = null;
  let stopButton = null;
  let launcher = null;
  let header = null;
  let navigationStrip = null;
  let bannerHost = null;
  let toastHost = null;
  let toastTimer = null;
  let toastLeaveTimer = null;
  let bannerTimer = null;
  let overflowMenu = null;
  let overflowButton = null;
  let pendingTyping = null;
  let escalateHost = null;
  let escalateButton = null;
  let jumpButton = null;
  let loadingEl = null;
  let openState = false;
  let destroyed = false;
  let sending = false;
  let escalating = false;
  let sessionReady = false;
  let chatController = null;
  let inertedSiblings = [];
  let keydownHandler = null;
  let documentClickHandler = null;
  let onlineHandler = null;
  let offlineHandler = null;
  let visualViewportHandler = null;
  let resizeHandler = null;
  let composerFocusHandler = null;
  let motionMq = null;
  let motionHandler = null;
  let streamingCount = 0;
  let unreadCount = 0;
  const retriedMessageIds = new Set();
  let offlineBannerActive = false;
  let sessionId = options.session?.sessionId ?? null;
  let conversationVersion = 0;
  let stickBottom = true;
  let assistantBubbleCount = 0;
  let hasErrorBanner = false;
  const assistantMessagesById = new Map();
  const completedAssistantMessageIds = new Set();
  const brand = resolveWidgetBrand(options.brand);
  const copy = resolveCopy(options.copy);
  const escalationBookingUrl = resolveEscalationBookingUrl(options.brand?.id, options);
  const locale = options.locale ?? "en";
  const position = options.position === "bottom-left" ? "bottom-left" : "bottom-right";
  const widgetIds = resolveWidgetIds(brand.id);
  let lastFocusedExternal = null;

  const ensureRoot = () => {
    if (root !== null) return;
    ensureStyles(document);
    root = document.createElement("div");
    root.dataset.aicsRoot = "";
    root.dataset.aicsPosition = position;
    root.lang = locale;
    if (detectRtl()) root.setAttribute("dir", "rtl");
    root.style.setProperty("--aics-accent", brand.accentColor);
    root.style.setProperty("--aics-accent-text", brand.accentTextColor);
    root.style.setProperty("--aics-surface", brand.surfaceColor);
    root.style.setProperty("--aics-text", brand.textColor);
    // The brand defines explicit surface/text colors as inline custom properties,
    // which always outrank the auto dark-mode stylesheet rule. Mark the instance as
    // themed so the prefers-color-scheme:dark block opts out instead of half-applying
    // (which would leave a light brand surface with dark bubbles/typing indicator).
    root.dataset.aicsTheme = "";
    if (prefersReducedMotion()) root.dataset.aicsReducedMotion = "";
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
      motionHandler = (e) => {
        if (root === null) return;
        if (e.matches) { root.dataset.aicsReducedMotion = ""; }
        else { delete root.dataset.aicsReducedMotion; }
      };
      if (typeof motionMq.addEventListener === "function") {
        motionMq.addEventListener("change", motionHandler);
      } else if (typeof motionMq.addListener === "function") {
        motionMq.addListener(motionHandler);
      }
    }
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.dataset.aicsLauncher = "";
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", widgetIds.panel);
    const launcherIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    launcherIcon.setAttribute("width", "16");
    launcherIcon.setAttribute("height", "16");
    launcherIcon.setAttribute("viewBox", "0 0 24 24");
    launcherIcon.setAttribute("fill", "none");
    launcherIcon.setAttribute("stroke", "currentColor");
    launcherIcon.setAttribute("stroke-width", "2");
    launcherIcon.setAttribute("aria-hidden", "true");
    launcherIcon.dataset.aicsLauncherIcon = "";
    const iconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    iconPath.setAttribute("d", "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z");
    iconPath.setAttribute("stroke-linecap", "round");
    iconPath.setAttribute("stroke-linejoin", "round");
    launcherIcon.append(iconPath);
    const launcherLabel = document.createElement("span");
    launcherLabel.textContent = copy.launcher;
    launcher.append(launcherIcon, launcherLabel);
    launcher.addEventListener("click", () => { void widget.open(); });
    root.append(launcher);
    document.body.append(root);
  };

  function openEscalationBooking() {
    closeOverflowMenu();
    const opener = globalThis.open;
    if (typeof opener === "function") {
      opener.call(globalThis, escalationBookingUrl, "_blank", "noopener,noreferrer");
    }
  }

  const buildPanel = () => {
    if (panel !== null || root === null) return;
    panel = document.createElement("div");
    panel.id = widgetIds.panel;
    panel.dataset.aicsPanel = "";
    panel.setAttribute("role", "dialog");
    if (isMobileViewport()) panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", widgetIds.title);
    header = document.createElement("div");
    header.dataset.aicsHeader = "";
    const headerText = document.createElement("div");
    headerText.dataset.aicsHeaderText = "";
    const title = document.createElement("h2");
    title.dataset.aicsTitle = "";
    title.id = widgetIds.title;
    title.textContent = copy.title;
    const subtitle = document.createElement("div");
    subtitle.dataset.aicsSubtitle = "";
    subtitle.textContent = copy.subtitle;
    headerText.append(title, subtitle);
    const overflow = document.createElement("div");
    overflow.dataset.aicsOverflow = "";
    overflowButton = document.createElement("button");
    overflowButton.type = "button";
    overflowButton.dataset.aicsOverflowButton = "";
    overflowButton.setAttribute("aria-haspopup", "menu");
    overflowButton.setAttribute("aria-expanded", "false");
    overflowButton.setAttribute("aria-label", copy.overflowLabel);
    overflowButton.textContent = "⋮";
    overflowButton.addEventListener("click", toggleOverflowMenu);
    overflowMenu = document.createElement("div");
    overflowMenu.dataset.aicsOverflowMenu = "";
    overflowMenu.setAttribute("role", "menu");
    overflowMenu.hidden = true;
    const escalateMenuItem = document.createElement("button");
    escalateMenuItem.type = "button";
    escalateMenuItem.setAttribute("role", "menuitem");
    escalateMenuItem.tabIndex = -1;
    escalateMenuItem.textContent = copy.escalate;
    escalateMenuItem.addEventListener("click", openEscalationBooking);
    overflowMenu.append(escalateMenuItem);
    overflowMenu.addEventListener("keydown", handleMenuKeydown);
    overflow.append(overflowButton, overflowMenu);
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.aicsClose = "";
    close.setAttribute("aria-label", copy.close);
    close.textContent = "×";
    close.addEventListener("click", () => { widget.close(); });
    header.append(headerText, overflow, close);
    bannerHost = document.createElement("div");
    transcript = document.createElement("div");
    transcript.dataset.aicsTranscript = "";
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-label", copy.transcriptLabel);
    transcript.setAttribute("aria-relevant", "additions text");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-busy", "false");
    transcript.tabIndex = 0;
    transcript.addEventListener("scroll", () => {
      stickBottom = isStickyBottom();
      if (stickBottom && jumpButton !== null) {
        jumpButton.remove();
        jumpButton = null;
        unreadCount = 0;
        if (unreadLiveRegion !== null) unreadLiveRegion.textContent = "";
      }
    });
    liveRegion = document.createElement("div");
    liveRegion.dataset.aicsLive = "";
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.className = "aics-sr-only";
    unreadLiveRegion = document.createElement("div");
    unreadLiveRegion.setAttribute("aria-live", "polite");
    unreadLiveRegion.setAttribute("aria-atomic", "true");
    unreadLiveRegion.className = "aics-sr-only";
    renderLoadingOrEmptyState();
    escalateHost = document.createElement("div");
    escalateHost.dataset.aicsEscalateHost = "";
    escalateButton = document.createElement("button");
    escalateButton.type = "button";
    escalateButton.dataset.aicsEscalate = "";
    escalateButton.textContent = copy.escalate;
    escalateButton.addEventListener("click", openEscalationBooking);
    escalateHost.append(escalateButton);
    navigationStrip = document.createElement("div");
    navigationStrip.dataset.aicsNavigation = "";
    navigationStrip.setAttribute("role", "group");
    navigationStrip.setAttribute("aria-label", copy.suggestions);
    navigationStrip.hidden = true;
    stopHost = document.createElement("div");
    stopHost.dataset.aicsStopHost = "";
    stopHost.hidden = true;
    stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.dataset.aicsStop = "";
    stopButton.textContent = copy.stopGenerating;
    stopButton.addEventListener("click", () => { widget.stopGenerating(); });
    stopHost.append(stopButton);
    composer = document.createElement("form");
    composer.dataset.aicsComposer = "";
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void sendCurrentMessage();
    });
    composerInput = document.createElement("textarea");
    composerInput.setAttribute("aria-label", copy.messageLabel);
    composerInput.placeholder = copy.placeholder;
    composerInput.rows = 1;
    composerInput.addEventListener("input", () => {
      autosizeComposer();
      updateSendState();
    });
    composerInput.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        void sendCurrentMessage();
      }
    });
    sendButton = document.createElement("button");
    sendButton.type = "submit";
    sendButton.dataset.aicsSend = "";
    sendButton.textContent = copy.send;
    composer.append(composerInput, sendButton);
    toastHost = document.createElement("div");
    panel.append(header, bannerHost, transcript, escalateHost, navigationStrip, stopHost, composer, toastHost, liveRegion, unreadLiveRegion);
    root.append(panel);
    updateSendState();
  };

  function isStickyBottom() {
    if (transcript === null) return true;
    let threshold = 24;
    if (root !== null && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      try {
        const raw = window.getComputedStyle(root).getPropertyValue("--aics-stick-threshold").trim();
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) threshold = parsed;
      } catch {
        threshold = 24;
      }
    }
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < threshold;
  }

  function scrollIfSticky() {
    if (transcript === null) return;
    if (stickBottom) {
      if (prefersReducedMotion() || typeof transcript.scrollTo !== "function") {
        transcript.scrollTop = transcript.scrollHeight;
      } else {
        transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
      }
    } else {
      showJumpToLatest();
    }
  }

  function updateJumpLabel() {
    if (jumpButton === null) return;
    const label = unreadCount > 0
      ? copy.newMessages.replace("{count}", String(unreadCount))
      : copy.jumpLatest;
    jumpButton.textContent = label;
    jumpButton.setAttribute("aria-label", copy.jumpLatest);
    if (unreadLiveRegion !== null && unreadCount > 0) {
      unreadLiveRegion.textContent = copy.newMessages.replace("{count}", String(unreadCount));
    }
  }

  function showJumpToLatest() {
    if (panel === null || jumpButton !== null) return;
    jumpButton = document.createElement("button");
    jumpButton.type = "button";
    jumpButton.dataset.aicsJump = "";
    jumpButton.setAttribute("aria-label", copy.jumpLatest);
    jumpButton.textContent = copy.jumpLatest;
    jumpButton.addEventListener("click", () => {
      if (transcript !== null) {
        if (prefersReducedMotion() || typeof transcript.scrollTo !== "function") {
          transcript.scrollTop = transcript.scrollHeight;
        } else {
          transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
        }
        stickBottom = true;
      }
      unreadCount = 0;
      if (unreadLiveRegion !== null) unreadLiveRegion.textContent = "";
      jumpButton?.remove();
      jumpButton = null;
    });
    (stopHost?.hidden === false ? stopHost : composer)?.before(jumpButton);
  }

  function autosizeComposer() {
    if (composerInput === null) return;
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(120, composerInput.scrollHeight) + "px";
  }

  function handleMenuKeydown(event) {
    if (overflowMenu === null || overflowButton === null) return;
    const items = Array.from(overflowMenu.querySelectorAll("[role='menuitem']"));
    if (items.length === 0) return;
    const active = document.activeElement;
    const currentIndex = items.indexOf(active);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = items[(currentIndex + 1) % items.length];
      next?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = items[(currentIndex - 1 + items.length) % items.length];
      prev?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeOverflowMenu();
      overflowButton.focus();
    } else if (event.key === "Tab") {
      overflowButton.focus();
      closeOverflowMenu();
    }
  }

  function toggleOverflowMenu() {
    if (overflowMenu === null || overflowButton === null) return;
    const opening = overflowMenu.hidden;
    overflowMenu.hidden = !opening;
    overflowButton.setAttribute("aria-expanded", String(opening));
    if (opening) {
      const firstItem = overflowMenu.querySelector("[role='menuitem']");
      firstItem?.focus();
    }
  }

  function closeOverflowMenu() {
    if (overflowMenu === null || overflowButton === null) return;
    overflowMenu.hidden = true;
    overflowButton.setAttribute("aria-expanded", "false");
  }

  function renderLoadingOrEmptyState() {
    if (transcript === null) return;
    transcript.replaceChildren();
    if (!sessionReady) {
      loadingEl = document.createElement("div");
      loadingEl.dataset.aicsLoading = "";
      loadingEl.setAttribute("role", "status");
      loadingEl.setAttribute("aria-label", copy.loading);
      loadingEl.textContent = copy.loading;
      transcript.append(loadingEl);
    } else {
      loadingEl = null;
      const empty = document.createElement("div");
      empty.dataset.aicsEmpty = "";
      empty.id = widgetIds.empty;
      empty.textContent = copy.empty;
      transcript.append(empty);
    }
  }

  function renderEmptyState() {
    if (transcript === null) return;
    transcript.replaceChildren();
    loadingEl = null;
    const empty = document.createElement("div");
    empty.dataset.aicsEmpty = "";
    empty.id = widgetIds.empty;
    empty.textContent = copy.empty;
    transcript.append(empty);
  }

  function clearEmptyState() {
    if (transcript === null) return;
    const empty = transcript.querySelector("[data-aics-empty]");
    if (empty !== null) empty.remove();
  }

  function attachAssistantActions(bubble, body) {
    const actions = document.createElement("div");
    actions.dataset.aicsActions = "";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = copy.copy;
    copyButton.addEventListener("click", () => {
      void copyText(body.textContent ?? "");
      showToast(copy.copied);
    });
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.textContent = copy.retry;
    retryButton.dataset.aicsRetry = "";
    retryButton.addEventListener("click", () => { void widget.retry(); });
    actions.append(copyButton, retryButton);
    bubble.append(actions);
  }

  function markBubbleFailed(bubble) {
    if (bubble === null) return;
    bubble.dataset.aicsFailed = "";
    // Attach an explicit inline retry affordance directly below the failed bubble.
    // Scope the dedup to this bubble's own next sibling so an orphaned row elsewhere
    // in the transcript cannot suppress a fresh retry affordance for a later failure.
    const sibling = bubble.nextElementSibling;
    if (sibling !== null && sibling.hasAttribute("data-aics-retry-row")) return;
    const row = document.createElement("div");
    row.dataset.aicsRetryRow = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.aicsRetryInline = "";
    btn.textContent = copy.retry;
    btn.addEventListener("click", () => { void widget.retry(); });
    row.append(btn);
    bubble.after(row);
  }

  function appendBubble(role, content) {
    if (transcript === null || destroyed) return null;
    clearEmptyState();
    const bubble = document.createElement("div");
    bubble.dataset.aicsBubble = "";
    bubble.dataset.aicsRole = role;
    const body = document.createElement("div");
    body.textContent = content;
    bubble.append(body);
    if (role === "assistant") {
      attachAssistantActions(bubble, body);
      assistantBubbleCount += 1;
      unreadCount += 1;
      updateJumpLabel();
    }
    transcript.append(bubble);
    scrollIfSticky();
    return bubble;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      return;
    }
  }

  function showToast(message) {
    if (toastHost === null) return;
    if (toastTimer !== null) {
      globalThis.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastLeaveTimer !== null) {
      globalThis.clearTimeout(toastLeaveTimer);
      toastLeaveTimer = null;
    }
    toastHost.replaceChildren();
    const toast = document.createElement("div");
    toast.dataset.aicsToast = "";
    toast.setAttribute("role", "status");
    const textSpan = document.createElement("span");
    textSpan.textContent = message;
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.dataset.aicsToastDismiss = "";
    dismissBtn.setAttribute("aria-label", copy.close);
    dismissBtn.textContent = "×";
    const dismissToast = () => {
      clearToastTimer();
      toast.remove();
    };
    dismissBtn.addEventListener("click", dismissToast);
    dismissBtn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); dismissToast(); }
    });
    toast.append(textSpan, dismissBtn);
    toastHost.append(toast);
    const dismissAfter = 1800;
    const leaveBefore = 140;
    toastLeaveTimer = globalThis.setTimeout(() => {
      toast.dataset.aicsLeaving = "";
      toastLeaveTimer = null;
    }, dismissAfter - leaveBefore);
    toastTimer = globalThis.setTimeout(() => {
      toast.remove();
      toastTimer = null;
    }, dismissAfter);
  }

  function clearToastTimer() {
    if (toastTimer !== null) {
      globalThis.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastLeaveTimer !== null) {
      globalThis.clearTimeout(toastLeaveTimer);
      toastLeaveTimer = null;
    }
  }

  function clearBannerTimer() {
    if (bannerTimer !== null) {
      globalThis.clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  }

  function showBanner(message, status, opts) {
    if (bannerHost === null) return;
    clearBannerTimer();
    bannerHost.replaceChildren();
    const banner = document.createElement("div");
    banner.dataset.aicsBanner = "";
    banner.dataset.aicsStatus = status;
    banner.setAttribute("role", status === "error" ? "alert" : "status");
    const text = document.createElement("span");
    text.textContent = message;
    banner.append(text);
    if (isRecord(opts) && typeof opts.actionLabel === "string" && typeof opts.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.dataset.aicsBannerAction = "";
      action.textContent = opts.actionLabel;
      const handler = opts.onAction;
      action.addEventListener("click", () => { handler(); });
      banner.append(action);
    }
    if (status === "error") {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.dataset.aicsBannerDismiss = "";
      dismissBtn.setAttribute("aria-label", copy.close);
      dismissBtn.textContent = "×";
      const dismissBanner = () => {
        banner.remove();
        hasErrorBanner = false;
      };
      dismissBtn.addEventListener("click", dismissBanner);
      dismissBtn.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); dismissBanner(); }
      });
      banner.append(dismissBtn);
    }
    bannerHost.append(banner);
    hasErrorBanner = status === "error";
    if (status === "ok") {
      bannerTimer = globalThis.setTimeout(() => {
        banner.remove();
        bannerTimer = null;
      }, 6000);
    }
  }

  function clearBanner() {
    bannerHost?.replaceChildren();
    clearBannerTimer();
    hasErrorBanner = false;
  }

  function appendSources(bubble, source) {
    if (bubble === null) {
      if (options.debug === true) console.warn("ai-cs: source event arrived with no matching assistant bubble");
      return;
    }
    let details = bubble.querySelector("[data-aics-sources]");
    if (details === null) {
      details = document.createElement("details");
      details.dataset.aicsSources = "";
      const summary = document.createElement("summary");
      summary.textContent = copy.sources;
      details.append(summary);
      bubble.append(details);
    }
    if (!isSafeLinkUrl(source.url)) {
      const fallback = document.createElement("span");
      fallback.dataset.aicsSourcePlain = "";
      fallback.textContent = source.title;
      details.append(fallback);
      return;
    }
    const link = document.createElement("a");
    link.href = source.url;
    link.textContent = source.title;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const host = safeHostname(source.url);
    if (host !== "" && host !== "placeholder.invalid") {
      const hostSpan = document.createElement("span");
      hostSpan.dataset.aicsSourceHost = "";
      hostSpan.textContent = host;
      link.append(hostSpan);
    }
    details.append(link);
  }

  function appendWorkflow(step) {
    if (transcript === null) return;
    clearEmptyState();
    let host = transcript.querySelector("[data-aics-workflow]");
    let list;
    if (host === null) {
      host = document.createElement("details");
      host.dataset.aicsWorkflow = "";
      host.open = true;
      const summary = document.createElement("summary");
      summary.textContent = copy.workflow;
      list = document.createElement("ol");
      host.append(summary, list);
      transcript.append(host);
    } else {
      const existing = host.querySelector("ol");
      list = existing !== null ? existing : document.createElement("ol");
      if (existing === null) host.append(list);
    }
    const item = document.createElement("li");
    item.dataset.aicsStep = step.id;
    item.dataset.aicsStatus = step.status;
    item.textContent = step.label;
    list.append(item);
  }

  function renderNavigation(target) {
    if (navigationStrip === null) return;
    if (!isSafeLinkUrl(target.path)) return;
    if (!isUsefulNavigationTarget(target)) return;
    navigationStrip.hidden = false;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.aicsNavigationChip = "";
    chip.dataset.aicsPath = target.path;
    chip.textContent = target.label;
    chip.addEventListener("click", () => {
      const url = target.path;
      if (!isSafeLinkUrl(url)) return;
      const event = new CustomEvent("aics:navigate", { detail: { url, path: target.path, label: target.label } });
      window.dispatchEvent(event);
      options.callbacks?.onNavigate?.({ url, path: target.path, label: target.label });
    });
    navigationStrip.append(chip);
  }

  function clearNavigation() {
    if (navigationStrip === null) return;
    navigationStrip.replaceChildren();
    navigationStrip.hidden = true;
  }

  function updateSendState() {
    if (composerInput === null || sendButton === null) return;
    const value = composerInput.value.trim();
    const disabled = value === "" || sessionId === null || destroyed || sending || offlineBannerActive;
    sendButton.disabled = disabled;
    sendButton.setAttribute("aria-disabled", String(disabled));
    composerInput.readOnly = sending;
    composerInput.setAttribute("aria-busy", String(sending));
  }

  function showPending() {
    hidePending();
    if (transcript === null) return;
    clearEmptyState();
    pendingTyping = document.createElement("div");
    pendingTyping.dataset.aicsTyping = "";
    pendingTyping.dataset.aicsPending = "";
    pendingTyping.setAttribute("role", "status");
    pendingTyping.setAttribute("aria-label", copy.typingLabel);
    for (let i = 0; i < 3; i += 1) {
      pendingTyping.append(document.createElement("span"));
    }
    transcript.append(pendingTyping);
    scrollIfSticky();
  }

  function hidePending() {
    pendingTyping?.remove();
    pendingTyping = null;
  }

  function convertPendingToBubble(messageId) {
    if (pendingTyping === null || transcript === null) return null;
    const bubble = document.createElement("div");
    bubble.dataset.aicsBubble = "";
    bubble.dataset.aicsRole = "assistant";
    bubble.dataset.aicsConverted = "true";
    const body = document.createElement("div");
    body.textContent = "";
    bubble.append(body);
    attachAssistantActions(bubble, body);
    transcript.replaceChild(bubble, pendingTyping);
    pendingTyping = null;
    assistantBubbleCount += 1;
    bubble.dataset.aicsMessageId = messageId;
    assistantMessagesById.set(messageId, bubble);
    scrollIfSticky();
    return bubble;
  }

  let lastUserMessage = "";

  function updateStreamingUI() {
    const streaming = streamingCount > 0;
    // Read focus before anything is hidden: hiding the composer mid-stream would
    // otherwise drop focus to <body>. Mirrors the stop -> composer handoff below.
    const composerHadFocus = composer !== null && !composer.hidden && composer.contains(document.activeElement);
    if (stopHost !== null) {
      const wasVisible = !stopHost.hidden;
      const stopHadFocus = stopButton !== null && document.activeElement === stopButton;
      stopHost.hidden = !streaming;
      if (wasVisible && !streaming && stopHadFocus && composerInput !== null) {
        composerInput.focus();
      }
      if (streaming && composerHadFocus && stopButton !== null) {
        stopButton.focus();
      }
    }
    if (composer !== null) composer.hidden = streaming;
  }

  // Mint a fresh AUTHENTICATED session through the exact same signed plumbing
  // used by widget.open(). Both the initial open and the transparent 404 recovery
  // call this so recovery never bypasses the client-assertion signature.
  async function mintAuthenticatedSession(signal) {
    const assertion = await options.signRequest({
      path: "/v1/sessions",
      body: options.clientAssertion.body,
    });
    const response = await createAiCsSession({ baseUrl: options.baseUrl }, assertion, { signal });
    return response.sessionId;
  }

  async function sendCurrentMessage() {
    const message = composerInput?.value.trim() ?? "";
    if (message === "" || sessionId === null || destroyed || sending) return;
    sending = true;
    const version = conversationVersion;
    const controller = new AbortController();
    chatController = controller;
    if (composerInput !== null) {
      composerInput.value = "";
      autosizeComposer();
    }
    updateSendState();
    clearNavigation();
    appendBubble("user", message);
    lastUserMessage = message;
    showPending();
    clearBanner();
    transcript?.setAttribute("aria-busy", "true");
    let lastAssistantBubble = null;
    try {
      const dispatchChatEvent = (event) => {
        if (version === conversationVersion) {
          widget.handleEvent(event);
          if (event.event === "message.delta" || event.event === "message.done") {
            const mid = event.data.messageId;
            if (typeof mid === "string") {
              const b = assistantMessagesById.get(mid) ?? null;
              if (b !== null) lastAssistantBubble = b;
            }
          }
        }
      };
      // A session evicted/expired on the worker makes /v1/chat 404. Recover once,
      // transparently: mint a fresh authenticated session and retry the send a single
      // time. There is no persisted session id to clear (sessionId is in-memory only).
      let recovered = false;
      const trySend = async (currentSessionId) => {
        const body = { ...options.clientAssertion.body, sessionId: currentSessionId, message };
        const assertion = await options.signRequest({
          path: "/v1/chat",
          body,
        });
        try {
          await sendAiCsChatMessage({ baseUrl: options.baseUrl }, assertion, {
            signal: controller.signal,
            onEvent: dispatchChatEvent,
          });
        } catch (sendError) {
          if (
            !recovered &&
            sendError instanceof AiCsApiError &&
            sendError.status === 404 &&
            !destroyed &&
            version === conversationVersion
          ) {
            recovered = true;
            const nextSessionId = await mintAuthenticatedSession(controller.signal);
            if (destroyed || version !== conversationVersion) return;
            if (typeof nextSessionId !== "string" || nextSessionId === "") {
              throw sendError;
            }
            sessionId = nextSessionId;
            const retryBody = { ...options.clientAssertion.body, sessionId: nextSessionId, message };
            const retryAssertion = await options.signRequest({
              path: "/v1/chat",
              body: retryBody,
            });
            await sendAiCsChatMessage({ baseUrl: options.baseUrl }, retryAssertion, {
              signal: controller.signal,
              onEvent: dispatchChatEvent,
            });
          } else {
            throw sendError;
          }
        }
      };
      await trySend(sessionId);
    } catch (error) {
      if (version === conversationVersion && !isAbortError(error)) {
        // Mark the last partial assistant bubble as failed.
        if (lastAssistantBubble !== null) {
          markBubbleFailed(lastAssistantBubble);
        }
        showBanner(classifyChatError(error, copy), "error", {
          actionLabel: copy.retry,
          onAction: () => { void widget.retry(); },
        });
        options.callbacks?.onError?.(toError(error));
      }
    } finally {
      if (chatController === controller) chatController = null;
      if (version === conversationVersion) {
        transcript?.setAttribute("aria-busy", "false");
        hidePending();
        sending = false;
        streamingCount = 0;
        updateStreamingUI();
        updateSendState();
      }
    }
  }

  const widget = {
    async open() {
      if (destroyed) throw new Error("Widget destroyed");
      if (openState) return;
      ensureRoot();
      buildPanel();
      openState = true;
      launcher?.setAttribute("aria-expanded", "true");
      if (launcher !== null) launcher.hidden = true;
      lastFocusedExternal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inertedSiblings = applyInertToSiblings(panel);
      keydownHandler = (event) => {
        if (!openState || panel === null) return;
        if (event.key === "Escape") {
          if (overflowMenu !== null && !overflowMenu.hidden && overflowButton !== null) {
            event.preventDefault();
            closeOverflowMenu();
            overflowButton.focus();
            return;
          }
          event.preventDefault();
          widget.close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusables = Array.from(panel.querySelectorAll(AI_CS_FOCUSABLE)).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && el.closest(AI_CS_FOCUS_BLOCKED) === null);
        if (focusables.length === 0) { event.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !panel.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !panel.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", keydownHandler, true);
      documentClickHandler = (event) => {
        if (overflowMenu === null || overflowButton === null) return;
        if (overflowMenu.hidden) return;
        const target = event.target;
        if (target instanceof Node && (overflowMenu.contains(target) || overflowButton === target || overflowButton.contains(target))) return;
        closeOverflowMenu();
      };
      document.addEventListener("click", documentClickHandler, true);
      onlineHandler = () => {
        if (offlineBannerActive) {
          offlineBannerActive = false;
          clearBanner();
          updateSendState();
        }
      };
      offlineHandler = () => {
        offlineBannerActive = true;
        showBanner(copy.offline, "error");
        updateSendState();
      };
      window.addEventListener("online", onlineHandler);
      window.addEventListener("offline", offlineHandler);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        offlineHandler();
      }
      if (composerInput !== null && isMobileViewport()) {
        composerFocusHandler = () => {
          if (composerInput !== null && typeof composerInput.scrollIntoView === "function") {
            const behavior = prefersReducedMotion() ? "auto" : "smooth";
            composerInput.scrollIntoView({ block: "end", behavior });
          }
        };
        composerInput.addEventListener("focus", composerFocusHandler);
      }
      if (typeof window !== "undefined" && window.visualViewport !== undefined && window.visualViewport !== null) {
        visualViewportHandler = () => {
          if (stickBottom && transcript !== null) {
            transcript.scrollTop = transcript.scrollHeight;
          }
        };
        window.visualViewport.addEventListener("resize", visualViewportHandler);
        window.visualViewport.addEventListener("scroll", visualViewportHandler);
      }
      resizeHandler = () => {
        if (panel === null) return;
        const isMobile = isMobileViewport();
        panel.setAttribute("aria-modal", isMobile ? "true" : "false");
        releaseInert(inertedSiblings);
        inertedSiblings = applyInertToSiblings(panel);
      };
      if (typeof window !== "undefined") {
        window.addEventListener("resize", resizeHandler);
      }
      if (root !== null) {
        getSharedLiveWidgetRoots().add(root);
      }
      if (sessionId === null) {
        try {
          sessionId = await mintAuthenticatedSession();
          sessionReady = true;
          // Swap loading → empty state now that session is ready.
          if (transcript !== null && transcript.querySelector("[data-aics-loading]") !== null) {
            renderEmptyState();
          }
        } catch (error) {
          if (!isAbortError(error)) {
            sessionReady = true;
            if (transcript !== null && transcript.querySelector("[data-aics-loading]") !== null) {
              renderEmptyState();
            }
            showBanner(toError(error).message, "error");
            options.callbacks?.onError?.(toError(error));
          }
        }
      } else {
        sessionReady = true;
        if (transcript !== null && transcript.querySelector("[data-aics-loading]") !== null) {
          renderEmptyState();
        }
      }
      updateSendState();
      composerInput?.focus();
      options.callbacks?.onOpen?.();
    },
    close() {
      openState = false;
      chatController?.abort();
      chatController = null;
      sending = false;
      escalating = false;
      clearToastTimer();
      clearBannerTimer();
      if (keydownHandler !== null) {
        document.removeEventListener("keydown", keydownHandler, true);
        keydownHandler = null;
      }
      if (documentClickHandler !== null) {
        document.removeEventListener("click", documentClickHandler, true);
        documentClickHandler = null;
      }
      if (onlineHandler !== null) {
        window.removeEventListener("online", onlineHandler);
        onlineHandler = null;
      }
      if (offlineHandler !== null) {
        window.removeEventListener("offline", offlineHandler);
        offlineHandler = null;
      }
      if (composerFocusHandler !== null && composerInput !== null) {
        composerInput.removeEventListener("focus", composerFocusHandler);
        composerFocusHandler = null;
      }
      if (visualViewportHandler !== null && typeof window !== "undefined" && window.visualViewport !== undefined && window.visualViewport !== null) {
        window.visualViewport.removeEventListener("resize", visualViewportHandler);
        window.visualViewport.removeEventListener("scroll", visualViewportHandler);
        visualViewportHandler = null;
      }
      if (resizeHandler !== null && typeof window !== "undefined") {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
      }
      if (motionMq !== null && motionHandler !== null) {
        if (typeof motionMq.removeEventListener === "function") {
          motionMq.removeEventListener("change", motionHandler);
        } else if (typeof motionMq.removeListener === "function") {
          motionMq.removeListener(motionHandler);
        }
        motionMq = null;
        motionHandler = null;
      }
      if (root !== null) {
        getSharedLiveWidgetRoots().delete(root);
      }
      offlineBannerActive = false;
      releaseInert(inertedSiblings);
      inertedSiblings = [];
      panel?.remove();
      panel = null;
      transcript = null;
      liveRegion = null;
      unreadLiveRegion = null;
      composer = null;
      composerInput = null;
      sendButton = null;
      stopHost = null;
      stopButton = null;
      header = null;
      navigationStrip = null;
      bannerHost = null;
      toastHost = null;
      overflowMenu = null;
      overflowButton = null;
      pendingTyping = null;
      escalateHost = null;
      escalateButton = null;
      jumpButton = null;
      loadingEl = null;
      assistantBubbleCount = 0;
      hasErrorBanner = false;
      stickBottom = true;
      sessionReady = false;
      assistantMessagesById.clear();
      completedAssistantMessageIds.clear();
      retriedMessageIds.clear();
      streamingCount = 0;
      unreadCount = 0;
      launcher?.setAttribute("aria-expanded", "false");
      if (launcher !== null) launcher.hidden = false;
      if (!destroyed) {
        if (lastFocusedExternal !== null && document.body.contains(lastFocusedExternal)) {
          lastFocusedExternal.focus();
        } else {
          launcher?.focus();
        }
      }
      options.callbacks?.onClose?.();
    },
    destroy() {
      destroyed = true;
      chatController?.abort();
      clearToastTimer();
      clearBannerTimer();
      widget.close();
      root?.remove();
      root = null;
      launcher = null;
    },
    isOpen() { return openState; },
    getSessionId() { return sessionId; },
    async escalate(detail = {}) {
      if (sessionId === null || destroyed || escalating) return null;
      escalating = true;
      closeOverflowMenu();
      try {
        const body = { ...detail, ...options.clientAssertion.body, sessionId };
        const assertion = await options.signRequest({ path: "/v1/escalations", body });
        const receipt = await requestAiCsEscalation({ baseUrl: options.baseUrl }, assertion);
        showBanner(copy.escalated.replace("{status}", receipt.status), "ok");
        const eventData = { escalationId: receipt.escalationId };
        if (typeof detail.reason === "string") eventData.reason = detail.reason;
        widget.handleEvent({ event: "support.escalation.requested", data: eventData });
        options.callbacks?.onEscalate?.(receipt);
        return receipt;
      } catch (error) {
        showBanner(toError(error).message, "error");
        options.callbacks?.onError?.(toError(error));
        return null;
      } finally {
        escalating = false;
      }
    },
    stopGenerating() {
      if (chatController !== null) {
        chatController.abort();
        chatController = null;
      }
      streamingCount = 0;
      sending = false;
      hidePending();
      updateStreamingUI();
      updateSendState();
      if (transcript !== null) {
        transcript.setAttribute("aria-busy", "false");
        transcript.setAttribute("aria-live", "polite");
      }
      // Mark any in-progress assistant bubbles as done (remove streaming attr).
      if (transcript !== null) {
        for (const el of Array.from(transcript.querySelectorAll("[data-aics-streaming]"))) {
          el.removeAttribute("data-aics-streaming");
        }
      }
      assistantMessagesById.clear();
    },
    async retry() {
      if (lastUserMessage === "" || composerInput === null) return;
      if (transcript !== null) {
        const bubbles = transcript.querySelectorAll('[data-aics-bubble][data-aics-role="assistant"]');
        const last = bubbles[bubbles.length - 1];
        if (last instanceof HTMLElement) {
          const mid = last.dataset.aicsMessageId;
          const isCompleted = typeof mid === "string" && completedAssistantMessageIds.has(mid);
          if (!isCompleted) {
            if (typeof mid === "string") {
              assistantMessagesById.delete(mid);
              retriedMessageIds.add(mid);
            }
            // Remove the failed bubble's inline retry row so it is not orphaned.
            const retryRow = last.nextElementSibling;
            if (retryRow !== null && retryRow.hasAttribute("data-aics-retry-row")) {
              retryRow.remove();
            }
            last.remove();
            if (assistantBubbleCount > 0) assistantBubbleCount -= 1;
            if (streamingCount > 0) {
              streamingCount -= 1;
              if (streamingCount === 0 && transcript !== null) {
                transcript.setAttribute("aria-live", "polite");
              }
            }
          }
        }
      }
      composerInput.value = lastUserMessage;
      await sendCurrentMessage();
      composerInput?.focus();
    },
    handleEvent(event) {
      if (destroyed) return;
      if (event.event === "message.delta") {
        let message = assistantMessagesById.get(event.data.messageId) ?? null;
        const isNew = message === null && !completedAssistantMessageIds.has(event.data.messageId);
        if (isNew) {
          if (pendingTyping !== null) {
            message = convertPendingToBubble(event.data.messageId);
          } else {
            message = appendBubble("assistant", "");
            if (message !== null) {
              message.dataset.aicsMessageId = event.data.messageId;
              assistantMessagesById.set(event.data.messageId, message);
            }
          }
          if (message !== null) {
            streamingCount += 1;
            updateStreamingUI();
            if (streamingCount === 1 && transcript !== null) {
              transcript.setAttribute("aria-live", "off");
              transcript.setAttribute("aria-busy", "true");
            }
          }
        }
        if (message !== null) {
          message.dataset.aicsStreaming = "";
          const body = message.firstChild;
          if (body !== null) {
            body.textContent = (body.textContent ?? "") + event.data.delta;
          }
        }
      } else if (event.event === "message.done") {
        const bubble = assistantMessagesById.get(event.data.messageId) ?? null;
        if (bubble !== null) bubble.removeAttribute("data-aics-streaming");
        const wasTracked = assistantMessagesById.has(event.data.messageId);
        completedAssistantMessageIds.add(event.data.messageId);
        assistantMessagesById.delete(event.data.messageId);
        if (wasTracked && streamingCount > 0) {
          streamingCount -= 1;
          updateStreamingUI();
          if (streamingCount === 0 && transcript !== null) {
            transcript.setAttribute("aria-live", "polite");
            transcript.setAttribute("aria-busy", "false");
          }
        }
        if (liveRegion !== null) {
          liveRegion.textContent = copy.announceDone;
        }
      } else if (event.event === "source") {
        const messageId = typeof event.data.messageId === "string" ? event.data.messageId : null;
        let target = null;
        if (messageId !== null) {
          target = assistantMessagesById.get(messageId) ?? null;
          if (target === null) {
            const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
              ? CSS.escape(messageId)
              : messageId.replace(/"/g, '\\"');
            target = transcript?.querySelector('[data-aics-message-id="' + escapedId + '"]') ?? null;
          }
        }
        if (target === null) {
          const iter = assistantMessagesById.values();
          let last = null;
          let next = iter.next();
          while (!next.done) { last = next.value; next = iter.next(); }
          target = last;
        }
        appendSources(target, event.data.source);
      } else if (event.event === "navigation.suggestion") {
        renderNavigation(event.data.target);
      } else if (event.event === "workflow.step") {
        appendWorkflow(event.data.step);
      } else if (event.event === "support.escalation.requested") {
        if (composer !== null) {
          composer.hidden = true;
          composer.setAttribute("aria-hidden", "true");
        }
        if (escalateHost !== null) {
          escalateHost.hidden = true;
        }
      }
      options.callbacks?.onEvent?.(event);
    },
  };
  return widget;
}

async function postJson(config, path, body, extraHeaders, signal) {
  const response = await post(config, path, body, extraHeaders, signal);
  const text = await response.text();
  const json = parseJsonOrNull(text);
  if (!response.ok) throw new AiCsApiError(errorMessage(json, response.statusText), response.status);
  return json;
}

function post(config, path, body, extraHeaders, signal) {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (fetchFn === undefined) throw new Error("No fetch implementation available");
  const headers = { "content-type": "application/json" };
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
  const init = { method: "POST", headers, body: JSON.stringify(body) };
  if (signal !== undefined) init.signal = signal;
  return fetchFn(config.baseUrl.replace(/\/+$/, "") + path, init);
}

function parseJsonOrNull(text) {
  if (text.trim() === "") return null;
  try { return JSON.parse(text); } catch { return null; }
}

function errorMessage(value, fallback) {
  if (isRecord(value)) {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }
  return fallback === "" ? "AI-CS request failed" : fallback;
}

function isAiCsSseEvent(value) {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) return false;
  const data = value.data;
  switch (value.event) {
    case "source": return isRecord(data.source);
    case "navigation.suggestion": return isRecord(data.target);
    case "workflow.step": return isRecord(data.step);
    case "message.delta": return typeof data.messageId === "string" && typeof data.delta === "string";
    case "message.done": return typeof data.messageId === "string";
    default: return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// A snake_case/identifier-looking string is a machine error code, not human copy.
function looksLikeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value.trim());
}

// Map a failed /v1/chat send to a plain, sensible banner message. Status-class wins
// over the raw server text so the banner never shows a blank line, a bare HTTP
// status word, or a machine error code. Unknown failures keep any genuinely human
// server message and otherwise fall back to a generic line.
function classifyChatError(error, copy) {
  const status = error instanceof AiCsApiError ? error.status : 0;
  if (status === 401) return copy.errorAuth;
  if (status === 403) return copy.errorForbidden;
  if (status === 429) return copy.errorRateLimited;
  if (status === 502 || status === 503 || status === 504) return copy.errorUnavailable;
  const raw = toError(error).message;
  if (raw.trim() === "" || looksLikeErrorCode(raw)) return copy.errorGeneric;
  return raw;
}

function isAbortError(error) {
  return isRecord(error) && error.name === "AbortError";
}

const productBrands = {
  camaudit: { id: "camaudit", accentColor: "#1f5a52", accentTextColor: "#ffffff", surfaceColor: "#fbfefd", textColor: "#071426" },
  capveri: { id: "capveri", accentColor: "#4f46e5", accentTextColor: "#ffffff", surfaceColor: "#fbfbff", textColor: "#141528" },
  lextract: { id: "lextract", accentColor: "#b45309", accentTextColor: "#ffffff", surfaceColor: "#fffdfa", textColor: "#1d1712" },
};

function resolveWidgetBrand(brand) {
  const override = brand ?? {};
  const key = (typeof override.id === "string" ? override.id : "").trim().toLowerCase();
  const base = productBrands[key] ?? { id: key === "" ? "ventora" : key, accentColor: "#0f172a", accentTextColor: "#ffffff", surfaceColor: "#f8fafc", textColor: "#0f172a" };
  return {
    id: override.id ?? base.id,
    accentColor: override.accentColor ?? base.accentColor,
    accentTextColor: override.accentTextColor ?? base.accentTextColor,
    surfaceColor: override.surfaceColor ?? base.surfaceColor,
    textColor: override.textColor ?? base.textColor,
  };
}

function resolveEscalationBookingUrl(productId, options) {
  const resolvedProductId = String(productId ?? "").trim() || resolveConfigAppId(options);
  const slug = String(resolvedProductId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return "https://cal.com/demo-team-" + (slug === "" ? "default" : slug) + "/15min";
}

function resolveConfigAppId(options) {
  const clientBody = options?.clientAssertion?.body;
  if (isRecord(clientBody) && typeof clientBody.appId === "string") {
    return clientBody.appId;
  }
  return "";
}

function resolveCopy(override) {
  const defaults = {
    title: "Support",
    subtitle: "We typically reply instantly",
    launcher: "Need help?",
    placeholder: "Ask a question…",
    send: "Send",
    close: "Close",
    overflowLabel: "More options",
    escalate: "Talk to a person",
    escalated: "Request queued ({status})",
    sources: "Sources",
    suggestions: "Suggested navigation",
    workflow: "Steps",
    messageLabel: "Message",
    transcriptLabel: "Conversation",
    typingLabel: "Assistant is typing",
    jumpLatest: "Jump to latest messages",
    newMessages: "{count} new",
    copy: "Copy",
    copied: "Copied",
    retry: "Retry",
    stopGenerating: "Stop generating",
    loading: "Loading…",
    thinking: "Thinking…",
    empty: "How can we help?",
    announceDone: "Assistant reply complete",
    escalateAvailable: "You can book a 15-minute call.",
    offline: "You're offline. Messages will send when you reconnect.",
    errorAuth: "Your session ended. Please refresh the page and try again.",
    errorForbidden: "We can't load chat here right now. Please try again later.",
    errorRateLimited: "Too many messages. Please wait a moment, then try again.",
    errorUnavailable: "Chat is unavailable right now. Please try again in a moment.",
    errorGeneric: "Something went wrong. Please try again.",
  };
  if (!isRecord(override)) return defaults;
  return { ...defaults, ...override };
}

let widgetSequence = 0;
function resolveWidgetIds(productId) {
  widgetSequence += 1;
  const base = String(productId ?? "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ventora";
  return {
    panel: "aics-" + base + "-panel-" + widgetSequence,
    title: "aics-" + base + "-title-" + widgetSequence,
    empty: "aics-" + base + "-empty-" + widgetSequence,
  };
}
`;

const hostedClientGlobalSuffix = String.raw`
const __VENTORA_AI_CS_MOUNT_KEY__ = "__ventoraAiCsWidget";
globalThis.AiCs = {
  init(config) {
    const existing = globalThis[__VENTORA_AI_CS_MOUNT_KEY__];
    if (existing !== undefined && existing !== null) {
      console.warn("AiCs.init: widget already mounted — returning existing instance");
      return existing;
    }
    const widget = createAiCsWidget(config);
    const originalDestroy = widget.destroy.bind(widget);
    widget.destroy = function() {
      globalThis[__VENTORA_AI_CS_MOUNT_KEY__] = undefined;
      originalDestroy();
    };
    globalThis[__VENTORA_AI_CS_MOUNT_KEY__] = widget;
    return widget;
  },
  createAiCsWidget,
  createAiCsSession,
  sendAiCsChatMessage,
  requestAiCsEscalation,
  AiCsApiError,
};
`;

const hostedClientExportsSuffix = String.raw`
export { AiCsApiError, createAiCsSession, createAiCsSseParser, createAiCsWidget, requestAiCsEscalation, sendAiCsChatMessage };
`;

const hostedClientCore = `${hostedClientCorePart1}${BACKTICK}${hostedClientCorePart2}${BACKTICK}${hostedClientCorePart3}`;

export const hostedClientModule = `${hostedClientCore}\n${hostedClientExportsSuffix}\n`;
export const hostedClientGlobalModule = `${hostedClientCore}\n${hostedClientGlobalSuffix}\n`;

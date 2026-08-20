import type { AiCsSessionRequest, AiCsSseEvent } from "@ventora/ai-cs-contracts";
import type * as React from "react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type AiCsApiConfig, AiCsApiError } from "../index.js";
import { renderMarkdown } from "./markdown.js";
import { type AiCsBrand, ensureAiCsStyles, resolveAiCsBrand } from "./styles.js";
import { type AiCsTranscriptMessage, useAiCsWidget } from "./useAiCsWidget.js";

// A snake_case/identifier-looking string is a machine error code, not human copy.
function looksLikeErrorCode(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value.trim());
}

// Map a failed /v1/chat send to a plain, sensible banner message.
function classifyChatError(error: unknown, copy: AiCsWidgetCopy): string {
  const status = error instanceof AiCsApiError ? error.status : 0;
  if (status === 401) return copy.errorAuth;
  if (status === 403) return copy.errorForbidden;
  if (status === 429) return copy.errorRateLimited;
  if (status === 502 || status === 503 || status === 504) return copy.errorUnavailable;
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw.trim() === "" || looksLikeErrorCode(raw)) return copy.errorGeneric;
  return raw;
}

// Module-scoped refcount + live panel registry so multiple <AiCsWidget>
// instances on the same page coordinate sibling-inert state. Uses a unique
// Symbol so it does not collide with the worker hosted-client's own registry
// (which keys off the string "__ventoraAiCsInertRefs").
const AICS_REACT_INERT_REFS = Symbol.for("aics.react.inert.refs");
const AICS_REACT_LIVE_PANELS = Symbol.for("aics.react.live.panels");

// Singleton guard: tracks all mounted <AiCsWidget> instance roots so a second
// concurrent mount can detect the collision and bail out.
const AICS_REACT_MOUNTED = Symbol.for("aics.react.mounted");
type GlobalWithMounted = typeof globalThis & {
  [AICS_REACT_MOUNTED]?: Set<object>;
};
function getMountedSet(): Set<object> {
  const g = globalThis as GlobalWithMounted;
  let set = g[AICS_REACT_MOUNTED];
  if (set === undefined) {
    set = new Set<object>();
    g[AICS_REACT_MOUNTED] = set;
  }
  return set;
}

const MOBILE_BREAKPOINT = 640;

interface AicsInertRecord {
  refCount: number;
  originalInert: string | null;
  originalAriaHidden: string | null;
}

type GlobalWithInert = typeof globalThis & {
  [AICS_REACT_INERT_REFS]?: WeakMap<Element, AicsInertRecord>;
  [AICS_REACT_LIVE_PANELS]?: Set<Element>;
};

function getInertRefs(): WeakMap<Element, AicsInertRecord> {
  const g = globalThis as GlobalWithInert;
  let map = g[AICS_REACT_INERT_REFS];
  if (map === undefined) {
    map = new WeakMap<Element, AicsInertRecord>();
    g[AICS_REACT_INERT_REFS] = map;
  }
  return map;
}

function getLivePanels(): Set<Element> {
  const g = globalThis as GlobalWithInert;
  let set = g[AICS_REACT_LIVE_PANELS];
  if (set === undefined) {
    set = new Set<Element>();
    g[AICS_REACT_LIVE_PANELS] = set;
  }
  return set;
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
}

function applyInertToSiblings(panel: Element): Element[] {
  if (!isMobileViewport()) return [];
  const refs = getInertRefs();
  const livePanels = getLivePanels();
  const inerted: Element[] = [];
  const siblings = Array.from(document.body.children).filter((node) => {
    if (node.contains(panel)) return false;
    // Skip other live AiCsWidget panels that happen to be body siblings.
    for (const live of livePanels) {
      /* v8 ignore next */
      if (node === live || node.contains(live)) return false;
    }
    return true;
  });
  for (const sibling of siblings) {
    const existing = refs.get(sibling);
    if (existing === undefined) {
      const record: AicsInertRecord = {
        refCount: 1,
        originalInert: sibling.getAttribute("inert"),
        originalAriaHidden: sibling.getAttribute("aria-hidden"),
      };
      refs.set(sibling, record);
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    } else {
      /* v8 ignore next 2 */
      existing.refCount += 1;
    }
    inerted.push(sibling);
  }
  return inerted;
}

function releaseInertFromSiblings(siblings: Element[]): void {
  const refs = getInertRefs();
  for (const sibling of siblings) {
    const record = refs.get(sibling);
    if (record === undefined) continue;
    record.refCount -= 1;
    if (record.refCount <= 0) {
      refs.delete(sibling);
      if (record.originalInert === null) {
        sibling.removeAttribute("inert");
      } else {
        sibling.setAttribute("inert", record.originalInert);
      }
      if (record.originalAriaHidden === null) {
        sibling.removeAttribute("aria-hidden");
      } else {
        sibling.setAttribute("aria-hidden", record.originalAriaHidden);
      }
    }
  }
}

export interface AiCsWidgetCopy {
  title: string;
  subtitle: string;
  launcher: string;
  placeholder: string;
  send: string;
  close: string;
  newChat: string;
  escalate: string;
  escalateAvailable: string;
  escalationQueued: string;
  empty: string;
  emptyBody: string;
  emptySuggestions: string[];
  workflow: string;
  suggestions: string;
  messageLabel: string;
  transcriptLabel: string;
  sources: string;
  announceDone: string;
  jumpLatest: string;
  newMessages: string;
  overflowLabel: string;
  errorGeneric: string;
  errorNetwork: string;
  errorSessionExpired: string;
  errorAuth: string;
  errorForbidden: string;
  errorRateLimited: string;
  errorUnavailable: string;
  retry: string;
  stopGenerating: string;
  loading: string;
}

/**
 * Stable sentinel that marks an empty-state suggestion as the escalation booking
 * action. Place this value in `copy.emptySuggestions` instead of
 * relying on a suggestion's display string matching `copy.escalate` — that
 * coupling silently breaks the escalation wiring whenever `copy.escalate` is
 * customized. A suggestion equal to this sentinel renders with `copy.escalate`
 * text and is wired to the escalation handler.
 */
export const AI_CS_ESCALATE_SUGGESTION = "\0ai-cs:escalate";

function resolveEscalationBookingUrl(productId: string | undefined): string {
  const slug = (productId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `https://cal.com/demo-team-${slug === "" ? "default" : slug}/15min`;
}

function openEscalationBookingUrl(url: string): void {
  if (typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

const DEFAULT_COPY: AiCsWidgetCopy = {
  title: "Support",
  subtitle: "Replies in seconds",
  launcher: "Need help?",
  placeholder: "Ask a question…",
  send: "Send",
  close: "Close",
  newChat: "New chat",
  escalate: "Talk to a person",
  escalateAvailable: "You can book a 15-minute call.",
  escalationQueued: "Request queued ({status})",
  empty: "How can we help?",
  emptyBody: "Ask about features, billing, or getting things done.",
  emptySuggestions: ["How do I get started?", AI_CS_ESCALATE_SUGGESTION],
  workflow: "Steps",
  suggestions: "Suggested navigation",
  messageLabel: "Message",
  transcriptLabel: "Conversation",
  sources: "Sources",
  announceDone: "Assistant reply complete",
  jumpLatest: "Jump to latest messages",
  newMessages: "{count} new",
  overflowLabel: "More options",
  errorGeneric: "Something went wrong. Please try again.",
  errorNetwork: "You appear to be offline.",
  errorSessionExpired: "Session expired. Please refresh.",
  errorAuth: "Your session ended. Please refresh the page and try again.",
  errorForbidden: "We can't load chat here right now. Please try again later.",
  errorRateLimited: "Too many messages. Please wait a moment, then try again.",
  errorUnavailable: "Chat is unavailable right now. Please try again in a moment.",
  retry: "Retry",
  stopGenerating: "Stop generating",
  loading: "Loading…",
};

export interface AiCsWidgetProps {
  /**
   * AI-CS API configuration. Callers MUST supply `signRequest` (the host
   * application's backend mints HMAC assertions) OR `clientAssertion`.
   * The React component itself never holds the HMAC secret.
   *
   * Memoize this object across renders to keep the hook stable.
   */
  api: AiCsApiConfig;
  session: AiCsSessionRequest;
  brand?: AiCsBrand;
  position?: "bottom-right" | "bottom-left";
  locale?: string;
  copy?: Partial<AiCsWidgetCopy>;
  defaultOpen?: boolean;
  onEvent?: (event: AiCsSseEvent) => void;
  onError?: (error: Error) => void;
  onNavigate?: (target: { url: string; path: string; label: string }) => void;
}

// Decorative inline icons. All are aria-hidden — the surrounding button/label
// carries the accessible name, so the SVG must never be announced. Stroke uses
// currentColor so each icon inherits the brand-driven text color of its host.
function ChatIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8 8.38 8.38 0 0 1 8.5-8.5A8.5 8.5 0 0 1 21 11.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M5 12h13M12 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CalendarIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3 9h18M8 2.5v4M16 2.5v4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const FOCUSABLE_SELECTOR =
  "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function isSafeLinkUrl(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  const lower = value.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}

function isUsefulNavigationTarget(target: { label: string; path: string }): boolean {
  const path = normalizeNavigationPath(target.path);
  if (path === "") return false;
  if (target.path.startsWith("/") && (path === "/" || path === "/home")) return false;
  const label = target.label.trim().toLowerCase();
  if (label === "" || label === "home" || label.includes("positioning")) return false;
  return true;
}

function normalizeNavigationPath(value: string): string {
  try {
    const path = new URL(value, "https://app.local").pathname.replace(/\/+$/, "");
    return path === "" ? "/" : path.toLowerCase();
  } catch {
    return "";
  }
}

// Public wrapper — handles the singleton guard before any hooks are called in
// the inner implementation. Renders nothing (and warns once) when a second
// concurrent <AiCsWidget> is detected via the DOM or the mounted-set registry.
export function AiCsWidget(props: AiCsWidgetProps): React.ReactElement | null {
  // Stable per-instance token allocated once on first render.
  const tokenRef = useRef<object | null>(null);
  if (tokenRef.current === null) {
    tokenRef.current = {};
  }
  // isDuplicate starts true if the DOM already has a root AND we haven't
  // registered yet; we flip it false on the first mount and restore it on
  // unmount so that re-mount of the SAME instance works correctly.
  const [isDuplicate, setIsDuplicate] = useState(() => {
    /* v8 ignore next 2 */
    if (typeof document === "undefined") return false;
    const mounted = getMountedSet();
    // If the set is empty (no other instance registered), we're first.
    return mounted.size > 0;
  });

  useEffect(() => {
    const mounted = getMountedSet();
    if (mounted.size > 0) {
      // Another instance is already active — stay as duplicate.
      console.warn(
        "[AiCsWidget] A second <AiCsWidget> instance was mounted. Only the first instance is active. Remove the duplicate to suppress this warning.",
      );
      setIsDuplicate(true);
      return;
    }
    // Read from the ref inside the effect so the closure captures only the
    // stable ref object, not the derived `token` variable. This keeps the
    // dependency array empty while satisfying exhaustive-deps.
    // tokenRef.current is always initialised during render before effects run.
    const instanceToken = tokenRef.current as object;
    mounted.add(instanceToken);
    setIsDuplicate(false);
    return () => {
      mounted.delete(instanceToken);
    };
  }, []);

  if (isDuplicate) {
    return null;
  }

  return <AiCsWidgetInner {...props} />;
}

function AiCsWidgetInner(props: AiCsWidgetProps): React.ReactElement {
  const brand = resolveAiCsBrand(props.brand);
  const copy: AiCsWidgetCopy = { ...DEFAULT_COPY, ...(props.copy ?? {}) };
  const escalationBookingUrl = resolveEscalationBookingUrl(props.brand?.id ?? props.session.appId);
  const position = props.position === "bottom-left" ? "bottom-left" : "bottom-right";
  const locale = props.locale ?? "en";
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  const [isModalViewport, setIsModalViewport] = useState(() => isMobileViewport());
  const titleId = useId();
  const panelId = useId();
  const announceId = useId();
  const unreadRegionId = useId();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const stopButtonHadFocusRef = useRef(false);
  const previouslyOpenRef = useRef(false);
  const openRef = useRef(false);
  const inertedSiblingsRef = useRef<Element[]>([]);
  const [draft, setDraft] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);

  // Detect RTL
  const isRtl =
    typeof document !== "undefined" &&
    (document.documentElement.dir === "rtl" ||
      document.body?.dir === "rtl" ||
      (typeof window !== "undefined" &&
        typeof window.getComputedStyle === "function" &&
        (() => {
          try {
            return window.getComputedStyle(document.documentElement).direction === "rtl";
          } catch {
            return false;
          }
        })()));

  // Track whether the transcript is currently scrolled to (near) the bottom so
  // the hook can decide whether an incoming message is "seen" (no unread bump).
  const atBottomRef = useRef(true);
  const openRefForViewing = useRef(false);
  openRefForViewing.current = open;
  const isViewingLatest = useCallback((): boolean => {
    if (!openRefForViewing.current) return false;
    const el = transcriptRef.current;
    if (el === null) return openRefForViewing.current;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  const hookOptions: Parameters<typeof useAiCsWidget>[0] = {
    api: props.api,
    session: props.session,
    onError: props.onError,
    onEvent: (event) => {
      props.onEvent?.(event);
      if (event.event === "message.done") {
        setAnnouncement(copy.announceDone);
      }
    },
    isViewingLatest,
  };
  if (props.session.currentPath !== undefined) {
    hookOptions.currentPath = props.session.currentPath;
  }
  const state = useAiCsWidget(hookOptions);

  // Reset error dismissal when a new error comes in.
  useEffect(() => {
    if (state.error !== null) {
      setErrorDismissed(false);
    }
  }, [state.error]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      ensureAiCsStyles(document);
    }
  }, []);

  // Reduced-motion: set data attribute and subscribe to changes.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof window === "undefined" || typeof window.matchMedia !== "function")
      return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (matches: boolean): void => {
      if (matches) {
        root.dataset.aicsReducedMotion = "";
      } else {
        delete root.dataset.aicsReducedMotion;
      }
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent): void => {
      apply(e.matches);
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => {
        mq.removeEventListener("change", handler);
      };
    }
    return undefined;
  }, []);

  // Stop-button focus preservation: when streaming ends and the stop button
  // had focus, move focus to the composer before the stop button unmounts.
  const prevIsStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = state.isStreaming;
    if (wasStreaming && !state.isStreaming && stopButtonHadFocusRef.current) {
      stopButtonHadFocusRef.current = false;
      composerRef.current?.focus();
    }
  }, [state.isStreaming]);

  // Jump-to-latest: show when unread > 0 (user has scrolled up), reset on reaching bottom.
  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    atBottomRef.current = atBottom;
    if (atBottom) {
      setShowJump(false);
      state.resetUnread();
    } else if (state.unreadCount > 0) {
      setShowJump(true);
    }
  }, [state]);

  // V-CS-1 auto-scroll: when the transcript grows (new message or streamed
  // delta), keep the view pinned to the newest content — but only if the user
  // was already at the bottom. If they scrolled up to read history, leave their
  // position untouched.
  const lastScrolledLengthRef = useRef(0);
  const transcriptSignature = state.messages.reduce(
    (total, message) => total + message.content.length,
    state.messages.length,
  );
  useEffect(() => {
    const el = transcriptRef.current;
    if (el === null) return;
    if (transcriptSignature === lastScrolledLengthRef.current) return;
    lastScrolledLengthRef.current = transcriptSignature;
    if (atBottomRef.current) {
      // Pin to the newest content. Scroll positioning is cosmetic and the
      // host's scroll accessors can be read-only or unimplemented (e.g. jsdom),
      // so this is strictly best-effort and never allowed to surface as an error.
      try {
        el.scrollTo({ top: el.scrollHeight });
        /* v8 ignore next 3 */
      } catch {
        /* best-effort: ignore environments without a working scrollTo */
      }
    }
  }, [transcriptSignature]);

  useEffect(() => {
    if (state.unreadCount > 0) {
      const el = transcriptRef.current;
      if (el === null) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      if (!atBottom) setShowJump(true);
    }
  }, [state.unreadCount]);

  // Open transition: capture focus target, focus composer, kick off session.
  useEffect(() => {
    if (open && !previouslyOpenRef.current) {
      /* v8 ignore next */
      lastFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Eager prefetch of the session on open. This is the only ensureSession
      // caller without its own error handling, so the catch reports the
      // failure — rendering the error banner instead of an endless loading
      // state — and swallows the rejection.
      state.ensureSession().catch((err: unknown) => {
        state.reportError(err);
      });
      // Defer focus until React commits the panel into the DOM; the
      // composer ref is set during that same commit. We re-read the ref
      // inside the timeout to avoid stale references after re-renders.
      const id = window.setTimeout(() => {
        /* v8 ignore next */
        composerRef.current?.focus();
      }, 0);
      previouslyOpenRef.current = true;
      return () => {
        window.clearTimeout(id);
      };
    }
    return undefined;
  }, [open, state]);

  // Modality lifecycle: inert siblings (mobile-only) + document-scoped keydown.
  // Registered when `open` flips true, torn down on close or unmount.
  useEffect(() => {
    openRef.current = open;
    if (!open) return undefined;
    const panel = panelRef.current;
    /* v8 ignore next */
    if (panel === null) return undefined;
    const livePanels = getLivePanels();
    livePanels.add(panel);

    // Apply inert only on mobile; re-apply on resize.
    const applyOrRelease = (): void => {
      setIsModalViewport(isMobileViewport());
      releaseInertFromSiblings(inertedSiblingsRef.current);
      inertedSiblingsRef.current = applyInertToSiblings(panel);
    };
    applyOrRelease();

    const resizeHandler = (): void => {
      applyOrRelease();
    };
    window.addEventListener("resize", resizeHandler);

    const handler = (event: globalThis.KeyboardEvent): void => {
      /* v8 ignore next */
      if (!openRef.current) return;
      if (event.defaultPrevented) return;
      const livePanel = panelRef.current;
      /* v8 ignore next */
      if (livePanel === null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !isMobileViewport()) return;
      const focusables = Array.from(
        livePanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      const insidePanel = active !== null && livePanel.contains(active);
      if (!insidePanel) {
        // Focus has escaped the panel — redirect it back in.
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey) {
        if (active === first) {
          event.preventDefault();
          /* v8 ignore next */
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      window.removeEventListener("resize", resizeHandler);
      releaseInertFromSiblings(inertedSiblingsRef.current);
      inertedSiblingsRef.current = [];
      livePanels.delete(panel);
    };
  }, [open]);

  // Close transition: restore focus once if previously open.
  useEffect(() => {
    if (!open && previouslyOpenRef.current) {
      previouslyOpenRef.current = false;
      const restore = lastFocusedRef.current;
      if (restore !== null && document.body.contains(restore)) {
        restore.focus();
      } else {
        launcherRef.current?.focus();
      }
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  // V-CS-8: start a fresh conversation. Clears the transcript and per-turn
  // state; the hook lazily creates a new session on the next send. Focus the
  // composer so the user can immediately type.
  const handleNewChat = useCallback(() => {
    state.reset();
    setDraft("");
    setShowJump(false);
    setErrorDismissed(false);
    atBottomRef.current = true;
    composerRef.current?.focus();
  }, [state]);

  const sendDraft = useCallback(() => {
    const value = draft.trim();
    if (value === "") return;
    setDraft("");
    // Clear stale navigation chips from a prior turn.
    state.clearTurn();
    void state.sendMessage(value);
  }, [draft, state]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      sendDraft();
    },
    [sendDraft],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendDraft();
      }
    },
    [sendDraft],
  );

  const handleDraftChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const handleNavigation = useCallback(
    (target: { url: string; path: string; label: string }) => {
      /* v8 ignore next */
      if (!isSafeLinkUrl(target.url)) return;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("aics:navigate", { detail: target }));
      }
      props.onNavigate?.(target);
    },
    [props],
  );

  const handleEscalate = useCallback(() => {
    openEscalationBookingUrl(escalationBookingUrl);
  }, [escalationBookingUrl]);

  const handleJumpToLatest = useCallback(() => {
    const el = transcriptRef.current;
    /* v8 ignore next */
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
    state.resetUnread();
  }, [state]);

  const handleStopGenerating = useCallback(() => {
    state.stopGenerating();
  }, [state]);

  const handleRetry = useCallback(() => {
    void state.retry().then(() => {
      composerRef.current?.focus();
    });
  }, [state]);

  const handleDismissError = useCallback(() => {
    setErrorDismissed(true);
  }, []);

  // Build the unread label for the jump pill.
  const unreadLabel =
    state.unreadCount > 0
      ? copy.newMessages.replace("{count}", String(state.unreadCount))
      : undefined;

  const showError = state.error !== null && !errorDismissed;

  return (
    <div
      ref={rootRef}
      data-aics-root=""
      data-aics-theme=""
      data-aics-position={position}
      lang={locale}
      dir={isRtl ? "rtl" : undefined}
      // biome-ignore lint/a11y/useSemanticElements: styling-scoped container must remain a div
      role="region"
      aria-label={copy.title}
      style={
        {
          ["--aics-accent" as string]: brand.accentColor,
          ["--aics-accent-text" as string]: brand.accentTextColor,
          ["--aics-surface" as string]: brand.surfaceColor,
          ["--aics-text" as string]: brand.textColor,
        } as React.CSSProperties
      }
    >
      <button
        ref={launcherRef}
        type="button"
        data-aics-launcher=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        hidden={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span data-aics-launcher-icon="" aria-hidden="true">
          <ChatIcon />
        </span>
        {copy.launcher}
      </button>
      <div
        data-aics-live=""
        id={announceId}
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </div>
      {/* Polite live region for unread count (jump pill). */}
      <div
        id={unreadRegionId}
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {showJump && unreadLabel !== undefined ? unreadLabel : ""}
      </div>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          data-aics-panel=""
          // biome-ignore lint/a11y/useSemanticElements: visible-by-default panel must not be a native <dialog>
          role="dialog"
          aria-modal={isModalViewport ? "true" : "false"}
          aria-labelledby={titleId}
        >
          <div data-aics-header="">
            <span data-aics-header-avatar="" aria-hidden="true">
              <ChatIcon />
            </span>
            <div data-aics-header-text="">
              <h2 data-aics-title="" id={titleId}>
                {copy.title}
              </h2>
              {copy.subtitle !== "" ? <div data-aics-subtitle="">{copy.subtitle}</div> : null}
            </div>
            {state.messages.length > 0 ? (
              <button
                type="button"
                data-aics-new-chat=""
                aria-label={copy.newChat}
                onClick={handleNewChat}
              >
                {copy.newChat}
              </button>
            ) : null}
            <button type="button" data-aics-close="" aria-label={copy.close} onClick={handleClose}>
              <CloseIcon />
            </button>
          </div>
          {state.escalation !== null ? (
            <div
              data-aics-banner=""
              data-aics-status="ok"
              // biome-ignore lint/a11y/useSemanticElements: banner must remain a div, not <output>
              role="status"
            >
              {copy.escalationQueued.replace("{status}", state.escalation.status)}
            </div>
          ) : null}
          {showError ? (
            <div data-aics-banner="" data-aics-status="error" role="alert">
              {classifyChatError(state.error, copy)}
              <button
                type="button"
                data-aics-banner-close=""
                aria-label={copy.close}
                onClick={handleDismissError}
                onKeyDown={(e) => {
                  if (e.key === "Escape") handleDismissError();
                }}
              >
                ×
              </button>
            </div>
          ) : null}
          <div
            ref={transcriptRef}
            data-aics-transcript=""
            role="log"
            aria-label={copy.transcriptLabel}
            aria-busy={state.isStreaming ? "true" : "false"}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: transcript must be keyboard-scrollable
            tabIndex={0}
            onScroll={handleTranscriptScroll}
          >
            {/* Gate on state.error (not showError): once bootstrap has failed,
                dismissing the banner must fall through to the empty state —
                its composer is the retry path — never back to this spinner. */}
            {!state.sessionReady && state.messages.length === 0 && state.error === null ? (
              <output data-aics-loading="" aria-label={copy.loading}>
                {copy.loading}
              </output>
            ) : state.messages.length === 0 ? (
              <div data-aics-empty="">
                <span data-aics-empty-icon="" aria-hidden="true">
                  <ChatIcon />
                </span>
                <p data-aics-empty-title="">{copy.empty}</p>
                <p data-aics-empty-body="">{copy.emptyBody}</p>
                {copy.emptySuggestions.length > 0 ? (
                  // biome-ignore lint/a11y/useSemanticElements: group role on div matches AI-SDR sibling pattern; fieldset carries unwanted default styling
                  <div data-aics-suggestions="" role="group" aria-label={copy.suggestions}>
                    {copy.emptySuggestions.map((label) => {
                      // Escalation is detected via a stable sentinel OR the
                      // resolved escalate label, so customizing `copy.escalate`
                      // never silently breaks the wiring.
                      const isEscalate =
                        label === AI_CS_ESCALATE_SUGGESTION || label === copy.escalate;
                      const display = label === AI_CS_ESCALATE_SUGGESTION ? copy.escalate : label;
                      return (
                        <button
                          key={label}
                          type="button"
                          data-aics-suggestion=""
                          onClick={
                            isEscalate
                              ? handleEscalate
                              : () => {
                                  state.clearTurn();
                                  void state.sendMessage(label);
                                }
                          }
                        >
                          {display}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              state.messages.map((message: AiCsTranscriptMessage) => (
                <div key={message.id}>
                  <div
                    data-aics-bubble=""
                    data-aics-bubble-in=""
                    data-aics-role={message.role}
                    data-aics-done={message.done ? "" : undefined}
                    data-aics-failed={message.failed ? "" : undefined}
                  >
                    {message.role === "assistant"
                      ? renderMarkdown(message.content)
                      : message.content}
                  </div>
                  {/* v8 ignore next */}
                  {message.failed ? (
                    /* v8 ignore next */
                    <div data-aics-retry-row="">
                      <button type="button" data-aics-retry-btn="" onClick={handleRetry}>
                        {copy.retry}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
            {state.error !== null &&
            !errorDismissed &&
            !state.messages.some((m) => m.failed) &&
            state.messages.some((m) => m.role === "user") ? (
              <div data-aics-retry-row="">
                <button type="button" data-aics-retry-btn="" onClick={handleRetry}>
                  {copy.retry}
                </button>
              </div>
            ) : null}
            {state.workflow.length > 0 ? (
              <details data-aics-workflow="" open>
                <summary aria-label={copy.workflow}>{copy.workflow}</summary>
                <ol>
                  {state.workflow.map((step) => (
                    <li key={step.id} data-aics-step={step.id} data-aics-status={step.status}>
                      {step.label}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {state.sources && state.sources.length > 0 ? (
              // biome-ignore lint/a11y/useSemanticElements: pill chip strip should not be a <fieldset>
              <div data-aics-sources="" role="group" aria-label={copy.sources}>
                {state.sources.map((source) =>
                  isSafeLinkUrl(source.url) ? (
                    <a
                      key={source.id}
                      data-aics-source=""
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.title}
                    </a>
                  ) : (
                    <span key={source.id} data-aics-source-plain="">
                      {source.title}
                    </span>
                  ),
                )}
              </div>
            ) : null}
          </div>
          {showJump ? (
            <button
              type="button"
              data-aics-jump=""
              aria-label={copy.jumpLatest}
              onClick={handleJumpToLatest}
            >
              {/* v8 ignore next */}
              {unreadLabel !== undefined ? unreadLabel : copy.jumpLatest}
            </button>
          ) : null}
          {state.navigation.length > 0 ? (
            <div
              data-aics-navigation=""
              // biome-ignore lint/a11y/useSemanticElements: chip strip should not be a <fieldset>
              role="group"
              aria-label={copy.suggestions}
            >
              {state.navigation
                .filter((target) => isSafeLinkUrl(target.path) && isUsefulNavigationTarget(target))
                .map((target) => (
                  <button
                    key={`${target.path}_${target.label}`}
                    type="button"
                    data-aics-navigation-chip=""
                    data-aics-path={target.path}
                    onClick={() =>
                      handleNavigation({
                        url: target.path,
                        path: target.path,
                        label: target.label,
                      })
                    }
                  >
                    {target.label}
                  </button>
                ))}
            </div>
          ) : null}
          {state.isStreaming ? (
            <div data-aics-stop-host="">
              <button
                type="button"
                data-aics-stop=""
                onClick={handleStopGenerating}
                onFocus={() => {
                  stopButtonHadFocusRef.current = true;
                }}
                onBlur={(e) => {
                  // Only clear on an intentional focus move to another element.
                  // An unmount blur (relatedTarget null) must keep the flag so the
                  // stream-end effect can redirect focus to the composer.
                  if (e.relatedTarget !== null) {
                    stopButtonHadFocusRef.current = false;
                  }
                }}
              >
                {copy.stopGenerating}
              </button>
            </div>
          ) : null}
          <form
            data-aics-composer=""
            onSubmit={handleSubmit}
            hidden={state.isStreaming || state.escalation !== null}
            aria-hidden={state.isStreaming || state.escalation !== null ? "true" : undefined}
          >
            <textarea
              ref={composerRef}
              aria-label={copy.messageLabel}
              placeholder={copy.placeholder}
              rows={2}
              value={draft}
              onChange={handleDraftChange}
              onKeyDown={handleKeyDown}
            />
            <button
              type="submit"
              data-aics-send=""
              aria-label={copy.send}
              disabled={state.sending || draft.trim() === ""}
              aria-disabled={state.sending || draft.trim() === ""}
            >
              <SendIcon />
            </button>
          </form>
          {state.messages.length > 0 && state.escalation === null ? (
            <div data-aics-escalate-host="">
              <button type="button" data-aics-escalate="" onClick={handleEscalate}>
                <CalendarIcon />
                {copy.escalate}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

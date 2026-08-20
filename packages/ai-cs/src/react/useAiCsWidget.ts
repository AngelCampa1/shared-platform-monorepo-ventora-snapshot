import type {
  AiCsAppContext,
  AiCsEscalationReceipt,
  AiCsNavigationTarget,
  AiCsSessionRequest,
  AiCsSseEvent,
  AiCsWorkflowStep,
} from "@ventora/ai-cs-contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type AiCsApiConfig,
  AiCsApiError,
  type AiCsSessionManager,
  createAiCsSessionManager,
  requestAiCsSupportEscalation,
  sendAiCsChatMessage,
} from "../index.js";

export interface AiCsTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  done: boolean;
  failed?: boolean;
}

export interface UseAiCsWidgetOptions {
  /**
   * AI-CS API configuration. Memoize across renders to avoid rebuilding
   * the session manager. If you cannot memoize, the hook still works but
   * may create a new manager on every render.
   */
  api: AiCsApiConfig;
  session: AiCsSessionRequest;
  onError?: ((error: Error) => void) | undefined;
  onEvent?: ((event: AiCsSseEvent) => void) | undefined;
  /**
   * The app path the user is currently viewing. Forwarded with every chat send
   * so the worker fetches per-screen context for the screen the user is
   * actually on, not the stale path captured at session creation. Read live on
   * each send, so updating it between turns changes what is sent.
   */
  currentPath?: string | undefined;
  /**
   * Predicate the consumer supplies to report whether the transcript's newest
   * content is currently visible (panel open AND scrolled to the bottom). When
   * it returns `true`, incoming assistant messages do NOT bump `unreadCount` —
   * the user is already seeing them. When omitted, every new message counts.
   */
  isViewingLatest?: (() => boolean) | undefined;
}

export interface UseAiCsWidgetResult {
  messages: AiCsTranscriptMessage[];
  navigation: AiCsNavigationTarget[];
  workflow: AiCsWorkflowStep[];
  sources: AiCsAppContext["sources"];
  escalation: AiCsEscalationReceipt | null;
  error: Error | null;
  sending: boolean;
  /** True while at least one assistant message is being streamed. */
  isStreaming: boolean;
  sessionId: string | null;
  /** True once a session has been successfully established. */
  sessionReady: boolean;
  /** Count of messages received since the user last scrolled to the bottom. */
  unreadCount: number;
  ensureSession(): Promise<string>;
  /**
   * Record an error (sets `error`, fires onError; AbortErrors are ignored).
   * For callers that invoke ensureSession outside sendMessage/escalate — e.g.
   * an eager open-time prefetch — so the failure surfaces in the UI.
   */
  reportError(raw: unknown): void;
  sendMessage(content: string): Promise<void>;
  retry(): Promise<void>;
  stopGenerating(): void;
  escalate(detail?: { reason?: string; message?: string }): Promise<AiCsEscalationReceipt | null>;
  reset(): void;
  /** Clear per-turn state (navigation chips, workflow steps, sources). */
  clearTurn(): void;
  /** Reset unread count (call when user scrolls to bottom). */
  resetUnread(): void;
}

export function useAiCsWidget(options: UseAiCsWidgetOptions): UseAiCsWidgetResult {
  const manager = useMemo<AiCsSessionManager>(
    () => createAiCsSessionManager(options.api, options.session),
    [options.api, options.session],
  );
  const [messages, setMessages] = useState<AiCsTranscriptMessage[]>([]);
  const [navigation, setNavigation] = useState<AiCsNavigationTarget[]>([]);
  const [workflow, setWorkflow] = useState<AiCsWorkflowStep[]>([]);
  const [sources, setSources] = useState<AiCsAppContext["sources"]>(undefined);
  const [escalation, setEscalation] = useState<AiCsEscalationReceipt | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const inflightIdsRef = useRef<Set<string>>(new Set());
  const versionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserMessageRef = useRef("");
  const sendingRef = useRef(false);

  // Keep latest callbacks in a ref so memoized methods don't invalidate on
  // parent re-renders that pass fresh callback identities.
  const callbacksRef = useRef<{
    onError: ((error: Error) => void) | undefined;
    onEvent: ((event: AiCsSseEvent) => void) | undefined;
    currentPath: string | undefined;
    isViewingLatest: (() => boolean) | undefined;
  }>({
    onError: undefined,
    onEvent: undefined,
    currentPath: undefined,
    isViewingLatest: undefined,
  });
  useLayoutEffect(() => {
    callbacksRef.current = {
      onError: options.onError,
      onEvent: options.onEvent,
      currentPath: options.currentPath,
      isViewingLatest: options.isViewingLatest,
    };
  }, [options.onError, options.onEvent, options.currentPath, options.isViewingLatest]);

  useEffect(
    () => () => {
      if (abortRef.current !== null) {
        abortRef.current.abort();
      }
    },
    [],
  );

  const reportError = useCallback((raw: unknown) => {
    let err: Error;
    if (raw instanceof Error) {
      err = raw;
    } else {
      err = new Error(String(raw));
    }
    if (err.name === "AbortError") return;
    setError(err);
    callbacksRef.current.onError?.(err);
  }, []);

  // ensureSession stays pure (it only re-throws): every caller reports its own
  // failed attempt exactly once — reporting here too would double the
  // consumer's onError callback for a single logical failure.
  const ensureSession = useCallback(async (): Promise<string> => {
    const response = await manager.getOrCreateSession();
    setSessionId(response.sessionId);
    setSessionReady(true);
    return response.sessionId;
  }, [manager]);

  const handleEvent = useCallback((event: AiCsSseEvent, version: number) => {
    if (version !== versionRef.current) {
      return;
    }
    callbacksRef.current.onEvent?.(event);
    if (event.event === "message.delta") {
      const messageId = event.data.messageId;
      const isNew = !inflightIdsRef.current.has(messageId);
      if (isNew) {
        inflightIdsRef.current.add(messageId);
        setIsStreaming(true);
        // Only bump unread when the user is NOT already viewing the newest
        // content (panel closed, or scrolled up). When the consumer reports the
        // latest is visible, the message is seen as it arrives — keep unread at 0.
        const viewingLatest = callbacksRef.current.isViewingLatest?.() ?? false;
        if (!viewingLatest) {
          setUnreadCount((c) => c + 1);
        }
      }
      setMessages((prev) => {
        const index = prev.findIndex((message) => message.id === messageId);
        if (index === -1) {
          return [
            ...prev,
            {
              id: messageId,
              role: "assistant",
              content: event.data.delta,
              done: false,
            },
          ];
        }
        const existing = prev[index] as AiCsTranscriptMessage;
        const next = [...prev];
        next[index] = { ...existing, content: existing.content + event.data.delta };
        return next;
      });
    } else if (event.event === "message.done") {
      const messageId = event.data.messageId;
      setMessages((prev) =>
        prev.map((message) => (message.id === messageId ? { ...message, done: true } : message)),
      );
      inflightIdsRef.current.delete(messageId);
      if (inflightIdsRef.current.size === 0) setIsStreaming(false);
    } else if (event.event === "navigation.suggestion") {
      setNavigation((prev) => [...prev, event.data.target]);
    } else if (event.event === "workflow.step") {
      setWorkflow((prev) => [...prev, event.data.step]);
    } else if (event.event === "source") {
      setSources((prev) => {
        const base = prev === undefined ? [] : prev;
        return [...base, event.data.source];
      });
    } else if (event.event === "support.escalation.requested") {
      // The documented escalation event can arrive over the chat stream (not
      // just via the POST /v1/escalations receipt). Surface it so the composer
      // reflects the queued handoff and the receipt banner renders.
      setEscalation({ escalationId: event.data.escalationId, status: "queued" });
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();
      if (trimmed === "") return;
      if (sendingRef.current) return;
      sendingRef.current = true;
      let id: string;
      try {
        id = await ensureSession();
      } catch (sessionErr) {
        sendingRef.current = false;
        reportError(sessionErr);
        return;
      }
      const version = versionRef.current;
      const controller = new AbortController();
      if (abortRef.current !== null) {
        abortRef.current.abort();
      }
      abortRef.current = controller;
      setError(null);
      setSending(true);
      lastUserMessageRef.current = trimmed;
      setMessages((prev) => [
        ...prev,
        { id: `user_${prev.length}_${Date.now()}`, role: "user", content: trimmed, done: true },
      ]);
      // Read the live current path once per send so per-screen context tracks
      // the screen the user is on right now, not a stale value.
      const livePath = callbacksRef.current.currentPath;
      // The worker re-checks appId/userId against the session it looked up, so
      // every chat body must carry the session's identity (see AiCsChatRequest).
      const buildChatRequest = (chatSessionId: string) =>
        livePath === undefined
          ? {
              sessionId: chatSessionId,
              message: trimmed,
              appId: options.session.appId,
              userId: options.session.userId,
            }
          : {
              sessionId: chatSessionId,
              message: trimmed,
              appId: options.session.appId,
              userId: options.session.userId,
              currentPath: livePath,
            };
      let recovered = false;
      const trySend = async (sendId: string): Promise<void> => {
        try {
          await sendAiCsChatMessage(options.api, buildChatRequest(sendId), {
            signal: controller.signal,
            onEvent: (event) => handleEvent(event, version),
          });
        } catch (sendErr) {
          if (
            !recovered &&
            sendErr instanceof AiCsApiError &&
            sendErr.status === 404 &&
            !controller.signal.aborted &&
            version === versionRef.current
          ) {
            recovered = true;
            let newId: string;
            try {
              const recovery = await manager.startNewChat({ signal: controller.signal });
              newId = recovery.sessionId;
            } catch {
              throw sendErr;
            }
            if (newId === "") {
              throw sendErr;
            }
            setSessionId(newId);
            setSessionReady(true);
            await sendAiCsChatMessage(options.api, buildChatRequest(newId), {
              signal: controller.signal,
              onEvent: (event) => handleEvent(event, version),
            });
          } else {
            throw sendErr;
          }
        }
      };
      try {
        await trySend(id);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          // Mark the last assistant message as failed if partially received.
          setMessages((prev) => {
            let lastIdx = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              if (
                (prev[i] as AiCsTranscriptMessage).role === "assistant" &&
                !(prev[i] as AiCsTranscriptMessage).done
              ) {
                lastIdx = i;
                break;
              }
            }
            /* v8 ignore next */
            if (lastIdx === -1) return prev;
            const next = [...prev];
            next[lastIdx] = {
              ...(next[lastIdx] as AiCsTranscriptMessage),
              failed: true,
              done: true,
            };
            return next;
          });
        }
        reportError(err);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        sendingRef.current = false;
        setSending(false);
        inflightIdsRef.current.clear();
        setIsStreaming(false);
      }
    },
    [
      ensureSession,
      handleEvent,
      manager,
      options.api,
      options.session.appId,
      options.session.userId,
      reportError,
    ],
  );

  const retry = useCallback(async (): Promise<void> => {
    const last = lastUserMessageRef.current;
    /* v8 ignore next */
    if (last === "") return;
    // Remove the last failed assistant message without duplicating the user message.
    setMessages((prev) => {
      let lastFailedIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (
          (prev[i] as AiCsTranscriptMessage).role === "assistant" &&
          (prev[i] as AiCsTranscriptMessage).failed
        ) {
          lastFailedIdx = i;
          break;
        }
      }
      /* v8 ignore next */
      if (lastFailedIdx === -1) return prev;
      return prev.filter((_, i) => i !== lastFailedIdx);
    });
    // Remove the last user message so sendMessage can re-add it fresh.
    setMessages((prev) => {
      let lastUserIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if ((prev[i] as AiCsTranscriptMessage).role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      /* v8 ignore next */
      if (lastUserIdx === -1) return prev;
      return prev.filter((_, i) => i !== lastUserIdx);
    });
    setError(null);
    await sendMessage(last);
  }, [sendMessage]);

  const stopGenerating = useCallback((): void => {
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    inflightIdsRef.current.clear();
    setIsStreaming(false);
    sendingRef.current = false;
    setSending(false);
    // Mark any in-progress assistant message as done.
    setMessages((prev) =>
      prev.map((m) => (m.role === "assistant" && !m.done ? { ...m, done: true } : m)),
    );
  }, []);

  const escalate = useCallback(
    async (
      detail: { reason?: string; message?: string } = {},
    ): Promise<AiCsEscalationReceipt | null> => {
      try {
        const id = await ensureSession();
        try {
          const receipt = await requestAiCsSupportEscalation(options.api, {
            sessionId: id,
            appId: options.session.appId,
            userId: options.session.userId,
            ...detail,
          });
          setEscalation(receipt);
          return receipt;
        } catch (escErr) {
          // Stale-session recovery: if the worker no longer knows this session
          // (404), recreate it once and retry the escalation transparently
          // rather than surfacing a dead error.
          if (!(escErr instanceof AiCsApiError) || escErr.status !== 404) {
            throw escErr;
          }
          const recovery = await manager.startNewChat();
          const newId = recovery.sessionId;
          if (newId === "") {
            throw escErr;
          }
          setSessionId(newId);
          setSessionReady(true);
          const receipt = await requestAiCsSupportEscalation(options.api, {
            sessionId: newId,
            appId: options.session.appId,
            userId: options.session.userId,
            ...detail,
          });
          setEscalation(receipt);
          return receipt;
        }
      } catch (err) {
        reportError(err);
        return null;
      }
    },
    [
      ensureSession,
      manager,
      options.api,
      options.session.appId,
      options.session.userId,
      reportError,
    ],
  );

  const reset = useCallback((): void => {
    versionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inflightIdsRef.current.clear();
    lastUserMessageRef.current = "";
    // Forget the active session so the next send lazily starts a fresh one.
    manager.clearActiveSession();
    setSessionId(null);
    setMessages([]);
    setNavigation([]);
    setWorkflow([]);
    setSources(undefined);
    setEscalation(null);
    setError(null);
    setSending(false);
    setIsStreaming(false);
    setSessionReady(false);
    setUnreadCount(0);
  }, [manager]);

  const clearTurn = useCallback((): void => {
    setNavigation([]);
    setWorkflow([]);
    setSources(undefined);
    lastUserMessageRef.current = "";
  }, []);

  const resetUnread = useCallback((): void => {
    setUnreadCount(0);
  }, []);

  return {
    messages,
    navigation,
    workflow,
    sources,
    escalation,
    error,
    sending,
    isStreaming,
    sessionId,
    sessionReady,
    unreadCount,
    ensureSession,
    reportError,
    sendMessage,
    retry,
    stopGenerating,
    escalate,
    reset,
    clearTurn,
    resetUnread,
  };
}

import type { ApprovedEvent } from "./_generated-events.js";
import { APPROVED_EVENTS } from "./_generated-events.js";

export type AnalyticsEnv = {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
};

// Minimal fetch signature — avoids DOM/Node lib dependency
type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<unknown>;

function rewriteHost(host: string): string {
  if (host === "https://app.posthog.com") {
    return "https://us.i.posthog.com";
  }
  return host;
}

export async function captureServerEvent(
  event: ApprovedEvent,
  opts: {
    distinctId: string;
    orgId?: string;
    properties?: Record<string, unknown>;
    env: AnalyticsEnv;
    fetch?: FetchFn;
  },
): Promise<void> {
  if (!opts.env.POSTHOG_KEY) {
    return;
  }

  if (!APPROVED_EVENTS[event]) {
    return;
  }

  const fetchFn: FetchFn = opts.fetch ?? (globalThis as unknown as { fetch: FetchFn }).fetch;
  const host = rewriteHost(opts.env.POSTHOG_HOST ?? "https://us.i.posthog.com");

  const payload = {
    api_key: opts.env.POSTHOG_KEY,
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ...sanitizeProperties(opts.properties ?? {}),
      distinct_id: opts.distinctId,
      ...(opts.orgId !== undefined ? { $groups: { organization: opts.orgId } } : {}),
    },
  };

  try {
    await fetchFn(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Never throw — analytics errors are silently discarded
  }
}

const SECRET_KEY_PATTERN = /password|token|secret|credential|key$|auth$/i;

export function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) {
      continue;
    }

    if (SECRET_KEY_PATTERN.test(k)) {
      continue;
    }

    if (typeof v === "string") {
      result[k] = v.slice(0, 1000);
    } else {
      result[k] = v;
    }
  }

  return result;
}

import type { CloudflareOptions } from "@sentry/cloudflare";
import {
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  withScope,
} from "@sentry/core";

export type SentryCloudflareEnv = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
};

export type SentryNodeOpts = {
  dsn?: string;
  environment?: string;
  release?: string;
  sendDefaultPii?: boolean;
};

export type ErrorCaptureContext = {
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
};

/**
 * Returns a Sentry CloudflareOptions config when SENTRY_DSN is present,
 * null otherwise. Pass the returned config to withSentry in the Worker export.
 */
export function initSentryCloudflare(env: SentryCloudflareEnv): CloudflareOptions | null {
  if (!env.SENTRY_DSN) return null;
  const opts: CloudflareOptions = {
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
  };
  if (env.SENTRY_ENVIRONMENT !== undefined) {
    opts.environment = env.SENTRY_ENVIRONMENT;
  }
  if (env.SENTRY_RELEASE !== undefined) {
    opts.release = env.SENTRY_RELEASE;
  }
  return opts;
}

/**
 * Initialises @sentry/node via dynamic import so it is never bundled into
 * Cloudflare Worker builds. Call this once at Node process start-up.
 */
export async function initSentryNode(opts: SentryNodeOpts): Promise<void> {
  if (!opts.dsn) return;
  const NodeSentry = await import("@sentry/node");
  const nodeOpts: Parameters<typeof NodeSentry.init>[0] = {
    dsn: opts.dsn,
    sendDefaultPii: opts.sendDefaultPii ?? false,
  };
  if (opts.environment !== undefined) nodeOpts.environment = opts.environment;
  if (opts.release !== undefined) nodeOpts.release = opts.release;
  NodeSentry.init(nodeOpts);
}

/**
 * Captures an exception via Sentry with optional tags and extra context.
 * No-ops silently when Sentry has not been initialised.
 */
export function captureException(err: unknown, ctx?: ErrorCaptureContext): string | undefined {
  try {
    let eventId: string | undefined;
    withScope((scope) => {
      for (const [key, value] of Object.entries(ctx?.tags ?? {})) {
        if (value !== undefined && value !== null) {
          scope.setTag(key, String(value));
        }
      }
      for (const [key, value] of Object.entries(ctx?.extra ?? {})) {
        scope.setExtra(key, value);
      }
      eventId = coreCaptureException(err);
    });
    return eventId;
  } catch {
    return undefined;
  }
}

/**
 * Captures a message via Sentry with optional tags and extra context.
 * No-ops silently when Sentry has not been initialised.
 */
export function captureMessage(msg: string, ctx?: ErrorCaptureContext): void {
  try {
    withScope((scope) => {
      for (const [key, value] of Object.entries(ctx?.tags ?? {})) {
        if (value !== undefined && value !== null) {
          scope.setTag(key, String(value));
        }
      }
      for (const [key, value] of Object.entries(ctx?.extra ?? {})) {
        scope.setExtra(key, value);
      }
      coreCaptureMessage(msg);
    });
  } catch {
    // No-op
  }
}

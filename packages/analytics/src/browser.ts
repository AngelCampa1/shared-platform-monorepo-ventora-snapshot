import type { ApprovedEvent, VentoraProduct } from "./_generated-events.js";
import { APPROVED_EVENTS } from "./_generated-events.js";

export type AnalyticsConfig = {
  posthogKey?: string;
  posthogHost?: string;
  environment: string;
  productSlug: VentoraProduct;
  debug?: boolean;
};

export type UserTraits = Record<string, string | number | boolean | null>;
export type OrgProps = Record<string, string | number | boolean | null>;

// PostHog instance interface — subset of posthog-js public API
interface PostHogInstance {
  init(key: string, opts: Record<string, unknown>): void;
  capture(event: string, props?: Record<string, unknown>): void;
  identify(userId: string, traits?: Record<string, unknown>): void;
  group(groupType: string, groupId: string, props?: Record<string, unknown>): void;
  reset(): void;
}

let _initialized = false;
let _productSlug: VentoraProduct | undefined;
let _posthog: PostHogInstance | undefined;

function rewriteHost(host: string): string {
  if (host === "https://app.posthog.com") {
    return "https://us.i.posthog.com";
  }
  return host;
}

function isBrowser(): boolean {
  return "window" in globalThis && "document" in globalThis;
}

export function initAnalytics(config: AnalyticsConfig): void {
  if (!config.posthogKey) {
    return;
  }

  if (!isBrowser()) {
    return;
  }

  const host = rewriteHost(config.posthogHost ?? "https://us.i.posthog.com");
  const key = config.posthogKey;
  const productSlug = config.productSlug;
  const debug = config.debug ?? false;

  import("posthog-js")
    .then((mod) => {
      const posthog = mod.default as unknown as PostHogInstance;
      posthog.init(key, {
        api_host: host,
        debug,
        loaded: () => {
          _posthog = posthog;
          _initialized = true;
          _productSlug = productSlug;
        },
      });
    })
    .catch(() => {
      // posthog-js is an optional peer dep — silently ignore if unavailable
    });
}

export function trackEvent(event: ApprovedEvent, props?: Record<string, unknown>): void {
  if (!_initialized || !_posthog) {
    return;
  }

  if (!APPROVED_EVENTS[event]) {
    // Belt-and-suspenders runtime guard (TypeScript prevents this at compile time)
    (globalThis as { console?: { warn: (...args: unknown[]) => void } }).console?.warn(
      `[ventora/analytics] trackEvent called with unapproved event: "${event}"`,
    );
    return;
  }

  _posthog.capture(event, { ...props, product: _productSlug });
}

export function identifyUser(userId: string, traits?: UserTraits): void {
  if (!_initialized || !_posthog) {
    return;
  }

  _posthog.identify(userId, traits as Record<string, unknown>);
}

export function groupOrganization(orgId: string, props?: OrgProps): void {
  if (!_initialized || !_posthog) {
    return;
  }

  _posthog.group("organization", orgId, props as Record<string, unknown>);
}

export function resetAnalytics(): void {
  if (_initialized && _posthog) {
    _posthog.reset();
  }
  _initialized = false;
  _productSlug = undefined;
  _posthog = undefined;
}

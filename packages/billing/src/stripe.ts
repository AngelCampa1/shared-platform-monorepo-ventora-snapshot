import { createRequire } from "node:module";
import type Stripe from "stripe";

export type StripeClientOpts = {
  secretKey: string;
  webhookSecret: string;
  mockMode?: boolean; // If true, use a minimal mock instead of real Stripe
};

export interface StripeClient {
  readonly stripe: Stripe;
  readonly webhookSecret: string;
}

function buildMockStripe(): Stripe {
  const checkoutSessionId = "mock_session";

  return {
    checkout: {
      sessions: {
        create: async () =>
          ({
            id: checkoutSessionId,
            object: "checkout.session",
            url: `https://mock.stripe.local/checkout/${checkoutSessionId}`,
          }) as Stripe.Response<Stripe.Checkout.Session>,
      },
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://mock.portal" }) } },
    webhooks: {
      constructEvent: (payload: string | Buffer): Stripe.Event => {
        const body = typeof payload === "string" ? payload : payload.toString("utf8");
        return JSON.parse(body) as Stripe.Event;
      },
    },
    subscriptions: {},
    customers: {},
  } as unknown as Stripe;
}

function buildRealStripe(secretKey: string): Stripe {
  // stripe is a peer dependency, so resolve it from the consumer process.
  const req = createRequire(`${process.cwd()}/package.json`);
  const StripeClass = (
    req("stripe") as { default: new (key: string, opts: Record<string, unknown>) => Stripe }
  ).default;
  return new StripeClass(secretKey, {
    apiVersion: "2024-12-18.acacia",
    maxNetworkRetries: 2,
    timeout: 30_000,
  });
}

export function createStripeClient(opts: StripeClientOpts): StripeClient {
  const { secretKey, webhookSecret, mockMode = false } = opts;

  return {
    stripe: mockMode ? buildMockStripe() : buildRealStripe(secretKey),
    webhookSecret,
  };
}

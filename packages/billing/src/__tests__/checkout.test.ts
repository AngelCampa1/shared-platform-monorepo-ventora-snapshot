import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingPortalSession, createCheckoutSession } from "../checkout.js";

// Build a minimal Stripe mock
function makeStripe(
  checkoutOverride?: Partial<{ create: (p: unknown) => Promise<Partial<Stripe.Checkout.Session>> }>,
  portalOverride?: Partial<{
    create: (p: unknown) => Promise<Partial<Stripe.BillingPortal.Session>>;
  }>,
): Stripe {
  const checkoutCreate =
    checkoutOverride?.create ??
    (async () => ({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_test_123" }));
  const portalCreate =
    portalOverride?.create ??
    (async () => ({ url: "https://billing.stripe.com/session/bps_test" }));

  return {
    checkout: { sessions: { create: vi.fn(checkoutCreate) } },
    billingPortal: { sessions: { create: vi.fn(portalCreate) } },
  } as unknown as Stripe;
}

describe("createCheckoutSession", () => {
  let stripe: Stripe;

  beforeEach(() => {
    stripe = makeStripe();
  });

  it("calls create with mode subscription and correct fields", async () => {
    const result = await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test");
    expect(result.sessionId).toBe("cs_test_123");

    const createCall = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = createCall?.[0] as Record<string, unknown>;
    expect(params.mode).toBe("subscription");
    expect(params.payment_method_types).toEqual(["card"]);
    const lineItems = params.line_items as Array<{ price: string; quantity: number }>;
    expect(lineItems[0]?.price).toBe("price_abc");
    expect(params.success_url).toBe("https://example.com/success");
    expect(params.cancel_url).toBe("https://example.com/cancel");
  });

  it("adds trial_period_days when trialDays > 0", async () => {
    await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      trialDays: 14,
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    const subData = params.subscription_data as Record<string, unknown>;
    expect(subData?.trial_period_days).toBe(14);
  });

  it("does not add subscription_data when trialDays is 0", async () => {
    await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      trialDays: 0,
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.subscription_data).toBeUndefined();
  });

  it("does not add subscription_data when trialDays is undefined", async () => {
    await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.subscription_data).toBeUndefined();
  });

  it("passes customerId when provided", async () => {
    await createCheckoutSession(stripe, {
      customerId: "cus_abc",
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.customer).toBe("cus_abc");
    expect(params.customer_email).toBeUndefined();
  });

  it("passes customerEmail when customerId not provided", async () => {
    await createCheckoutSession(stripe, {
      customerEmail: "user@example.com",
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.customer_email).toBe("user@example.com");
  });

  it("passes metadata when provided", async () => {
    await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      metadata: { orgId: "org_123" },
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.metadata).toEqual({ orgId: "org_123" });
  });

  it("passes allowPromotionCodes when provided", async () => {
    await createCheckoutSession(stripe, {
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      allowPromotionCodes: true,
    });
    const params = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.allow_promotion_codes).toBe(true);
  });

  it("throws when Stripe returns null URL", async () => {
    const noUrlStripe = makeStripe({ create: async () => ({ url: null, id: "cs_no_url" }) });
    await expect(
      createCheckoutSession(noUrlStripe, {
        priceId: "price_abc",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toThrow("URL");
  });
});

describe("createBillingPortalSession", () => {
  let stripe: Stripe;

  beforeEach(() => {
    stripe = makeStripe();
  });

  it("creates portal session with correct customerId", async () => {
    const result = await createBillingPortalSession(stripe, "cus_portal_123");
    expect(result.url).toBe("https://billing.stripe.com/session/bps_test");

    const params = (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.customer).toBe("cus_portal_123");
  });

  it("passes returnUrl when provided", async () => {
    await createBillingPortalSession(stripe, "cus_abc", "https://example.com/billing");
    const params = (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.return_url).toBe("https://example.com/billing");
  });

  it("does not include return_url when not provided", async () => {
    await createBillingPortalSession(stripe, "cus_abc");
    const params = (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(params.return_url).toBeUndefined();
  });
});

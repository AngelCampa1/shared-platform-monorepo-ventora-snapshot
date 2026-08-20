import type Stripe from "stripe";

export type CheckoutOpts = {
  customerId?: string;
  customerEmail?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
  metadata?: Record<string, string>;
  allowPromotionCodes?: boolean;
};

export type CheckoutResult = { url: string; sessionId: string };

export async function createCheckoutSession(
  stripe: Stripe,
  opts: CheckoutOpts,
): Promise<CheckoutResult> {
  const {
    customerId,
    customerEmail,
    priceId,
    successUrl,
    cancelUrl,
    trialDays,
    metadata,
    allowPromotionCodes,
  } = opts;

  const subscriptionData: Stripe.Checkout.SessionCreateParams["subscription_data"] = {};
  if (trialDays !== undefined && trialDays > 0) {
    subscriptionData.trial_period_days = trialDays;
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerId !== undefined ? { customer: customerId } : {}),
    ...(customerEmail !== undefined && customerId === undefined
      ? { customer_email: customerEmail }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(allowPromotionCodes !== undefined ? { allow_promotion_codes: allowPromotionCodes } : {}),
    ...(Object.keys(subscriptionData).length > 0 ? { subscription_data: subscriptionData } : {}),
  };

  const session = await stripe.checkout.sessions.create(params);

  if (session.url === null || session.url === undefined) {
    throw new Error("Stripe checkout session did not return a URL");
  }

  return { url: session.url, sessionId: session.id };
}

export type BillingPortalResult = { url: string };

export async function createBillingPortalSession(
  stripe: Stripe,
  customerId: string,
  returnUrl?: string,
): Promise<BillingPortalResult> {
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: customerId,
    ...(returnUrl !== undefined ? { return_url: returnUrl } : {}),
  };

  const session = await stripe.billingPortal.sessions.create(params);

  return { url: session.url };
}

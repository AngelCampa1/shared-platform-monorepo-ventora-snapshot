import type Stripe from "stripe";

export type WebhookEventType =
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted"
  | "customer.subscription.trial_will_end"
  | "invoice.payment_succeeded"
  | "invoice.payment_failed"
  | "checkout.session.completed"
  | "checkout.session.expired";

export function verifyWebhookSignature(
  stripe: Stripe,
  body: string,
  signature: string,
  secret: string,
): Stripe.Event {
  return stripe.webhooks.constructEvent(body, signature, secret);
}

const SUBSCRIPTION_EVENT_TYPES = new Set<string>([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
]);

const INVOICE_EVENT_TYPES = new Set<string>([
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

const CHECKOUT_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "checkout.session.expired",
]);

export function isSubscriptionEvent(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Subscription } } {
  return SUBSCRIPTION_EVENT_TYPES.has(event.type);
}

export function isInvoiceEvent(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Invoice } } {
  return INVOICE_EVENT_TYPES.has(event.type);
}

export function isCheckoutEvent(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Checkout.Session } } {
  return CHECKOUT_EVENT_TYPES.has(event.type);
}

export function getSubscriptionFromEvent(event: Stripe.Event): Stripe.Subscription | null {
  if (!isSubscriptionEvent(event)) return null;
  return event.data.object as Stripe.Subscription;
}

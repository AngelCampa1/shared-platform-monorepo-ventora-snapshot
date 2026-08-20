import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  getSubscriptionFromEvent,
  isCheckoutEvent,
  isInvoiceEvent,
  isSubscriptionEvent,
  verifyWebhookSignature,
} from "../webhooks.js";

function makeStripe(
  constructEventImpl?: (body: string, sig: string, secret: string) => Stripe.Event,
): Stripe {
  const impl =
    constructEventImpl ??
    ((body, sig, secret) => {
      void body;
      void sig;
      void secret;
      return {
        id: "evt_test",
        type: "customer.subscription.created",
        data: { object: {} },
      } as Stripe.Event;
    });
  return {
    webhooks: { constructEvent: vi.fn(impl) },
  } as unknown as Stripe;
}

function makeEvent(type: string, object: object = {}): Stripe.Event {
  return { id: "evt_test", type, data: { object } } as unknown as Stripe.Event;
}

describe("verifyWebhookSignature", () => {
  it("delegates to stripe.webhooks.constructEvent and returns the event", () => {
    const stripe = makeStripe();
    const event = verifyWebhookSignature(stripe, "raw-body", "sig-header", "whsec_test");
    expect(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "raw-body",
      "sig-header",
      "whsec_test",
    );
    expect(event.type).toBe("customer.subscription.created");
  });

  it("propagates errors from constructEvent", () => {
    const stripe = makeStripe(() => {
      throw new Error("Webhook signature verification failed");
    });
    expect(() => verifyWebhookSignature(stripe, "bad-body", "bad-sig", "whsec_test")).toThrow(
      "Webhook signature verification failed",
    );
  });
});

describe("isSubscriptionEvent", () => {
  const subscriptionTypes = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.trial_will_end",
  ] as const;

  for (const type of subscriptionTypes) {
    it(`returns true for ${type}`, () => {
      expect(isSubscriptionEvent(makeEvent(type))).toBe(true);
    });
  }

  it("returns false for non-subscription event types", () => {
    expect(isSubscriptionEvent(makeEvent("invoice.payment_succeeded"))).toBe(false);
    expect(isSubscriptionEvent(makeEvent("checkout.session.completed"))).toBe(false);
    expect(isSubscriptionEvent(makeEvent("unknown.event"))).toBe(false);
  });
});

describe("isInvoiceEvent", () => {
  it("returns true for invoice.payment_succeeded", () => {
    expect(isInvoiceEvent(makeEvent("invoice.payment_succeeded"))).toBe(true);
  });

  it("returns true for invoice.payment_failed", () => {
    expect(isInvoiceEvent(makeEvent("invoice.payment_failed"))).toBe(true);
  });

  it("returns false for non-invoice events", () => {
    expect(isInvoiceEvent(makeEvent("customer.subscription.created"))).toBe(false);
    expect(isInvoiceEvent(makeEvent("checkout.session.completed"))).toBe(false);
    expect(isInvoiceEvent(makeEvent("unknown.event"))).toBe(false);
  });

  it("returns false for invoice.created", () => {
    expect(isInvoiceEvent(makeEvent("invoice.created"))).toBe(false);
  });
});

describe("isCheckoutEvent", () => {
  it("returns true for checkout.session.completed", () => {
    expect(isCheckoutEvent(makeEvent("checkout.session.completed"))).toBe(true);
  });

  it("returns true for checkout.session.expired", () => {
    expect(isCheckoutEvent(makeEvent("checkout.session.expired"))).toBe(true);
  });

  it("returns false for non-checkout events", () => {
    expect(isCheckoutEvent(makeEvent("customer.subscription.created"))).toBe(false);
    expect(isCheckoutEvent(makeEvent("invoice.payment_succeeded"))).toBe(false);
    expect(isCheckoutEvent(makeEvent("unknown.event"))).toBe(false);
  });

  it("returns false for checkout.session.async_payment_succeeded", () => {
    expect(isCheckoutEvent(makeEvent("checkout.session.async_payment_succeeded"))).toBe(false);
  });
});

describe("getSubscriptionFromEvent", () => {
  it("returns subscription object for subscription events", () => {
    const subObject = { id: "sub_abc", status: "active" };
    const event = makeEvent("customer.subscription.updated", subObject);
    const result = getSubscriptionFromEvent(event);
    expect(result).toBe(subObject);
  });

  it("returns null for invoice events", () => {
    const event = makeEvent("invoice.payment_succeeded", { id: "inv_abc" });
    expect(getSubscriptionFromEvent(event)).toBeNull();
  });

  it("returns null for checkout events", () => {
    const event = makeEvent("checkout.session.completed", { id: "cs_abc" });
    expect(getSubscriptionFromEvent(event)).toBeNull();
  });

  it("returns null for unknown events", () => {
    const event = makeEvent("unknown.event", {});
    expect(getSubscriptionFromEvent(event)).toBeNull();
  });

  it("returns subscription for trial_will_end event", () => {
    const subObject = { id: "sub_trial", status: "trialing" };
    const event = makeEvent("customer.subscription.trial_will_end", subObject);
    const result = getSubscriptionFromEvent(event);
    expect(result).toBe(subObject);
  });
});

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createCheckoutSession } from "../checkout.js";
import { createStripeClient } from "../stripe.js";
import { verifyWebhookSignature } from "../webhooks.js";

describe("createStripeClient – mockMode", () => {
  it("returns a StripeClient with the webhookSecret", () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    expect(client.webhookSecret).toBe("whsec_test");
  });

  it("mock stripe has checkout.sessions.create", () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    expect(typeof client.stripe.checkout.sessions.create).toBe("function");
  });

  it("mock stripe.webhooks.constructEvent parses a Stripe-like JSON event", () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    const event = verifyWebhookSignature(
      client.stripe,
      JSON.stringify({
        id: "evt_mock_checkout",
        type: "checkout.session.completed",
        data: { object: { id: "cs_mock_123", object: "checkout.session" } },
      }),
      "sig",
      client.webhookSecret,
    );
    expect(event.id).toBe("evt_mock_checkout");
    expect(event.type).toBe("checkout.session.completed");
    const object = event.data.object as { id?: unknown };
    expect(object.id).toBe("cs_mock_123");
  });

  it("mock stripe.webhooks.constructEvent parses Buffer payloads", () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    const event = client.stripe.webhooks.constructEvent(
      Buffer.from(
        JSON.stringify({
          id: "evt_mock_buffer",
          type: "invoice.payment_succeeded",
          data: { object: { id: "in_mock_123", object: "invoice" } },
        }),
      ),
      "sig",
      client.webhookSecret,
    );
    expect(event.id).toBe("evt_mock_buffer");
    expect(event.type).toBe("invoice.payment_succeeded");
  });

  it("defaults mockMode to false when not specified", () => {
    // Uses real stripe — stripe is installed as devDependency so this resolves fine
    const client = createStripeClient({
      secretKey: "sk_test_placeholder",
      webhookSecret: "whsec_real",
    });
    expect(client.webhookSecret).toBe("whsec_real");
    expect(client.stripe).toBeDefined();
  });
});

describe("createStripeClient – mock internal functions", () => {
  it("mock stripe.checkout.sessions.create works through createCheckoutSession", async () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    const result = await createCheckoutSession(client.stripe, {
      priceId: "price_mock",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.sessionId).toBe("mock_session");
    expect(result.url).toBe("https://mock.stripe.local/checkout/mock_session");
  });

  it("mock stripe.billingPortal.sessions.create returns mock url", async () => {
    const client = createStripeClient({
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test",
      mockMode: true,
    });
    const createFn = client.stripe.billingPortal.sessions.create as unknown as () => Promise<{
      url: string;
    }>;
    const result = await createFn();
    expect(result.url).toBe("https://mock.portal");
  });
});

describe("createStripeClient – real stripe (devDependency)", () => {
  it("creates a real StripeClient with correct webhookSecret", () => {
    const client = createStripeClient({
      secretKey: "sk_test_placeholder",
      webhookSecret: "whsec_real_test",
      mockMode: false,
    });
    expect(client.webhookSecret).toBe("whsec_real_test");
    expect(client.stripe).toBeDefined();
    expect(typeof client.stripe.checkout.sessions.create).toBe("function");
  });
});

# @ventora/billing

Stripe billing abstraction: a plan registry, checkout/portal session helpers, webhook parsing, subscription status, and trial lifecycle sweeps.

## Install

```bash
pnpm add @ventora/billing
```

## Usage

```ts
import { createStripeClient, createPlanRegistry, createCheckoutSession } from "@ventora/billing";

const plans = createPlanRegistry([
  { id: "pro", name: "Pro", features: ["exports"], prices: { month: "price_123" }, isDefault: true },
]);

const { stripe } = createStripeClient({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});

const checkout = await createCheckoutSession(stripe, {
  priceId: plans.getPriceId("pro"),
  successUrl: "https://app.example.com/billing/success",
  cancelUrl: "https://app.example.com/billing",
});
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createPlanRegistry`, `createStripeClient`, `createCheckoutSession`, `createBillingPortalSession`, `verifyWebhookSignature`, `isSubscriptionEvent`/`isInvoiceEvent`/`isCheckoutEvent`, `getSubscriptionFromEvent`, `normalizeBillingStatus`, `isInActiveTrial`, `hasPaidPlanAccess`, `isSubscriptionExpired`, `subscriptionNeedsAttention`, `createTrialLifecycle`, and their types (`BillingPlan`, `PlanRegistry`, `CheckoutOpts`, `WebhookEventType`, `BillingStatus`, `TrialLifecycleOpts`, ...) |

## Notes

- `stripe` is an optional peer dependency; `createStripeClient({ mockMode: true })` returns an in-memory stand-in with no network calls, for tests.
- `PlanRegistry` rejects duplicate plan IDs and duplicate Stripe price IDs across plans at construction time, not at first use.
- `createTrialLifecycle` is duck-typed against a minimal `TrialDb` interface rather than a specific ORM, so it works with any database adapter that implements `findExpiredTrials`/`markTrialExpired`/`findTrialsEndingSoon`.

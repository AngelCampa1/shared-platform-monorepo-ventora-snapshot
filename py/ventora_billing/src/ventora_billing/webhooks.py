from __future__ import annotations

from typing import cast

import stripe

SUBSCRIPTION_EVENT_TYPES = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.trial_will_end",
}

INVOICE_EVENT_TYPES = {
    "invoice.payment_succeeded",
    "invoice.payment_failed",
}

CHECKOUT_EVENT_TYPES = {
    "checkout.session.completed",
    "checkout.session.expired",
}


def verify_webhook_signature(
    payload: str | bytes,
    signature: str,
    secret: str,
) -> stripe.Event:
    """Verify Stripe webhook signature and return the event. Raises StripeError on failure."""
    return cast(stripe.Event, stripe.Webhook.construct_event(payload, signature, secret))  # type: ignore[no-untyped-call]


def is_subscription_event(event: stripe.Event) -> bool:
    return event.type in SUBSCRIPTION_EVENT_TYPES


def is_invoice_event(event: stripe.Event) -> bool:
    return event.type in INVOICE_EVENT_TYPES


def is_checkout_event(event: stripe.Event) -> bool:
    return event.type in CHECKOUT_EVENT_TYPES


def get_subscription_from_event(event: stripe.Event) -> stripe.Subscription | None:
    if not is_subscription_event(event):
        return None
    obj = event.data.object
    if isinstance(obj, stripe.Subscription):
        return obj
    return None

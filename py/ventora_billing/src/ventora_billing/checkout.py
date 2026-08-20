from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import stripe


@dataclass
class CheckoutResult:
    url: str
    session_id: str


@dataclass
class BillingPortalResult:
    url: str


def create_checkout_session(
    client: stripe.StripeClient,
    *,
    price_id: str,
    success_url: str,
    cancel_url: str,
    customer_id: str | None = None,
    customer_email: str | None = None,
    trial_days: int | None = None,
    metadata: dict[str, str] | None = None,
    allow_promotion_codes: bool = False,
) -> CheckoutResult:
    params: dict[str, Any] = {
        "mode": "subscription",
        "payment_method_types": ["card"],
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "allow_promotion_codes": allow_promotion_codes,
    }
    if customer_id:
        params["customer"] = customer_id
    elif customer_email:
        params["customer_email"] = customer_email
    if trial_days and trial_days > 0:
        params["subscription_data"] = {"trial_period_days": trial_days}
    if metadata:
        params["metadata"] = metadata

    session = client.checkout.sessions.create(**params)
    if not session.url:
        raise ValueError("Stripe checkout session did not return a URL")
    return CheckoutResult(url=session.url, session_id=session.id)


def create_billing_portal_session(
    client: stripe.StripeClient,
    customer_id: str,
    return_url: str | None = None,
) -> BillingPortalResult:
    params: dict[str, Any] = {"customer": customer_id}
    if return_url:
        params["return_url"] = return_url
    session = client.billing_portal.sessions.create(**params)
    return BillingPortalResult(url=session.url)

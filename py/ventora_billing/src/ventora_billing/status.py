from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

BillingStatus = Literal["trialing", "active", "past_due", "canceled", "incomplete", "inactive"]

_STATUS_MAP: dict[str, BillingStatus] = {
    "trialing": "trialing",
    "active": "active",
    "past_due": "past_due",
    "canceled": "canceled",
    "cancelled": "canceled",
    "incomplete": "incomplete",
    "incomplete_expired": "incomplete",
}


def normalize_billing_status(stripe_status: str) -> BillingStatus:
    return _STATUS_MAP.get(stripe_status, "inactive")


@dataclass
class SubscriptionState:
    status: BillingStatus
    trial_ends_at: datetime | None = None
    current_period_end: datetime | None = None


def is_in_active_trial(sub: SubscriptionState) -> bool:
    if sub.status != "trialing":
        return False
    if sub.trial_ends_at is None:
        return False
    return sub.trial_ends_at > datetime.now(UTC)


def has_paid_plan_access(sub: SubscriptionState) -> bool:
    return sub.status in ("active", "trialing")


def is_subscription_expired(sub: SubscriptionState) -> bool:
    return sub.status in ("canceled", "inactive")


def subscription_needs_attention(sub: SubscriptionState) -> bool:
    return sub.status in ("past_due", "incomplete")

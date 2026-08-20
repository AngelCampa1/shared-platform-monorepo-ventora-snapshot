from __future__ import annotations
from datetime import UTC, datetime, timezone, timedelta

import pytest

from ventora_billing.status import (
    normalize_billing_status,
    SubscriptionState,
    is_in_active_trial,
    has_paid_plan_access,
    is_subscription_expired,
    subscription_needs_attention,
)


# --- normalize_billing_status ---

@pytest.mark.parametrize("stripe_status,expected", [
    ("trialing", "trialing"),
    ("active", "active"),
    ("past_due", "past_due"),
    ("canceled", "canceled"),
    ("cancelled", "canceled"),   # British spelling normalised
    ("incomplete", "incomplete"),
    ("incomplete_expired", "incomplete"),
    ("unpaid", "inactive"),       # unknown maps to inactive
    ("paused", "inactive"),
    ("", "inactive"),
])
def test_normalize_billing_status(stripe_status: str, expected: str):
    assert normalize_billing_status(stripe_status) == expected


# --- is_in_active_trial ---

def test_is_in_active_trial_true_for_trialing_with_future_date():
    future = datetime.now(timezone.utc) + timedelta(days=5)
    sub = SubscriptionState(status="trialing", trial_ends_at=future)
    assert is_in_active_trial(sub) is True


def test_is_in_active_trial_false_for_trialing_with_past_date():
    past = datetime.now(timezone.utc) - timedelta(days=1)
    sub = SubscriptionState(status="trialing", trial_ends_at=past)
    assert is_in_active_trial(sub) is False


def test_is_in_active_trial_false_for_trialing_with_no_date():
    # Mirrors TS: isInActiveTrial returns false when trialEndsAt is undefined.
    # A trialing record with no end date is not a verifiable active trial.
    sub = SubscriptionState(status="trialing", trial_ends_at=None)
    assert is_in_active_trial(sub) is False


def test_is_in_active_trial_false_for_active_status():
    sub = SubscriptionState(status="active")
    assert is_in_active_trial(sub) is False


def test_is_in_active_trial_false_for_canceled():
    sub = SubscriptionState(status="canceled")
    assert is_in_active_trial(sub) is False


def test_is_in_active_trial_uses_utc_aware_comparison():
    """is_in_active_trial must use datetime.now(UTC) so a UTC-aware trial_ends_at compares correctly."""
    future_utc = datetime.now(UTC) + timedelta(hours=1)
    sub = SubscriptionState(status="trialing", trial_ends_at=future_utc)
    assert is_in_active_trial(sub) is True

    past_utc = datetime.now(UTC) - timedelta(hours=1)
    sub_past = SubscriptionState(status="trialing", trial_ends_at=past_utc)
    assert is_in_active_trial(sub_past) is False


def test_is_in_active_trial_naive_trial_ends_at_raises():
    """Naive trial_ends_at must raise TypeError when compared against UTC-aware now."""
    naive = datetime(2099, 1, 1)  # no tzinfo
    sub = SubscriptionState(status="trialing", trial_ends_at=naive)
    with pytest.raises(TypeError):
        is_in_active_trial(sub)


# --- has_paid_plan_access ---

@pytest.mark.parametrize("status,expected", [
    ("active", True),
    ("trialing", True),
    ("past_due", False),
    ("canceled", False),
    ("incomplete", False),
    ("inactive", False),
])
def test_has_paid_plan_access(status: str, expected: bool):
    sub = SubscriptionState(status=status)  # type: ignore[arg-type]
    assert has_paid_plan_access(sub) is expected


# --- is_subscription_expired ---

@pytest.mark.parametrize("status,expected", [
    ("canceled", True),
    ("inactive", True),
    ("active", False),
    ("trialing", False),
    ("past_due", False),
    ("incomplete", False),
])
def test_is_subscription_expired(status: str, expected: bool):
    sub = SubscriptionState(status=status)  # type: ignore[arg-type]
    assert is_subscription_expired(sub) is expected


# --- subscription_needs_attention ---

@pytest.mark.parametrize("status,expected", [
    ("past_due", True),
    ("incomplete", True),
    ("active", False),
    ("trialing", False),
    ("canceled", False),
    ("inactive", False),
])
def test_subscription_needs_attention(status: str, expected: bool):
    sub = SubscriptionState(status=status)  # type: ignore[arg-type]
    assert subscription_needs_attention(sub) is expected

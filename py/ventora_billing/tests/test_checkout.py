from __future__ import annotations
from unittest.mock import MagicMock, patch

import pytest

from ventora_billing.checkout import (
    CheckoutResult,
    BillingPortalResult,
    create_checkout_session,
    create_billing_portal_session,
)


def make_mock_client() -> MagicMock:
    client = MagicMock()
    session = MagicMock()
    session.url = "https://checkout.stripe.com/session/cs_test_abc"
    session.id = "cs_test_abc"
    client.checkout.sessions.create.return_value = session
    portal_session = MagicMock()
    portal_session.url = "https://billing.stripe.com/session/bps_test_xyz"
    client.billing_portal.sessions.create.return_value = portal_session
    return client


# --- create_checkout_session ---

def test_checkout_session_mode_is_subscription():
    client = make_mock_client()
    result = create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["mode"] == "subscription"


def test_checkout_session_returns_url_and_id():
    client = make_mock_client()
    result = create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
    )
    assert isinstance(result, CheckoutResult)
    assert result.url == "https://checkout.stripe.com/session/cs_test_abc"
    assert result.session_id == "cs_test_abc"


def test_checkout_session_includes_trial_period_days_when_positive():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        trial_days=14,
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert "subscription_data" in call_kwargs
    assert call_kwargs["subscription_data"]["trial_period_days"] == 14


def test_checkout_session_omits_trial_period_days_when_zero():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        trial_days=0,
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert "subscription_data" not in call_kwargs


def test_checkout_session_omits_trial_period_days_when_none():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        trial_days=None,
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert "subscription_data" not in call_kwargs


def test_checkout_session_passes_customer_id():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        customer_id="cus_123",
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["customer"] == "cus_123"
    assert "customer_email" not in call_kwargs


def test_checkout_session_passes_customer_email_when_no_customer_id():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        customer_email="test@example.com",
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["customer_email"] == "test@example.com"
    assert "customer" not in call_kwargs


def test_checkout_session_passes_metadata():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        metadata={"user_id": "u_42"},
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["metadata"] == {"user_id": "u_42"}


def test_checkout_session_allow_promotion_codes_default_false():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["allow_promotion_codes"] is False


def test_checkout_session_allow_promotion_codes_true():
    client = make_mock_client()
    create_checkout_session(
        client,
        price_id="price_abc",
        success_url="https://app.test/success",
        cancel_url="https://app.test/cancel",
        allow_promotion_codes=True,
    )
    call_kwargs = client.checkout.sessions.create.call_args[1]
    assert call_kwargs["allow_promotion_codes"] is True


def test_checkout_session_raises_when_stripe_returns_no_url():
    client = make_mock_client()
    client.checkout.sessions.create.return_value.url = None
    with pytest.raises(ValueError, match="Stripe checkout session did not return a URL"):
        create_checkout_session(
            client,
            price_id="price_abc",
            success_url="https://app.test/success",
            cancel_url="https://app.test/cancel",
        )


# --- create_billing_portal_session ---

def test_billing_portal_returns_url():
    client = make_mock_client()
    result = create_billing_portal_session(client, "cus_123")
    assert isinstance(result, BillingPortalResult)
    assert result.url == "https://billing.stripe.com/session/bps_test_xyz"


def test_billing_portal_passes_customer_id():
    client = make_mock_client()
    create_billing_portal_session(client, "cus_123")
    call_kwargs = client.billing_portal.sessions.create.call_args[1]
    assert call_kwargs["customer"] == "cus_123"


def test_billing_portal_includes_return_url_when_provided():
    client = make_mock_client()
    create_billing_portal_session(client, "cus_123", return_url="https://app.test/settings")
    call_kwargs = client.billing_portal.sessions.create.call_args[1]
    assert call_kwargs["return_url"] == "https://app.test/settings"


def test_billing_portal_omits_return_url_when_none():
    client = make_mock_client()
    create_billing_portal_session(client, "cus_123", return_url=None)
    call_kwargs = client.billing_portal.sessions.create.call_args[1]
    assert "return_url" not in call_kwargs

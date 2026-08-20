from __future__ import annotations
from unittest.mock import MagicMock, patch

import stripe

from ventora_billing.webhooks import (
    verify_webhook_signature,
    is_subscription_event,
    is_invoice_event,
    is_checkout_event,
    get_subscription_from_event,
)


def make_event(event_type: str, obj: object | None = None) -> stripe.Event:
    event = MagicMock(spec=stripe.Event)
    event.type = event_type
    data = MagicMock()
    data.object = obj if obj is not None else MagicMock()
    event.data = data
    return event


# --- verify_webhook_signature ---

def test_verify_webhook_signature_calls_construct_event():
    payload = b'{"id": "evt_test"}'
    signature = "t=123,v1=abc"
    secret = "whsec_test"
    fake_event = MagicMock(spec=stripe.Event)

    with patch("stripe.Webhook.construct_event", return_value=fake_event) as mock_construct:
        result = verify_webhook_signature(payload, signature, secret)
        mock_construct.assert_called_once_with(payload, signature, secret)
        assert result is fake_event


def test_verify_webhook_signature_with_string_payload():
    payload = '{"id": "evt_test"}'
    signature = "t=456,v1=def"
    secret = "whsec_test2"
    fake_event = MagicMock(spec=stripe.Event)

    with patch("stripe.Webhook.construct_event", return_value=fake_event) as mock_construct:
        result = verify_webhook_signature(payload, signature, secret)
        mock_construct.assert_called_once_with(payload, signature, secret)
        assert result is fake_event


# --- is_subscription_event ---

def test_is_subscription_event_true_for_created():
    event = make_event("customer.subscription.created")
    assert is_subscription_event(event) is True


def test_is_subscription_event_true_for_updated():
    event = make_event("customer.subscription.updated")
    assert is_subscription_event(event) is True


def test_is_subscription_event_true_for_deleted():
    event = make_event("customer.subscription.deleted")
    assert is_subscription_event(event) is True


def test_is_subscription_event_false_for_invoice():
    event = make_event("invoice.payment_failed")
    assert is_subscription_event(event) is False


def test_is_subscription_event_false_for_checkout():
    event = make_event("checkout.session.completed")
    assert is_subscription_event(event) is False


# --- is_invoice_event ---

def test_is_invoice_event_true_for_payment_succeeded():
    event = make_event("invoice.payment_succeeded")
    assert is_invoice_event(event) is True


def test_is_invoice_event_true_for_payment_failed():
    event = make_event("invoice.payment_failed")
    assert is_invoice_event(event) is True


def test_is_invoice_event_false_for_subscription():
    event = make_event("customer.subscription.created")
    assert is_invoice_event(event) is False


def test_is_invoice_event_false_for_invoice_created():
    event = make_event("invoice.created")
    assert is_invoice_event(event) is False


# --- is_checkout_event ---

def test_is_checkout_event_true_for_completed():
    event = make_event("checkout.session.completed")
    assert is_checkout_event(event) is True


def test_is_checkout_event_true_for_expired():
    event = make_event("checkout.session.expired")
    assert is_checkout_event(event) is True


def test_is_checkout_event_false_for_invoice():
    event = make_event("invoice.payment_succeeded")
    assert is_checkout_event(event) is False


def test_is_checkout_event_false_for_async_payment_succeeded():
    event = make_event("checkout.session.async_payment_succeeded")
    assert is_checkout_event(event) is False


# --- get_subscription_from_event ---

def test_get_subscription_from_event_returns_subscription():
    sub = MagicMock(spec=stripe.Subscription)
    event = make_event("customer.subscription.created", obj=sub)
    result = get_subscription_from_event(event)
    assert result is sub


def test_get_subscription_from_event_rejects_unsupported_subscription_event_type():
    sub = MagicMock(spec=stripe.Subscription)
    event = make_event("customer.subscription.paused", obj=sub)
    result = get_subscription_from_event(event)
    assert result is None


def test_get_subscription_from_event_returns_none_for_non_subscription():
    invoice = MagicMock(spec=stripe.Invoice)
    event = make_event("invoice.payment_succeeded", obj=invoice)
    result = get_subscription_from_event(event)
    assert result is None


def test_get_subscription_from_event_returns_none_for_checkout_session():
    session = MagicMock(spec=stripe.checkout.Session)
    event = make_event("checkout.session.completed", obj=session)
    result = get_subscription_from_event(event)
    assert result is None

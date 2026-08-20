from __future__ import annotations

import ventora_analytics
from ventora_analytics._generated_events import APPROVED_EVENTS, ApprovedEvent, VentoraProduct
from ventora_analytics.client import is_approved_event


def test_approved_events_is_non_empty_tuple() -> None:
    assert isinstance(APPROVED_EVENTS, tuple)
    assert len(APPROVED_EVENTS) > 0


def test_approved_events_all_strings() -> None:
    for entry in APPROVED_EVENTS:
        assert isinstance(entry, str), f"Expected str, got {type(entry)} for {entry!r}"


def test_is_approved_event_known() -> None:
    assert is_approved_event("user_signed_up") is True
    assert is_approved_event("page_viewed") is True
    assert is_approved_event("checkout_completed") is True


def test_is_approved_event_unknown() -> None:
    assert is_approved_event("not_a_real_event") is False
    assert is_approved_event("") is False
    assert is_approved_event("USER_SIGNED_UP") is False  # case-sensitive


def test_approved_event_type_alias_importable() -> None:
    # ApprovedEvent is a Literal type alias — just verify it's importable and is a type
    assert ApprovedEvent is not None


def test_ventora_product_importable() -> None:
    # VentoraProduct is a Literal type alias — just verify it's importable
    assert VentoraProduct is not None


def test_approved_events_exported_from_package() -> None:
    assert ventora_analytics.APPROVED_EVENTS is APPROVED_EVENTS


def test_all_approved_events_are_lowercase_underscored() -> None:
    for event in APPROVED_EVENTS:
        assert event == event.lower(), f"Event {event!r} is not lowercase"
        assert " " not in event, f"Event {event!r} contains spaces"

from __future__ import annotations

import pytest

from ventora_email.canspam import assert_can_spam_compliance, build_list_unsubscribe_headers


def test_raises_for_empty_string():
    with pytest.raises(ValueError, match="CAN-SPAM requires a valid postal address"):
        assert_can_spam_compliance("")


def test_raises_for_whitespace_only():
    with pytest.raises(ValueError, match="CAN-SPAM requires a valid postal address"):
        assert_can_spam_compliance("   ")


def test_raises_for_set_placeholder():
    with pytest.raises(ValueError, match="placeholder"):
        assert_can_spam_compliance("[Set your postal address]")


def test_raises_for_any_bracketed_address():
    with pytest.raises(ValueError, match="placeholder"):
        assert_can_spam_compliance("[anything]")


def test_raises_for_placeholder_literal():
    with pytest.raises(ValueError, match="placeholder"):
        assert_can_spam_compliance("Placeholder Address")


def test_raises_for_todo_in_address():
    with pytest.raises(ValueError, match="placeholder"):
        assert_can_spam_compliance("TODO: set address")


def test_passes_for_real_address():
    # Should not raise
    assert_can_spam_compliance("123 Main St, Springfield, IL 62704")


def test_passes_for_real_address_with_suite():
    # Should not raise
    assert_can_spam_compliance("100 Innovation Drive, Suite 400, San Jose, CA 95110")


def test_build_list_unsubscribe_headers_returns_both_keys():
    url = "https://example.com/unsubscribe?token=abc123"
    headers = build_list_unsubscribe_headers(url)
    assert "List-Unsubscribe" in headers
    assert "List-Unsubscribe-Post" in headers


def test_build_list_unsubscribe_headers_correct_values():
    url = "https://example.com/unsubscribe?token=abc123"
    headers = build_list_unsubscribe_headers(url)
    assert headers["List-Unsubscribe"] == f"<{url}>"
    assert headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"

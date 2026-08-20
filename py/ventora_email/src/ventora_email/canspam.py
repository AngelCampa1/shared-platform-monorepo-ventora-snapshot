from __future__ import annotations


def assert_can_spam_compliance(postal_address: str) -> None:
    """Raise ValueError if postal_address is missing or looks like a placeholder."""
    if not postal_address or not postal_address.strip():
        raise ValueError("CAN-SPAM requires a valid postal address")
    lower = postal_address.lower()
    bracketed = "[" in postal_address and "]" in postal_address
    if bracketed or "placeholder" in lower or "todo" in lower:
        raise ValueError(f"CAN-SPAM postal address appears to be a placeholder: {postal_address!r}")


def build_list_unsubscribe_headers(unsubscribe_url: str) -> dict[str, str]:
    """Build RFC 8058 List-Unsubscribe headers for one-click unsubscribe."""
    return {
        "List-Unsubscribe": f"<{unsubscribe_url}>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }

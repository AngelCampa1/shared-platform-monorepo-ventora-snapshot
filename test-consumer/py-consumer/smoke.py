#!/usr/bin/env python3
"""Smoke test: import every ventora_* module and call one function from each."""
import sys

errors: list[str] = []

def check(name: str, fn) -> None:
    try:
        fn()
        print(f"  OK  {name}")
    except Exception as e:
        errors.append(f"FAIL {name}: {e}")
        print(f"FAIL {name}: {e}", file=sys.stderr)

# ventora_observability
def test_observability() -> None:
    from ventora_observability import NotFoundError, build_internal_error_body, generate_request_id, redact
    e = NotFoundError()
    assert e.status == 404
    body = build_internal_error_body("track-123")
    assert body["trackingId"] == "track-123"
    rid = generate_request_id()
    assert len(rid) == 36
    redacted = redact({"email": "admin@example.com", "password": "secret"})
    assert redacted["email"] == "[email]"
    assert redacted["password"] == "[redacted]"
    assert redact("MRN: ABCD-1234 NPI: 1234567890") == "[mrn] [npi]"

check("ventora_observability", test_observability)

# ventora_analytics
def test_analytics() -> None:
    from ventora_analytics import APPROVED_EVENTS, is_approved_event
    assert "user_signed_up" in APPROVED_EVENTS
    assert is_approved_event("user_signed_up")
    assert not is_approved_event("not_a_real_event")

check("ventora_analytics", test_analytics)

# ventora_storage
def test_storage() -> None:
    from ventora_storage import sanitize_filename, build_tenant_key
    assert sanitize_filename("hello world.pdf") == "hello_world.pdf"
    key = build_tenant_key("tenant-1", "docs", "report.pdf")
    assert key == "tenant-1/docs/report.pdf"

check("ventora_storage", test_storage)

# ventora_email
def test_email() -> None:
    from ventora_email import generate_unsubscribe_token, verify_unsubscribe_token, assert_can_spam_compliance
    token = generate_unsubscribe_token("user-1", "marketing", "secret-key-value-32-chars-pad--")
    result = verify_unsubscribe_token(token, "secret-key-value-32-chars-pad--")
    assert result is not None
    assert result["userId"] == "user-1"
    assert_can_spam_compliance("123 Main St, City, ST 00000")

check("ventora_email", test_email)

# ventora_billing
def test_billing() -> None:
    from ventora_billing import normalize_billing_status, BillingPlan, create_plan_registry
    assert normalize_billing_status("active") == "active"
    assert normalize_billing_status("cancelled") == "canceled"
    plan = BillingPlan(id="starter", name="Starter", features=["feature_a"], prices={"month": "price_abc"})
    registry = create_plan_registry([plan])
    assert registry.get_price_id("starter", "month") == "price_abc"
    assert registry.has_feature_access("starter", "feature_a")

check("ventora_billing", test_billing)

# ventora_llm
def test_llm() -> None:
    from ventora_llm import LlmConfig, ExtractionPass, MultiPassResult, DEFAULT_MODEL
    cfg = LlmConfig(api_key="test-key")
    assert cfg.model == DEFAULT_MODEL
    p = ExtractionPass(name="test", system_prompt="sys", user_prompt_template="doc: {document}")
    assert p.name == "test"
    result = MultiPassResult(document_id="doc-1")
    assert result.success  # no results = vacuously true
    assert result.total_tokens == 0

check("ventora_llm", test_llm)

if errors:
    print(f"\n{len(errors)} error(s):", file=sys.stderr)
    sys.exit(1)
else:
    print(f"\nAll {6} packages OK")

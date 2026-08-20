from __future__ import annotations
import pytest

from ventora_observability.redact import redact


# ---------------------------------------------------------------------------
# String redaction
# ---------------------------------------------------------------------------

def test_redact_email_in_string() -> None:
    result = redact("Contact us at admin@example.com for help")
    assert "[email]" in result
    assert "admin@example.com" not in result


def test_redact_jwt_in_string() -> None:
    jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    result = redact(f"Token: {jwt}")
    assert "[jwt]" in result
    assert "eyJhbGciOiJSUzI1NiJ9" not in result


def test_redact_bearer_token_in_string() -> None:
    result = redact("Authorization: Bearer mysecrettoken123")
    assert "mysecrettoken123" not in result
    assert "Bearer [token]" in result


def test_redact_hipaa_extension_identifiers() -> None:
    text = "MRN: ABCD-1234 NPI: 1234567890 DEA: AB1234567 DOS: 01/02/2024"
    result = redact(text)
    assert result == "[mrn] [npi] [dea] [date-of-service]"


def test_redact_hipaa_extension_identifiers_case_insensitive() -> None:
    text = "Mrn: abcd-1234 npi: 1234567890 dea: ab1234567 Date of Service: 01/02/2026"
    result = redact(text)
    assert result == "[mrn] [npi] [dea] [date-of-service]"


def test_redact_custom_hipaa_extension_rules() -> None:
    custom_rules = {
        "fieldKeys": [],
        "patterns": [],
        "hipaa18Extensions": [{"pattern": r"\bCASE-[0-9]+\b", "replacement": "[case]"}],
        "keyPatterns": [],
    }
    assert redact("CASE-123 is open", rules=custom_rules) == "[case] is open"


def test_redact_clean_string_unchanged() -> None:
    msg = "Hello, world! No PII here."
    result = redact(msg)
    assert result == msg


# ---------------------------------------------------------------------------
# Dict field key redaction
# ---------------------------------------------------------------------------

def test_redact_password_field_key() -> None:
    data = {"username": "alice", "password": "s3cr3t!"}
    result = redact(data)
    assert result["password"] == "[redacted]"
    assert result["username"] == "alice"


def test_redact_token_field_key() -> None:
    data = {"token": "abc123"}
    result = redact(data)
    assert result["token"] == "[redacted]"


def test_redact_api_key_field() -> None:
    data = {"api_key": "key-xyz", "name": "service"}
    result = redact(data)
    assert result["api_key"] == "[redacted]"
    assert result["name"] == "service"


def test_redact_ssn_field_key() -> None:
    data = {"ssn": "123-45-6789"}
    result = redact(data)
    assert result["ssn"] == "[redacted]"


def test_redact_credit_card_field_key() -> None:
    data = {"credit_card": "4111111111111111"}
    result = redact(data)
    assert result["credit_card"] == "[redacted]"


# ---------------------------------------------------------------------------
# Nested dict / list recursion
# ---------------------------------------------------------------------------

def test_redact_nested_dict() -> None:
    data = {
        "user": {
            "email": "user@test.com",
            "password": "secret123",
            "name": "Bob",
        }
    }
    result = redact(data)
    assert result["user"]["password"] == "[redacted]"
    assert result["user"]["name"] == "Bob"
    assert "user@test.com" not in result["user"]["email"]


def test_redact_list_of_strings() -> None:
    data = ["hello@world.com", "no pii here", "Bearer token123"]
    result = redact(data)
    assert "[email]" in result[0]
    assert result[1] == "no pii here"
    assert "token123" not in result[2]


def test_redact_list_inside_dict() -> None:
    data = {"emails": ["a@b.com", "c@d.com"]}
    result = redact(data)
    for item in result["emails"]:
        assert "[email]" in item


def test_redact_deeply_nested() -> None:
    data = {"level1": {"level2": {"secret": "topsecret"}}}
    result = redact(data)
    assert result["level1"]["level2"]["secret"] == "[redacted]"


def test_redact_tuple_values() -> None:
    data = ("hello@world.com", "clean text")
    result = redact(data)
    assert isinstance(result, tuple)
    assert "[email]" in result[0]
    assert result[1] == "clean text"


# ---------------------------------------------------------------------------
# Non-string scalars pass through unchanged
# ---------------------------------------------------------------------------

def test_redact_integer_unchanged() -> None:
    assert redact(42) == 42


def test_redact_float_unchanged() -> None:
    assert redact(3.14) == 3.14


def test_redact_none_unchanged() -> None:
    assert redact(None) is None


def test_redact_bool_unchanged() -> None:
    assert redact(True) is True
    assert redact(False) is False


def test_redact_int_in_dict_value_unchanged() -> None:
    data = {"count": 5, "user": "alice"}
    result = redact(data)
    assert result["count"] == 5
    assert result["user"] == "alice"


# ---------------------------------------------------------------------------
# Custom rules override defaults
# ---------------------------------------------------------------------------

def test_redact_custom_rules_override_field_keys() -> None:
    custom_rules = {
        "fieldKeys": ["my_secret_field"],
        "patterns": [],
        "keyPatterns": [],
    }
    data = {"my_secret_field": "sensitive", "password": "should_not_be_redacted"}
    result = redact(data, rules=custom_rules)
    assert result["my_secret_field"] == "[redacted]"
    # "password" is not in custom rules, so it should NOT be redacted
    assert result["password"] == "should_not_be_redacted"


def test_redact_custom_rules_pattern() -> None:
    custom_rules = {
        "fieldKeys": [],
        "patterns": [{"pattern": r"\bFOO\b", "replacement": "[bar]"}],
        "keyPatterns": [],
    }
    result = redact("value is FOO here", rules=custom_rules)
    assert result == "value is [bar] here"


def test_redact_custom_rules_key_pattern() -> None:
    custom_rules = {
        "fieldKeys": [],
        "patterns": [],
        "keyPatterns": [{"pattern": r"(?i)secret$", "replacement": "[redacted]"}],
    }
    data = {"mySecret": "hidden", "name": "alice"}
    result = redact(data, rules=custom_rules)
    assert result["mySecret"] == "[redacted]"
    assert result["name"] == "alice"


def test_redact_custom_empty_rules_no_redaction() -> None:
    custom_rules = {"fieldKeys": [], "patterns": [], "keyPatterns": []}
    data = {"password": "should_pass", "email": "test@example.com"}
    result = redact(data, rules=custom_rules)
    # No rules applied — password and email pass through unchanged
    assert result["password"] == "should_pass"
    assert result["email"] == "test@example.com"


# ---------------------------------------------------------------------------
# _load_rules fallback
# ---------------------------------------------------------------------------

def test_load_rules_fallback_on_explicit_bad_path() -> None:
    """Explicit test override paths can fall back to empty rules."""
    import importlib
    from pathlib import Path

    redact_mod = importlib.import_module("ventora_observability.redact")

    result = redact_mod._load_rules(Path("/nonexistent/redaction-rules.json"))  # type: ignore[attr-defined]

    assert result == {"fieldKeys": [], "patterns": [], "keyPatterns": []}


def test_load_rules_reads_explicit_path(tmp_path: object) -> None:
    import importlib
    from pathlib import Path

    redact_mod = importlib.import_module("ventora_observability.redact")
    path = Path(tmp_path) / "rules.json"
    path.write_text('{"fieldKeys": ["custom"], "patterns": [], "keyPatterns": []}', encoding="utf-8")
    result = redact_mod._load_rules(path)  # type: ignore[attr-defined]
    assert result["fieldKeys"] == ["custom"]


def test_load_rules_falls_back_to_repo_schema(monkeypatch: object) -> None:
    import importlib

    redact_mod = importlib.import_module("ventora_observability.redact")

    class MissingResource:
        def joinpath(self, _name: str) -> "MissingResource":
            return self

        def read_text(self, *, encoding: str) -> str:
            raise FileNotFoundError("missing resource")

    monkeypatch.setattr(redact_mod.resources, "files", lambda _package: MissingResource())  # type: ignore[attr-defined]
    result = redact_mod._load_rules()  # type: ignore[attr-defined]
    assert "password" in result["fieldKeys"]


def test_load_rules_raises_when_bundled_and_repo_rules_missing(monkeypatch: object) -> None:
    import importlib
    import pytest

    redact_mod = importlib.import_module("ventora_observability.redact")

    class MissingResource:
        def joinpath(self, _name: str) -> "MissingResource":
            return self

        def read_text(self, *, encoding: str) -> str:
            raise FileNotFoundError("missing resource")

    monkeypatch.setattr(redact_mod.resources, "files", lambda _package: MissingResource())  # type: ignore[attr-defined]
    monkeypatch.setattr(redact_mod.Path, "exists", lambda _self: False)  # type: ignore[attr-defined]
    with pytest.raises(RuntimeError, match="Bundled redaction rules"):
        redact_mod._load_rules()  # type: ignore[attr-defined]


def test_load_rules_raises_when_bundled_rules_are_not_an_object(monkeypatch: object) -> None:
    import importlib
    import pytest

    redact_mod = importlib.import_module("ventora_observability.redact")

    class ArrayResource:
        def joinpath(self, _name: str) -> "ArrayResource":
            return self

        def read_text(self, *, encoding: str) -> str:
            return "[]"

    monkeypatch.setattr(redact_mod.resources, "files", lambda _package: ArrayResource())  # type: ignore[attr-defined]
    with pytest.raises(RuntimeError, match="JSON object"):
        redact_mod._load_rules()  # type: ignore[attr-defined]


def test_default_rules_are_loaded_from_package_resource() -> None:
    result = redact({"password": "secret", "email": "admin@example.com"})
    assert result["password"] == "[redacted]"
    assert result["email"] == "[email]"

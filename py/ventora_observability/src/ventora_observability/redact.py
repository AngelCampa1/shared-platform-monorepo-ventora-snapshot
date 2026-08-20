from __future__ import annotations

import json
import re
from importlib import resources
from pathlib import Path
from typing import Any

_EMPTY_RULES: dict[str, Any] = {"fieldKeys": [], "patterns": [], "keyPatterns": []}


def _load_rules(path: Path | None = None) -> dict[str, Any]:
    if path is not None:
        try:
            data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
            return data
        except (OSError, json.JSONDecodeError):
            return _EMPTY_RULES

    try:
        data = json.loads(
            resources.files(__package__)
            .joinpath("redaction-rules.json")
            .read_text(encoding="utf-8")
        )
    except (FileNotFoundError, ModuleNotFoundError, json.JSONDecodeError) as exc:
        repo_schema = Path(__file__).parents[4] / "schemas" / "redaction-rules.json"
        if repo_schema.exists():
            return _load_rules(repo_schema)
        raise RuntimeError("Bundled redaction rules are missing or invalid") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Bundled redaction rules must be a JSON object")
    return data


_RULES = _load_rules()


def _rules_patterns(rules: dict[str, Any]) -> list[dict[str, str]]:
    return [
        *rules.get("hipaa18Extensions", []),
        *rules.get("patterns", []),
    ]


_FIELD_KEYS: frozenset[str] = frozenset(k.lower() for k in _RULES.get("fieldKeys", []))
_COMPILED_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r["pattern"]), r["replacement"])
    for r in _rules_patterns(_RULES)
]
_KEY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r["pattern"]), r["replacement"])
    for r in _RULES.get("keyPatterns", [])
]


def redact(value: object, rules: dict[str, Any] | None = None) -> object:
    """Recursively redact PII from value using default or custom rules."""
    if rules is not None:
        field_keys = frozenset(k.lower() for k in rules.get("fieldKeys", []))
        compiled = [
            (re.compile(r["pattern"]), r["replacement"])
            for r in _rules_patterns(rules)
        ]
        key_patterns = [
            (re.compile(r["pattern"]), r["replacement"])
            for r in rules.get("keyPatterns", [])
        ]
    else:
        field_keys = _FIELD_KEYS
        compiled = _COMPILED_PATTERNS
        key_patterns = _KEY_PATTERNS

    return _redact_value(value, field_keys, compiled, key_patterns)


def _redact_value(
    value: object,
    field_keys: frozenset[str],
    patterns: list[tuple[re.Pattern[str], str]],
    key_patterns: list[tuple[re.Pattern[str], str]],
) -> object:
    if isinstance(value, str):
        return _apply_patterns(value, patterns)
    if isinstance(value, dict):
        return {
            k: _redact_field(k, v, field_keys, patterns, key_patterns)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        redacted = [_redact_value(item, field_keys, patterns, key_patterns) for item in value]
        return type(value)(redacted)
    return value


def _redact_field(
    key: str,
    value: object,
    field_keys: frozenset[str],
    patterns: list[tuple[re.Pattern[str], str]],
    key_patterns: list[tuple[re.Pattern[str], str]],
) -> object:
    if key.lower() in field_keys:
        return "[redacted]"
    for kp, replacement in key_patterns:
        if kp.search(key):
            return replacement
    return _redact_value(value, field_keys, patterns, key_patterns)


def _apply_patterns(text: str, patterns: list[tuple[re.Pattern[str], str]]) -> str:
    for pattern, replacement in patterns:
        text = pattern.sub(replacement, text)
    return text

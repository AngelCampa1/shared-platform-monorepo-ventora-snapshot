#!/usr/bin/env python3
"""Run bundled regression evals for the third-grade-copy skill."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from evaluate_copy import evaluate


ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "evals" / "cases.json"


def main() -> int:
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    failures = []

    for case in cases:
        result = evaluate(
            case["copy"],
            case.get("required_terms", []),
            case.get("allowed_terms", []),
            case.get("cta", False),
            case.get("headline", False),
            case.get("source"),
        )
        passed = result["pass"] == case["should_pass"]
        for expected_hint in case.get("expected_hints", []):
            if expected_hint not in " ".join(finding.get("hint", "") for finding in result["findings"]):
                passed = False
                result.setdefault("hint_failures", []).append(expected_hint)
        for expected_message in case.get("expected_messages", []):
            if expected_message not in " ".join(finding.get("message", "") for finding in result["findings"]):
                passed = False
                result.setdefault("message_failures", []).append(expected_message)
        for absent_message in case.get("expected_absent_messages", []):
            if absent_message in " ".join(finding.get("message", "") for finding in result["findings"]):
                passed = False
                result.setdefault("unexpected_messages", []).append(absent_message)
        if "expected_suggestion" in case and result.get("suggestion") != case["expected_suggestion"]:
            passed = False
            result.setdefault("suggestion_failure", {"expected": case["expected_suggestion"], "actual": result.get("suggestion")})
        status = "PASS" if passed else "FAIL"
        print(f"{status} {case['name']}")
        if not passed:
            failures.append({"case": case["name"], "expected": case["should_pass"], "result": result})

    if failures:
        print(json.dumps(failures, indent=2))
        return 1

    print(f"All {len(cases)} evals passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

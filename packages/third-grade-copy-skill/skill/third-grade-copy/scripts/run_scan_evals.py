#!/usr/bin/env python3
"""Run scanner evals for the third-grade-copy skill."""

from __future__ import annotations

import sys
from pathlib import Path

from scan_copy import find_config, iter_files, load_config, render_github_annotations, render_markdown, render_sarif, scan_file
from evaluate_copy import evaluate


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "evals" / "fixtures"


def main() -> int:
    failures = []
    candidates = []
    for path in iter_files(FIXTURES):
        candidates.extend(scan_file(path))

    copies = {candidate["copy"]: candidate for candidate in candidates}
    expected_present = [
        "Our comprehensive platform helps teams optimize workflows",
        "See every deal in one place. Know what needs work.",
        "Get guaranteed results in one day.",
        "Learn more",
        "More details",
        "Start free trial",
        "Unlock faster sales",
        "Close deals faster without busy work",
        "Our comprehensive platform helps teams optimize workflows across every deal.",
        "Streamline workflows.",
        "Unlock faster onboarding",
        "Our comprehensive platform helps teams optimize workflows from signup to launch.",
        "Everything you need to work smarter",
        "Use simple reports to see every account that needs work.",
        "Unlock faster renewals",
        "Our comprehensive platform helps teams optimize workflows across every account.",
        "Start free audit",
    ]
    expected_absent = ["https://example.com/pricing", "https://example.com/renewals", "text-sm font-bold", "true"]
    skipped_noise = [
        "node_modules/@humanwhocodes/config-array",
        'c.get("accessEmail")',
        "Internal customer hub + wall of fame for the Ventora product portfolio.",
        "concurrently --kill-others",
        "AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG",
        "verify-media mutates verifier rows",
        "approved customer testimonial appears in the wall-grid preview shadow DOM",
        "Wall of Fame",
        "bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500",
        "business_unit_id must be a valid Trustpilot review path segment",
        "Mozilla/5.0 (compatible; VentoraCRM/1.0; +https://ventora.app) RSS reader",
        "SELECT * FROM testimonials WHERE id = ?",
        "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "const value = await getConfig()",
        "Our comprehensive platform helps teams optimize workflows.",
        "Everything you need to work smarter.",
        "Ignore metadata title",
        "Ignore frontmatter copy",
        "Our comprehensive platform helps teams optimize workflows in code fences.",
    ]

    for copy in expected_present:
        if copy not in copies:
            failures.append(f"missing candidate: {copy}")

    for copy in expected_absent:
        if copy in copies:
            failures.append(f"unexpected candidate: {copy}")

    for copy in skipped_noise:
        if copy in copies:
            failures.append(f"skipped noise was scanned: {copy}")

    bad = copies.get("Our comprehensive platform helps teams optimize workflows")
    if bad:
        result = evaluate(bad["copy"], [], [], bad["cta"], bad["headline"])
        if result["pass"]:
            failures.append("jargon fixture unexpectedly passed")

    plural_jargon = copies.get("Streamline workflows.")
    if plural_jargon:
        result = evaluate(plural_jargon["copy"], [], [], plural_jargon["cta"], plural_jargon["headline"])
        if result.get("suggestion") != "Make work faster.":
            failures.append("plural jargon fixture missing clean suggestion")

    long_scope = copies.get("Our comprehensive platform helps teams optimize workflows from signup to launch.")
    if long_scope:
        result = evaluate(long_scope["copy"], [], [], long_scope["cta"], long_scope["headline"])
        if result.get("suggestion") != "Our complete tool helps teams save time on busy work. Use it from signup to launch.":
            failures.append("long scope fixture missing split suggestion")

    risky = copies.get("Get guaranteed results in one day.")
    if risky:
        result = evaluate(risky["copy"], [], [], risky["cta"], risky["headline"])
        if result["pass"]:
            failures.append("risky claim fixture unexpectedly passed")
        if not any("Risky absolute claims found" in finding["message"] for finding in result["findings"]):
            failures.append("risky claim fixture missing risky claim finding")

    cta = copies.get("More details")
    if cta:
        result = evaluate(cta["copy"], [], [], True, cta["headline"])
        if result["pass"]:
            failures.append("weak CTA fixture unexpectedly passed")
        if "Start with a verb" not in " ".join(finding.get("hint", "") for finding in result["findings"]):
            failures.append("weak CTA fixture missing action hint")
        if result.get("suggestion") != "See more details":
            failures.append("weak CTA fixture missing suggestion")

    generic_cta = copies.get("Learn more")
    if generic_cta:
        result = evaluate(generic_cta["copy"], [], [], generic_cta["cta"], generic_cta["headline"])
        if result["pass"]:
            failures.append("generic CTA fixture unexpectedly passed")
        if not any("Generic CTA found" in finding["message"] for finding in result["findings"]):
            failures.append("generic CTA fixture missing generic CTA finding")
        if result.get("suggestion") != "See details":
            failures.append("generic CTA fixture missing suggestion")

    trial_cta = copies.get("Start free trial")
    if trial_cta:
        if not trial_cta["cta"]:
            failures.append("trial CTA fixture was not classified as CTA")
        result = evaluate(trial_cta["copy"], [], [], trial_cta["cta"], trial_cta["headline"])
        if not result["pass"]:
            failures.append("trial CTA fixture unexpectedly failed")

    warning = copies.get("Save time while your team sees every open deal today.")
    if warning:
        result = evaluate(warning["copy"], [], [], warning["cta"], warning["headline"])
        if not result["pass"]:
            failures.append("warning fixture unexpectedly failed")
        if not any(finding["severity"] == "warn" for finding in result["findings"]):
            failures.append("warning fixture did not produce a warning")

    mdx_heading = copies.get("Unlock faster onboarding")
    if mdx_heading:
        if not mdx_heading["headline"]:
            failures.append("MDX heading was not classified as headline")
        result = evaluate(mdx_heading["copy"], [], [], mdx_heading["cta"], mdx_heading["headline"])
        if result["pass"]:
            failures.append("MDX filler heading unexpectedly passed")

    yaml_heading = copies.get("Unlock faster renewals")
    if yaml_heading:
        if not yaml_heading["headline"]:
            failures.append("YAML headline was not classified as headline")

    yaml_cta = copies.get("Start free audit")
    if yaml_cta:
        if not yaml_cta["cta"]:
            failures.append("YAML CTA was not classified as CTA")

    sample_report = render_markdown(
        {
            "checked": 1,
            "failure_count": 1,
            "fail_on_warnings": True,
            "warning_count": 1,
            "failures": [
                {
                    "path": "sample.tsx",
                    "line": 12,
                    "copy": "More details",
                    "result": evaluate("More details", [], [], True, False),
                }
            ],
            "warnings": [
                {
                    "path": "sample.tsx",
                    "line": 15,
                    "copy": "Save time while your team sees every open deal today.",
                    "result": evaluate("Save time while your team sees every open deal today.", [], [], False, False),
                }
            ],
        }
    )
    for expected in ["# Third-grade copy scan", "## `sample.tsx`", "Suggested first pass:", "> See more details", "- Warning-only strings: 1", "- Fail on warnings: yes", "### Warning on line 15"]:
        if expected not in sample_report:
            failures.append(f"markdown report missing: {expected}")

    sample_sarif = render_sarif(
        {
            "checked": 1,
            "failure_count": 1,
            "fail_on_warnings": False,
            "warning_count": 0,
            "failures": [
                {
                    "path": "sample.tsx",
                    "line": 12,
                    "key": "cta",
                    "copy": "More details",
                    "result": evaluate("More details", [], [], True, False),
                }
            ],
            "warnings": [],
        }
    )
    sarif_result = sample_sarif["runs"][0]["results"][0]
    sarif_rules = sample_sarif["runs"][0]["tool"]["driver"]["rules"]
    if sample_sarif.get("version") != "2.1.0":
        failures.append("SARIF version missing or wrong")
    if sarif_result["level"] != "error":
        failures.append("SARIF failure was not marked as error")
    if sarif_result["locations"][0]["physicalLocation"]["artifactLocation"]["uri"] != "sample.tsx":
        failures.append("SARIF location uri missing")
    if sarif_result["properties"]["copy"] != "More details":
        failures.append("SARIF copy property missing")
    if not sarif_rules or sarif_rules[0]["id"] != sarif_result["ruleId"]:
        failures.append("SARIF rule metadata missing")
    if sarif_rules[0]["defaultConfiguration"]["level"] != "error":
        failures.append("SARIF rule default level missing")

    sample_annotations = render_github_annotations(
        {
            "checked": 1,
            "failure_count": 1,
            "fail_on_warnings": False,
            "warning_count": 1,
            "failures": [
                {
                    "path": "sample\\path,name.tsx",
                    "line": 12,
                    "key": "cta",
                    "copy": "More details",
                    "result": evaluate("More details", [], [], True, False),
                }
            ],
            "warnings": [
                {
                    "path": "warn.tsx",
                    "line": 15,
                    "key": "",
                    "copy": "Save time while your team sees every open deal today.",
                    "result": evaluate("Save time while your team sees every open deal today.", [], [], False, False),
                }
            ],
        }
    )
    for expected in ["::error file=sample/path%2Cname.tsx,line=12,title=Third-grade copy::", "::warning file=warn.tsx,line=15,title=Third-grade copy::", "Use a clear action verb. Hint%3A Start with a verb"]:
        if expected not in sample_annotations:
            failures.append(f"GitHub annotation missing: {expected}")

    config_path = find_config(FIXTURES)
    if config_path != FIXTURES / "third-grade-copy.json":
        failures.append("default config discovery did not find fixture config")

    config = load_config(config_path)
    config_candidate = scan_file(FIXTURES / "config-copy.json", config=config)
    config_copies = {candidate["copy"]: candidate for candidate in config_candidate}
    if "Implementation starts today." not in config_copies:
        failures.append("config copy key did not force candidate")
    if "More details" not in config_copies or not config_copies["More details"]["cta"]:
        failures.append("config CTA key did not classify candidate")
    if "Unlock faster sales" not in config_copies or not config_copies["Unlock faster sales"]["headline"]:
        failures.append("config headline key did not classify candidate")
    if evaluate("Implementation starts today.", [], config["allowed_terms"])["pass"] is not True:
        failures.append("config allowed term did not pass evaluator")
    configured_files = [path.name for path in iter_files(FIXTURES, config=config)]
    if "skip-me.json" in configured_files:
        failures.append("config skip_files did not exclude fixture file")
    strict_config = load_config(FIXTURES / "strict-config.json")
    if strict_config.get("fail_on_warnings") is not True:
        failures.append("config fail_on_warnings did not load as true")

    try:
        load_config(FIXTURES / "invalid-config.json")
        failures.append("invalid config unexpectedly loaded")
    except ValueError as error:
        message = str(error)
        for expected in ["unknown key 'mystery'", "'allowed_terms' must be a list", "'include_docs' must be true or false", "'extensions' entries must start with '.'"]:
            if expected not in message:
                failures.append(f"invalid config error missing: {expected}")

    if failures:
        print("\n".join(failures))
        return 1

    print(f"Scanner evals passed with {len(candidates)} candidates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

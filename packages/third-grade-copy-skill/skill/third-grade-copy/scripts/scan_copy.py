#!/usr/bin/env python3
"""Scan source files for likely marketing copy and evaluate visible strings."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from evaluate_copy import evaluate


DEFAULT_EXTENSIONS = {".astro", ".html", ".jsx", ".json", ".md", ".mdx", ".svelte", ".ts", ".tsx", ".vue", ".yaml", ".yml"}
DEFAULT_CONFIG_NAMES = ("third-grade-copy.json", ".third-grade-copy.json")
SKIP_DIRS = {
    ".git",
    ".next",
    ".turbo",
    "__tests__",
    "build",
    "connectors",
    "cron",
    "db",
    "database",
    "coverage",
    "dist",
    "migrations",
    "node_modules",
    "scripts",
    "server",
    "test",
    "tests",
    "vendor",
}
DOC_DIRS = {"doc", "docs"}
SKIP_FILES = {
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "README.mdx",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
}
SKIP_KEYS = {
    "class",
    "classname",
    "href",
    "id",
    "key",
    "name",
    "rel",
    "role",
    "src",
    "style",
    "target",
    "type",
    "accept",
    "authorization",
    "cookie",
    "error",
    "user-agent",
}
CTA_KEYS = {"cta", "button", "buttonText", "linkText"}
HEADLINE_KEYS = {"headline", "heading", "heroTitle", "subtitle", "subhead", "title"}
CTA_KEYS_LOWER = {item.lower() for item in CTA_KEYS}
HEADLINE_KEYS_LOWER = {item.lower() for item in HEADLINE_KEYS}
CTA_LABELS = {
    "book a call",
    "book a demo",
    "buy now",
    "continue setup",
    "get started",
    "get the guide",
    "join free",
    "learn more",
    "more details",
    "read the guide",
    "save my spot",
    "see plans",
    "send message",
    "start free",
    "start free trial",
    "try free",
    "try for free",
    "view pricing",
}
MARKETING_HINTS = re.compile(
    r"\b("
    r"accelerate|best|book|buy|close|demo|discover|easy|everything you need|"
    r"details|fast|faster|free|get|grow|launch|learn more|more details|optimize|powerful|pricing|"
    r"save|seamless|see|start|streamline|try|unlock|upgrade|work smarter"
    r")\b",
    re.IGNORECASE,
)
STRING_PATTERN = re.compile(
    r"(?P<prefix>[A-Za-z0-9_-]+\s*[:=]\s*)?(?P<quote>['\"`])(?P<value>(?:\\.|(?!\2).)*?)(?P=quote)",
    re.DOTALL,
)
HTML_TEXT_PATTERN = re.compile(r">(?P<value>[^<>{}]{3,240})<", re.DOTALL)
YAML_VALUE_PATTERN = re.compile(r"^\s*(?P<key>[A-Za-z0-9_-]+)\s*:\s*(?P<value>[^#\n][^\n]*)$")
IGNORE_MARKER = "third-grade-copy-ignore"
CONFIG_LIST_KEYS = {
    "allowed_terms",
    "copy_keys",
    "cta_keys",
    "extensions",
    "headline_keys",
    "required_terms",
    "skip_dirs",
    "skip_files",
    "skip_keys",
}
CONFIG_BOOL_KEYS = {"fail_on_warnings", "include_docs"}


def find_config(scan_path: Path, explicit_path: str | None = None) -> Path | None:
    if explicit_path:
        return Path(explicit_path)
    root = scan_path.parent if scan_path.is_file() else scan_path
    for name in DEFAULT_CONFIG_NAMES:
        candidate = root / name
        if candidate.is_file():
            return candidate
    return None


def load_config(path: str | Path | None) -> dict:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    return validate_config(config, Path(path))


def validate_config(config: object, path: Path) -> dict:
    if not isinstance(config, dict):
        raise ValueError(f"{path}: config must be a JSON object.")

    errors = []
    known_keys = CONFIG_LIST_KEYS | CONFIG_BOOL_KEYS
    for key in sorted(set(config) - known_keys):
        errors.append(f"unknown key '{key}'")

    for key in sorted(CONFIG_LIST_KEYS & set(config)):
        value = config[key]
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            errors.append(f"'{key}' must be a list of non-empty strings")

    for key in sorted(CONFIG_BOOL_KEYS & set(config)):
        if not isinstance(config[key], bool):
            errors.append(f"'{key}' must be true or false")

    extensions = config.get("extensions", [])
    if isinstance(extensions, list):
        bad_extensions = [item for item in extensions if isinstance(item, str) and not item.startswith(".")]
        if bad_extensions:
            errors.append("'extensions' entries must start with '.'")

    if errors:
        raise ValueError(f"{path}: invalid config: " + "; ".join(errors) + ".")

    return config


def iter_files(root: Path, include_docs: bool = False, config: dict | None = None) -> list[Path]:
    config = config or {}
    skip_dirs = SKIP_DIRS | set(config.get("skip_dirs", []))
    skip_files = SKIP_FILES | set(config.get("skip_files", []))
    extensions = DEFAULT_EXTENSIONS | set(config.get("extensions", []))
    include_docs = include_docs or bool(config.get("include_docs", False))

    if root.is_file():
        return [] if root.name in skip_files or ".test." in root.name or ".spec." in root.name else [root]
    files: list[Path] = []
    for path in root.rglob("*"):
        if any(part in skip_dirs for part in path.parts):
            continue
        if not include_docs and any(part in DOC_DIRS for part in path.parts):
            continue
        if (
            path.is_file()
            and path.name not in skip_files
            and ".test." not in path.name
            and ".spec." not in path.name
            and path.suffix.lower() in extensions
        ):
            files.append(path)
    return files


def clean_value(value: str) -> str:
    value = value.replace("\\n", " ").replace("\\'", "'").replace('\\"', '"')
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def clean_markdown(value: str) -> str:
    value = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"^[#>*\-\d.\s]+", "", value)
    value = value.replace("**", "").replace("__", "").replace("*", "").replace("_", "")
    return clean_value(value)


def markdown_candidates(text: str) -> list[tuple[int, str, str]]:
    candidates: list[tuple[int, str, str]] = []
    in_fence = False
    in_frontmatter = False
    paragraph: list[str] = []
    paragraph_line = 0

    def flush() -> None:
        nonlocal paragraph, paragraph_line
        if paragraph:
            candidates.append((paragraph_line, "", clean_markdown(" ".join(paragraph))))
            paragraph = []
            paragraph_line = 0

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if line_number == 1 and stripped == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            continue
        if stripped.startswith("```") or stripped.startswith("~~~"):
            flush()
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not stripped or stripped.startswith(("import ", "export ", "{", "}", "<")):
            flush()
            continue
        if re.match(r"^\|.*\|$", stripped):
            flush()
            continue
        if re.match(r"^\s{4,}", raw_line):
            flush()
            continue
        heading = re.match(r"^\s*#{1,6}\s+", raw_line)
        if heading:
            flush()
            candidates.append((line_number, "heading", clean_markdown(stripped)))
            continue
        if re.match(r"^\s*([-*]\s+|\d+\.\s+|>\s+)", raw_line):
            flush()
            candidates.append((line_number, "", clean_markdown(stripped)))
            continue
        if not paragraph:
            paragraph_line = line_number
        paragraph.append(stripped)

    flush()
    return [(line, key, value) for line, key, value in candidates if value]


def yaml_candidates(text: str) -> list[tuple[int, str, str]]:
    candidates: list[tuple[int, str, str]] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        match = YAML_VALUE_PATTERN.match(raw_line)
        if not match:
            continue
        key = match.group("key")
        value = match.group("value").strip()
        if not value or value[0] in {'"', "'", "|", ">", "{", "["}:
            continue
        if value.lower() in {"true", "false", "null"} or re.fullmatch(r"-?\d+(?:\.\d+)?", value):
            continue
        candidates.append((line_number, key, clean_value(value)))
    return candidates


def key_from_prefix(prefix: str | None) -> str:
    if not prefix:
        return ""
    return re.sub(r"[^A-Za-z0-9_-]", "", prefix)


def key_from_context(text: str, start: int) -> str:
    before = text[max(0, start - 120) : start]
    match = re.search(r"['\"]([A-Za-z0-9_-]+)['\"]\s*:\s*$", before)
    return match.group(1) if match else ""


def ignored_lines(text: str) -> set[int]:
    ignored: set[int] = set()
    lines = text.splitlines()
    for index, line in enumerate(lines, start=1):
        if IGNORE_MARKER in line:
            ignored.add(index)
            if "next-line" in line:
                ignored.add(index + 1)
    return ignored


def is_probably_copy(value: str, key: str, config: dict | None = None) -> bool:
    config = config or {}
    skip_keys = SKIP_KEYS | {key.lower() for key in config.get("skip_keys", [])}
    force_keys = {key.lower() for key in config.get("copy_keys", [])}

    if not value or len(value) < 3 or len(value) > 240:
        return False
    if key.lower() in skip_keys:
        return False
    if "_" in value:
        return False
    if re.search(r"\b(bg|text|hover|focus|ring|border|rounded|shadow|grid|flex|items|justify|px|py|mt|mb|gap)-", value):
        return False
    upper = value.upper()
    if re.search(r"\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|VALUES)\b", upper):
        return False
    if re.search(r"\b(application|text)/(json|xml|html|rss|atom|xhtml)", value, re.IGNORECASE):
        return False
    if value.startswith(("Mozilla/", "sha256-", "sha512-")):
        return False
    if re.search(r"[(){};=]{2,}", value) and not re.search(r"[.!?]\s+[A-Z]", value):
        return False
    if re.search(r"\b(await|const|let|return|RegExp|expect|locator|toBe)\b", value):
        return False
    if re.fullmatch(r"[A-Za-z0-9_./:#?&=% -]+", value) and (" " not in value) and ("/" in value or "." in value or "#" in value):
        return False
    if "{" in value or "}" in value or value.startswith(("http", "/", "#", "data:")):
        return False
    word_count = len(re.findall(r"[A-Za-z$0-9]+", value))
    if word_count < 2:
        return False
    if key.lower() in force_keys or key.lower() in CTA_KEYS_LOWER or key.lower() in HEADLINE_KEYS_LOWER:
        return True
    return bool(MARKETING_HINTS.search(value)) or word_count >= 5


def classify(key: str, value: str, config: dict | None = None) -> tuple[bool, bool]:
    config = config or {}
    cta_keys = CTA_KEYS_LOWER | {key.lower() for key in config.get("cta_keys", [])}
    headline_keys = HEADLINE_KEYS_LOWER | {key.lower() for key in config.get("headline_keys", [])}
    lower_key = key.lower()
    lower_value = re.sub(r"\s+", " ", value.strip().strip(".!?").lower())
    cta = lower_key in cta_keys or lower_value in CTA_LABELS
    headline = lower_key in headline_keys
    return cta, headline


def scan_file(path: Path, config: dict | None = None) -> list[dict]:
    config = config or {}
    skip_files = SKIP_FILES | set(config.get("skip_files", []))
    if path.name in skip_files:
        return []

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="ignore")

    candidates: list[dict] = []
    seen: set[tuple[int, str]] = set()
    ignored = ignored_lines(text)
    for match in STRING_PATTERN.finditer(text):
        value = clean_value(match.group("value"))
        key = key_from_prefix(match.group("prefix")) or key_from_context(text, match.start())
        if is_probably_copy(value, key, config):
            cta, headline = classify(key, value, config)
            line = text.count("\n", 0, match.start()) + 1
            if line in ignored:
                continue
            marker = (line, value)
            if marker not in seen:
                seen.add(marker)
                candidates.append({"path": str(path), "line": line, "key": key, "copy": value, "cta": cta, "headline": headline})

    for match in HTML_TEXT_PATTERN.finditer(text):
        value = clean_value(match.group("value"))
        if is_probably_copy(value, "", config):
            line = text.count("\n", 0, match.start()) + 1
            if line in ignored:
                continue
            cta, headline = classify("", value, config)
            marker = (line, value)
            if marker not in seen:
                seen.add(marker)
                candidates.append({"path": str(path), "line": line, "key": "", "copy": value, "cta": cta, "headline": headline})

    if path.suffix.lower() in {".md", ".mdx"}:
        for line, key, value in markdown_candidates(text):
            if line in ignored:
                continue
            if is_probably_copy(value, key, config):
                cta, headline = classify(key, value, config)
                marker = (line, value)
                if marker not in seen:
                    seen.add(marker)
                    candidates.append({"path": str(path), "line": line, "key": key, "copy": value, "cta": cta, "headline": headline})

    if path.suffix.lower() in {".yaml", ".yml"}:
        for line, key, value in yaml_candidates(text):
            if line in ignored:
                continue
            if is_probably_copy(value, key, config):
                cta, headline = classify(key, value, config)
                marker = (line, value)
                if marker not in seen:
                    seen.add(marker)
                    candidates.append({"path": str(path), "line": line, "key": key, "copy": value, "cta": cta, "headline": headline})

    return candidates


def render_markdown(output: dict) -> str:
    lines = [
        "# Third-grade copy scan",
        "",
        f"- Likely copy strings checked: {output['checked']}",
        f"- Failing strings: {output['failure_count']}",
        f"- Warning-only strings: {output.get('warning_count', 0)}",
        f"- Fail on warnings: {'yes' if output.get('fail_on_warnings') else 'no'}",
    ]
    if output.get("config"):
        lines.append(f"- Config: `{output['config']}`")
    lines.append("")
    if not output["failures"] and not output.get("warnings"):
        lines.append("No failing or warning-only copy found.")
        return "\n".join(lines)

    by_file: dict[str, list[dict]] = {}
    for issue in output["failures"] + output.get("warnings", []):
        by_file.setdefault(issue["path"], []).append(issue)

    for path, issues in by_file.items():
        lines.append(f"## `{path}`")
        lines.append("")
        for issue in issues:
            label = "Failure" if not issue["result"]["pass"] else "Warning"
            lines.append(f"### {label} on line {issue['line']}")
            lines.append("")
            lines.append(f"> {issue['copy']}")
            lines.append("")
            for item in issue["result"]["findings"]:
                lines.append(f"- **{item['severity'].upper()}**: {item['message']}")
                if item.get("hint"):
                    lines.append(f"  - Hint: {item['hint']}")
            if issue["result"].get("suggestion"):
                lines.append("")
                lines.append("Suggested first pass:")
                lines.append("")
                lines.append(f"> {issue['result']['suggestion']}")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_sarif(output: dict) -> dict:
    results = []
    rules: dict[str, dict] = {}
    for issue in output["failures"] + output.get("warnings", []):
        for finding in issue["result"]["findings"]:
            rule_id = re.sub(r"[^a-z0-9]+", "-", finding["message"].lower()).strip("-")[:80] or "copy-finding"
            message = finding["message"]
            if finding.get("hint"):
                message += " Hint: " + finding["hint"]
            rules.setdefault(
                rule_id,
                {
                    "id": rule_id,
                    "name": finding["message"].split(".")[0][:80],
                    "shortDescription": {"text": finding["message"]},
                    "fullDescription": {"text": finding.get("hint") or finding["message"]},
                    "defaultConfiguration": {"level": "error" if finding["severity"] == "fail" else "warning"},
                },
            )
            results.append(
                {
                    "ruleId": rule_id,
                    "level": "error" if finding["severity"] == "fail" else "warning",
                    "message": {"text": message},
                    "locations": [
                        {
                            "physicalLocation": {
                                "artifactLocation": {"uri": issue["path"].replace("\\", "/")},
                                "region": {"startLine": issue["line"]},
                            }
                        }
                    ],
                    "properties": {
                        "copy": issue["copy"],
                        "key": issue.get("key", ""),
                        "suggestion": issue["result"].get("suggestion", ""),
                    },
                }
            )
    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "third-grade-copy",
                        "informationUri": "https://platform.openai.com/docs/codex/skills",
                        "rules": list(rules.values()),
                    }
                },
                "results": results,
            }
        ],
    }


def github_escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(":", "%3A").replace(",", "%2C")


def render_github_annotations(output: dict) -> str:
    lines = []
    for issue in output["failures"] + output.get("warnings", []):
        command = "error" if not issue["result"]["pass"] else "warning"
        title = "Third-grade copy"
        for finding in issue["result"]["findings"]:
            message = finding["message"]
            if finding.get("hint"):
                message += " Hint: " + finding["hint"]
            path = issue["path"].replace("\\", "/")
            lines.append(
                f"::{command} file={github_escape(path)},line={issue['line']},title={github_escape(title)}::{github_escape(message)}"
            )
    return "\n".join(lines) + ("\n" if lines else "")


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan source files for likely marketing copy and evaluate it.")
    parser.add_argument("path", nargs="?", default=".", help="File or directory to scan.")
    parser.add_argument("--config", help="Optional JSON config for repo-specific scan rules.")
    parser.add_argument("--include-docs", action="store_true", help="Also scan docs/ and README files.")
    parser.add_argument("--include-warnings", action="store_true", help="Report warning-only copy without making the command fail.")
    parser.add_argument("--fail-on-warnings", action="store_true", help="Return a failing exit code when warning-only copy is found.")
    parser.add_argument("--suggest", action="store_true", help="Include conservative rewrite suggestions for failing copy.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    parser.add_argument("--markdown", action="store_true", help="Print a Markdown report.")
    parser.add_argument("--sarif", action="store_true", help="Print SARIF 2.1.0 output for code scanning tools.")
    parser.add_argument("--github-annotations", action="store_true", help="Print GitHub Actions workflow command annotations.")
    parser.add_argument("--max-findings", type=int, default=100, help="Maximum failing findings to print.")
    args = parser.parse_args()
    scan_path = Path(args.path)
    config_path = find_config(scan_path, args.config)
    try:
        config = load_config(config_path)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Config error: {error}", file=sys.stderr)
        return 2
    required_terms = config.get("required_terms", [])
    allowed_terms = config.get("allowed_terms", [])
    fail_on_warnings = args.fail_on_warnings or bool(config.get("fail_on_warnings", False))
    include_warnings = args.include_warnings or fail_on_warnings

    failures = []
    warnings = []
    checked = 0
    for path in iter_files(scan_path, include_docs=args.include_docs, config=config):
        for candidate in scan_file(path, config=config):
            checked += 1
            result = evaluate(candidate["copy"], required_terms, allowed_terms, candidate["cta"], candidate["headline"])
            if not args.suggest:
                result.pop("suggestion", None)
            if not result["pass"]:
                failures.append({**candidate, "result": result})
            elif include_warnings and result["findings"]:
                warnings.append({**candidate, "result": result})

    output = {
        "checked": checked,
        "config": str(config_path) if config_path else None,
        "failures": failures[: args.max_findings],
        "failure_count": len(failures),
        "fail_on_warnings": fail_on_warnings,
        "warnings": warnings[: args.max_findings],
        "warning_count": len(warnings),
    }
    if args.json:
        print(json.dumps(output, indent=2))
    elif args.sarif:
        print(json.dumps(render_sarif(output), indent=2))
    elif args.github_annotations:
        print(render_github_annotations(output), end="")
    elif args.markdown:
        print(render_markdown(output), end="")
    else:
        print(f"Checked {checked} likely copy strings. Failures: {len(failures)}. Warnings: {len(warnings)}")
        print(f"Fail on warnings: {'yes' if fail_on_warnings else 'no'}")
        if config_path:
            print(f"Config: {config_path}")
        for issue in failures[: args.max_findings] + warnings[: args.max_findings]:
            label = "FAIL" if not issue["result"]["pass"] else "WARN"
            print(f"{label} {issue['path']}:{issue['line']} {issue['copy']}")
            for item in issue["result"]["findings"]:
                print(f"  - {item['severity'].upper()}: {item['message']}")
                if item.get("hint"):
                    print(f"    Hint: {item['hint']}")
            if args.suggest and issue["result"].get("suggestion"):
                print(f"    Suggestion: {issue['result']['suggestion']}")

    return 1 if failures or (fail_on_warnings and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())

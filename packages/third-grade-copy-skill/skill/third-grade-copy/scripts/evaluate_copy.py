#!/usr/bin/env python3
"""Evaluate marketing copy against the third-grade-copy skill gates."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict


VAGUE_SUPERLATIVES = {
    "best",
    "easiest",
    "powerful",
    "seamless",
    "robust",
    "world-class",
    "cutting-edge",
    "game-changing",
    "all-in-one",
    "next-generation",
}

JARGON = {
    "accelerate",
    "actionable",
    "capabilities",
    "comprehensive",
    "cross-functional",
    "ecosystem",
    "elevate",
    "empower",
    "enhance",
    "frictionless",
    "holistic",
    "innovative",
    "intelligence",
    "leverage",
    "optimize",
    "operationalize",
    "platform",
    "scalable",
    "strategic",
    "streamline",
    "synergy",
    "transform",
    "visibility",
    "workflow",
}

JARGON_REPLACEMENTS = {
    "accelerate": "speed up",
    "actionable": "useful",
    "capabilities": "tools",
    "comprehensive": "complete",
    "cross-functional": "team",
    "ecosystem": "tools",
    "elevate": "improve",
    "empower": "help",
    "enhance": "improve",
    "frictionless": "easy",
    "holistic": "complete",
    "innovative": "new",
    "intelligence": "insight",
    "leverage": "use",
    "optimize": "make better",
    "operationalize": "put to work",
    "platform": "tool",
    "scalable": "can grow",
    "strategic": "planned",
    "streamline": "make faster",
    "synergy": "teamwork",
    "transform": "change",
    "visibility": "see more",
    "workflow": "work step",
}

PHRASE_REPLACEMENTS = {
    "enhance visibility": "see more",
    "empower teams": "help your team",
    "leverage insights": "use what you learn",
    "optimize workflows": "save time on busy work",
    "streamline operations": "make work faster",
    "streamline workflows": "make work faster",
}

VAGUE_CLAIMS = {
    "do more",
    "drive growth",
    "everything you need",
    "get results",
    "move faster",
    "save time and money",
    "work smarter",
}

VAGUE_CLAIM_HINTS = {
    "do more": "Say what task gets easier.",
    "drive growth": "Name the metric or result.",
    "everything you need": "List the one or two most useful things.",
    "get results": "Say what result the user gets.",
    "move faster": "Say what gets faster.",
    "save time and money": "Say how time or money is saved.",
    "work smarter": "Say what work gets easier.",
}

VAGUE_CLAIM_REPLACEMENTS = {
    "do more": "finish more work",
    "everything you need": "the tools you need",
    "get results": "get clear next steps",
    "move faster": "finish faster",
    "work smarter": "make work easier",
}

RISKY_CLAIMS = {
    "always",
    "guarantee",
    "guaranteed",
    "instant",
    "instantly",
    "never",
    "no risk",
    "risk-free",
    "zero risk",
}

CHILDISH_PHRASES = {
    "big helper",
    "easy peasy",
    "no worries",
    "super easy",
    "super simple",
}

CHILDISH_REPLACEMENTS = {
    "big helper": "useful tool",
    "easy peasy": "easy",
    "no worries": "you're all set",
    "super easy": "easy",
    "super simple": "simple",
}

PASSIVE_REPLACEMENTS = (
    (re.compile(r"\bYour ([A-Za-z][A-Za-z ]{0,60}?) (?:is|are) created\b", re.IGNORECASE), r"You create your \1"),
    (re.compile(r"\bYour ([A-Za-z][A-Za-z ]{0,60}?) (?:is|are) sent\b", re.IGNORECASE), r"You send your \1"),
    (re.compile(r"\bYour ([A-Za-z][A-Za-z ]{0,60}?) (?:is|are) shown\b", re.IGNORECASE), r"You see your \1"),
    (re.compile(r"\bYour ([A-Za-z][A-Za-z ]{0,60}?) (?:is|are) built\b", re.IGNORECASE), r"You build your \1"),
)

BAD_PUNCTUATION = {
    "\u2014": "em dash",
    "\u2013": "en dash",
    "\u201c": "curly quote",
    "\u201d": "curly quote",
    "\u2018": "curly quote",
    "\u2019": "curly quote",
}

CTA_VERBS = {
    "book",
    "build",
    "buy",
    "call",
    "create",
    "find",
    "get",
    "join",
    "learn",
    "continue",
    "save",
    "see",
    "send",
    "start",
    "try",
    "read",
    "view",
}

GENERIC_CTA_LABELS = {
    "click here",
    "continue",
    "learn more",
    "read more",
    "submit",
}

GENERIC_CTA_REPLACEMENTS = {
    "click here": "See details",
    "continue": "Continue setup",
    "learn more": "See details",
    "read more": "Read the guide",
    "submit": "Send it",
}

HEADLINE_FILLER_STARTS = {
    "introducing",
    "welcome",
    "discover",
    "unlock",
}

STACKED_CLAUSE_PATTERNS = (
    r"\bwhile\b",
    r"\bthrough\b",
    r"\bso that\b",
    r",\s*by\b",
)
PASSIVE_PATTERN = re.compile(
    r"\b(?:am|are|be|been|being|is|was|were)\s+(?:\w+\s+){0,2}\w+(?:ed|en)\b",
    re.IGNORECASE,
)

MONTH_PATTERN = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)

FACT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    + MONTH_PATTERN
    + r"\s+\d{1,2}(?:,\s*\d{4})?|[$€£¥]?\d[\d,]*(?:\.\d+)?%?|\d+\+|[A-Z]{2,}(?:\s+\d+)?)(?![A-Za-z0-9])",
)
FACT_QUALIFIERS = (
    "up to",
    "at least",
    "at most",
    "as low as",
    "start at",
    "starting at",
    "starts at",
    "less than",
    "more than",
    "no more than",
    "no less than",
    "before",
    "after",
    "by",
    "for",
    "from",
    "under",
    "over",
    "within",
)
SYMBOL_FACT_QUALIFIERS = (
    (r"<=\s*$", "at most"),
    (r">=\s*$", "at least"),
    (r"<\s*$", "less than"),
    (r">\s*$", "more than"),
)
POST_FACT_QUALIFIERS = (
    "or less",
    "or fewer",
    "or more",
    "or higher",
)
QUALIFIER_EQUIVALENTS = {
    "as low as": "starting at",
    "for": "starting at",
    "from": "starting at",
    "no less than": "at least",
    "no more than": "at most",
    "or fewer": "or less",
    "or higher": "or more",
    "over": "more than",
    "start at": "starting at",
    "starts at": "starting at",
    "under": "less than",
}
UNIT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?P<number>[$€£¥]?\d[\d,]*(?:\.\d+)?%?|\d+\+)\s+(?:(?:a|an|per)\s+)?(?P<unit>"
    r"accounts?|credits?|days?|deals?|emails?|files?|forms?|hours?|hrs?|invoices?|leads?|members?|messages?|"
    r"minutes?|mins?|months?|orders?|projects?|requests?|reviews?|seats?|seconds?|secs?|users?|weeks?|years?|yrs?"
    r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
MONEY_SYMBOL_PATTERN = re.compile(r"(?<![A-Za-z0-9])(?P<currency>[$€£¥])\s*(?P<amount>\d[\d,]*(?:\.\d+)?)(?![A-Za-z0-9])")
MONEY_WORD_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?P<amount>\d[\d,]*(?:\.\d+)?)\s+(?P<currency>dollars?|usd|euros?|eur|pounds?|gbp|yen|jpy)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
TIME_PATTERN = re.compile(
    r"\b(?P<hour>1[0-2]|0?[1-9])(?::(?P<minute>[0-5]\d))?\s*(?P<ampm>a\.?m\.?|p\.?m\.?)\s*(?P<zone>ET|PT|CT|MT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT)?\b",
    re.IGNORECASE,
)
CURRENCY_EQUIVALENTS = {
    "$": "usd",
    "dollar": "usd",
    "dollars": "usd",
    "usd": "usd",
    "€": "eur",
    "euro": "eur",
    "euros": "eur",
    "eur": "eur",
    "£": "gbp",
    "pound": "gbp",
    "pounds": "gbp",
    "gbp": "gbp",
    "¥": "jpy",
    "yen": "jpy",
    "jpy": "jpy",
}
RATING_PATTERNS = (
    re.compile(r"\b(?P<score>[1-5](?:\.\d+)?)\s*/\s*5\b", re.IGNORECASE),
    re.compile(r"\b(?P<score>[1-5](?:\.\d+)?)\s+out\s+of\s+5\b", re.IGNORECASE),
    re.compile(r"\b(?P<score>[1-5](?:\.\d+)?)\s*(?:-|\s)?stars?\b", re.IGNORECASE),
    re.compile(r"\b(?P<score>[1-5](?:\.\d+)?)\s*(?:-|\s)?star\s+rating\b", re.IGNORECASE),
)
CONTACT_PATTERNS = (
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"\bhttps?://[^\s<>\")]+", re.IGNORECASE),
    re.compile(r"(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\d)"),
)
SOURCE_CODE_PATTERN = re.compile(r"(?<![A-Za-z0-9])(?=[A-Z0-9-]{4,24}\b)(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*(?![A-Za-z0-9])")
RANGE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?P<start>[$€£¥]?\d[\d,]*(?:\.\d+)?%?)\s*(?:-|to|through)\s*(?P<end>[$€£¥]?\d[\d,]*(?:\.\d+)?%?)(?:\s+(?P<unit>[A-Za-z]+))?",
    re.IGNORECASE,
)
BETWEEN_RANGE_PATTERN = re.compile(
    r"\bbetween\s+(?P<start>[$€£¥]?\d[\d,]*(?:\.\d+)?%?)\s+and\s+(?P<end>[$€£¥]?\d[\d,]*(?:\.\d+)?%?)(?:\s+(?P<unit>[A-Za-z]+))?",
    re.IGNORECASE,
)
MULTIPLIER_PATTERN = re.compile(
    r"\b(?P<number>\d+(?:\.\d+)?)\s*x\s+(?P<tail>(?:more\s+)?[A-Za-z]+)\b",
    re.IGNORECASE,
)
TIMES_MULTIPLIER_PATTERN = re.compile(
    r"\b(?P<number>\d+(?:\.\d+)?)\s+times\s+(?:as\s+)?(?P<tail>(?:more\s+)?[A-Za-z]+)\b",
    re.IGNORECASE,
)
WORD_MULTIPLIER_PATTERN = re.compile(
    r"\b(?P<number>twice|three\s+times|four\s+times|five\s+times)\s+(?:as\s+)?(?P<tail>(?:more\s+)?[A-Za-z]+)\b",
    re.IGNORECASE,
)
WORD_MULTIPLIERS = {
    "twice": "2",
    "three times": "3",
    "four times": "4",
    "five times": "5",
}
RANK_PATTERN = re.compile(
    r"(?:#|no\.?\s*|number\s+)(?P<rank>\d+|one|two|three|four|five)\b",
    re.IGNORECASE,
)
TOP_RANK_PATTERN = re.compile(
    r"\btop\s+(?P<rank>\d+|one|two|three|four|five)\b",
    re.IGNORECASE,
)
WORD_NUMBERS = {
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
}
MULTIPLIER_TAIL_EQUIVALENTS = {
    "fast": "faster",
    "quick": "faster",
}
UNIT_EQUIVALENTS = {
    "hrs": "hour",
    "mins": "minute",
    "secs": "second",
    "yrs": "year",
}
SOURCE_LIMIT_PATTERNS = {
    "cancel anytime": (
        r"\bcancel\s+any\s*time\b",
        r"\bcancel\s+whenever\s+you\s+want\b",
    ),
    "no contract": (
        r"\bno\s+(?:long[-\s]term\s+)?contracts?\b",
        r"\bwithout\s+(?:a\s+)?(?:long[-\s]term\s+)?contracts?\b",
    ),
    "no credit card": (
        r"\bno\s+credit\s+cards?\b",
        r"\bwithout\s+(?:a\s+)?credit\s+cards?\b",
    ),
    "no hidden fees": (
        r"\bno\s+hidden\s+fees?\b",
        r"\bwithout\s+hidden\s+fees?\b",
    ),
    "no setup fee": (
        r"\bno\s+setup\s+fees?\b",
        r"\bwithout\s+(?:a\s+)?setup\s+fees?\b",
    ),
}
SOURCE_CAVEAT_PATTERNS = {
    "beta": (
        r"\bbeta\b",
    ),
    "invite only": (
        r"\binvite[-\s]only\b",
        r"\bby\s+invite\s+only\b",
    ),
    "limited availability": (
        r"\blimited\s+availability\b",
        r"\bavailable\s+for\s+a\s+limited\s+time\b",
    ),
    "subject to approval": (
        r"\bsubject\s+to\s+approval\b",
        r"\bapproval\s+required\b",
    ),
    "terms apply": (
        r"\bterms\s+apply\b",
        r"\bterms\s+and\s+conditions\s+apply\b",
    ),
    "waitlist": (
        r"\bwait\s*list\b",
        r"\bjoin\s+the\s+wait\s*list\b",
    ),
}
BILLING_CADENCE_PATTERNS = {
    "annual billing": (
        r"\bbilled\s+(?:once\s+)?(?:a\s+year|yearly|annually)\b",
        r"\bannual(?:ly)?\s+billing\b",
        r"\bannual\s+plan\b",
        r"\byearly\s+plan\b",
    ),
    "monthly billing": (
        r"\bbilled\s+(?:each\s+month|monthly)\b",
        r"\bmonthly\s+billing\b",
        r"\bmonthly\s+plan\b",
    ),
}
OFFER_TERM_PATTERNS = {
    "free trial": (
        r"\bfree\s+trials?\b",
        r"\btrial\s+is\s+free\b",
        r"\btry\s+(?:it\s+)?for\s+free\b",
    ),
    "free plan": (
        r"\bfree\s+plans?\b",
        r"\bplan\s+is\s+free\b",
    ),
    "free forever": (
        r"\bfree\s+forever\b",
        r"\bforever\s+free\b",
    ),
}
TITLE_TERM_PATTERN = re.compile(r"\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,4}\b")
CONTEXT_TERM_PATTERN = re.compile(
    r"\b(?:with|for|from|to|in|on|into|using|via)\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3})\b"
)
COMMON_TITLE_STARTS = {
    "Add",
    "Book",
    "Build",
    "Close",
    "Connect",
    "Create",
    "Find",
    "Get",
    "Help",
    "Keep",
    "Know",
    "Learn",
    "Save",
    "See",
    "Send",
    "Start",
    "Track",
    "Try",
    "Use",
    "View",
}
COMMON_LONG_WORDS = {
    "everybody",
    "everyone",
    "everything",
    "something",
}
KNOWN_SOURCE_TERMS = {
    "airtable": "Airtable",
    "github": "GitHub",
    "google analytics": "Google Analytics",
    "hubspot": "HubSpot",
    "mailchimp": "Mailchimp",
    "notion": "Notion",
    "paypal": "PayPal",
    "quickbooks": "QuickBooks",
    "salesforce": "Salesforce",
    "shopify": "Shopify",
    "slack": "Slack",
    "stripe": "Stripe",
    "webflow": "Webflow",
    "wordpress": "WordPress",
    "zapier": "Zapier",
}


@dataclass
class Finding:
    severity: str
    message: str
    hint: str = ""


def replacement_hint(terms: list[str], replacements: dict[str, str]) -> str:
    pairs = []
    for term in terms:
        replacement = replacements.get(term.lower())
        if replacement:
            pairs.append(f"{term} -> {replacement}")
    if pairs:
        return "Try: " + "; ".join(pairs) + "."
    return ""


def replace_term_variants(text: str, term: str, replacement: str) -> str:
    variants = term_variants(term.lower())
    pattern = re.compile(r"(?<![A-Za-z0-9-])(" + "|".join(re.escape(variant) for variant in sorted(variants, key=len, reverse=True)) + r")(?![A-Za-z0-9-])", re.IGNORECASE)
    return pattern.sub(replacement, text)


def suggest_rewrite(text: str, cta: bool = False, headline: bool = False) -> str:
    suggestion = text.strip()
    for old, new in {
        "\u2014": ". ",
        "\u2013": "-",
        "\u201c": '"',
        "\u201d": '"',
        "\u2018": "'",
        "\u2019": "'",
        ";": ".",
    }.items():
        suggestion = suggestion.replace(old, new)

    for phrase, replacement in PHRASE_REPLACEMENTS.items():
        suggestion = re.sub(re.escape(phrase), replacement, suggestion, flags=re.IGNORECASE)

    for term, replacement in JARGON_REPLACEMENTS.items():
        suggestion = replace_term_variants(suggestion, term, replacement)

    for phrase, replacement in VAGUE_CLAIM_REPLACEMENTS.items():
        suggestion = re.sub(re.escape(phrase), replacement, suggestion, flags=re.IGNORECASE)

    for phrase, replacement in CHILDISH_REPLACEMENTS.items():
        suggestion = re.sub(re.escape(phrase), replacement, suggestion, flags=re.IGNORECASE)

    for pattern, replacement in PASSIVE_REPLACEMENTS:
        suggestion = pattern.sub(replacement, suggestion)

    words_list = words(suggestion)
    if headline and words_list and words_list[0].lower() in HEADLINE_FILLER_STARTS:
        suggestion = re.sub(r"^\s*" + re.escape(words_list[0]) + r"\s+", "", suggestion, flags=re.IGNORECASE)

    if cta:
        cta_label = normalize_label(suggestion)
        if cta_label in GENERIC_CTA_REPLACEMENTS:
            suggestion = GENERIC_CTA_REPLACEMENTS[cta_label]
        first = words(suggestion)
        if first and first[0].lower() not in CTA_VERBS:
            suggestion = "See " + suggestion[0].lower() + suggestion[1:]

    suggestion = re.sub(r"\s+", " ", suggestion).strip()
    suggestion = re.sub(r"\s+([.,!?])", r"\1", suggestion)
    suggestion = re.sub(r"\.\s*\.", ".", suggestion)
    suggestion = re.sub(
        r"(^|[.!?]\s+)([a-z])",
        lambda match: match.group(1) + match.group(2).upper(),
        suggestion,
    )
    suggestion = split_common_long_clause(suggestion)
    return suggestion


def split_common_long_clause(text: str) -> str:
    sentences = split_sentences(text)
    if len(sentences) != 1 or len(words(sentences[0])) <= 10:
        return text
    match = re.match(r"^(?P<main>.+?)\s+(?P<scope>from\s+[A-Za-z0-9$][^.!?]{1,80}\s+to\s+[A-Za-z0-9$][^.!?]{0,80})\.?$", text, re.IGNORECASE)
    if not match:
        return text
    main = match.group("main").strip()
    scope = match.group("scope").strip()
    if len(words(main)) > 10:
        return text
    return f"{main}. Use it {scope}."


def split_sentences(text: str) -> list[str]:
    cleaned = re.sub(r"\s+", " ", text.strip())
    if not cleaned:
        return []
    return [part.strip() for part in re.split(r"[.!?]+", cleaned) if part.strip()]


def words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9$]+(?:'[A-Za-z]+)?", text)


def normalize_label(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().strip(".!?").lower())


def count_syllables(word: str) -> int:
    word = re.sub(r"[^a-z]", "", word.lower())
    if not word:
        return 0
    groups = re.findall(r"[aeiouy]+", word)
    count = len(groups)
    if word.endswith("e") and count > 1:
        count -= 1
    return max(count, 1)


def flesch_kincaid_grade(text: str) -> float | None:
    sentence_count = len(split_sentences(text))
    word_list = words(text)
    word_count = len(word_list)
    if sentence_count == 0 or word_count == 0:
        return None
    syllables = sum(count_syllables(word) for word in word_list)
    return 0.39 * (word_count / sentence_count) + 11.8 * (syllables / word_count) - 15.59


def protected_term_words(terms: list[str]) -> set[str]:
    protected: set[str] = set()
    for term in terms:
        protected.update(word.lower() for word in words(term))
    return protected


def term_variants(term: str) -> set[str]:
    if " " in term:
        return {term}
    variants = {term}
    if term.endswith("y"):
        variants.add(term[:-1] + "ies")
    elif term.endswith(("s", "x", "ch", "sh")):
        variants.add(term + "es")
    else:
        variants.add(term + "s")
    if term.endswith("e"):
        variants.add(term[:-1] + "ing")
    else:
        variants.add(term + "ing")
    return variants


def term_hits(text: str, terms: set[str]) -> list[str]:
    lower = text.lower()
    hits = []
    for term in sorted(terms):
        variants = term_variants(term.lower())
        pattern = r"(?<![a-z0-9-])(" + "|".join(re.escape(variant) for variant in sorted(variants, key=len, reverse=True)) + r")(?![a-z0-9-])"
        if re.search(pattern, lower):
            hits.append(term)
    return hits


def phrase_hits(text: str, phrases: set[str]) -> list[str]:
    lower = text.lower()
    return [phrase for phrase in sorted(phrases) if phrase in lower]


def exact_phrase_hits(text: str, phrases: set[str]) -> list[str]:
    lower = text.lower()
    hits = []
    for phrase in sorted(phrases):
        pattern = r"(?<![a-z0-9-])" + re.escape(phrase.lower()) + r"(?![a-z0-9-])"
        if re.search(pattern, lower):
            hits.append(phrase)
    return hits


def strip_contacts(text: str) -> str:
    scrubbed = text
    for pattern in CONTACT_PATTERNS:
        scrubbed = pattern.sub(" ", scrubbed)
    return scrubbed


def extract_facts(text: str) -> list[str]:
    text = strip_contacts(text)
    facts = []
    for match in FACT_PATTERN.finditer(text):
        value = match.group(0).strip()
        if len(value) == 1 and value.isalpha():
            continue
        if value.lower() in {"am", "pm"}:
            continue
        facts.append(value)
    return sorted(set(facts), key=lambda item: (text.find(item), item))


def extract_fact_qualifiers(text: str) -> dict[str, list[str]]:
    text = strip_contacts(text)
    qualifiers: dict[str, list[str]] = {}
    lower_text = text.lower()
    for match in FACT_PATTERN.finditer(text):
        fact = match.group(0).strip()
        if len(fact) == 1 and fact.isalpha():
            continue
        context = lower_text[max(0, match.start() - 32) : match.start()]
        found = [qualifier for qualifier in FACT_QUALIFIERS if re.search(r"\b" + re.escape(qualifier) + r"\s+$", context)]
        found.extend(qualifier for pattern, qualifier in SYMBOL_FACT_QUALIFIERS if re.search(pattern, context))
        if found:
            qualifiers.setdefault(fact, [])
            qualifiers[fact].extend(item for item in found if item not in qualifiers[fact])
        after = lower_text[match.end() : min(len(lower_text), match.end() + 40)]
        post_found = [
            qualifier
            for qualifier in POST_FACT_QUALIFIERS
            if re.search(r"^(?:\s+[A-Za-z]+){0,2}\s+" + re.escape(qualifier) + r"\b", after)
        ]
        if post_found:
            qualifiers.setdefault(fact, [])
            qualifiers[fact].extend(item for item in post_found if item not in qualifiers[fact])
    return qualifiers


def canonical_qualifier(qualifier: str) -> str:
    return QUALIFIER_EQUIVALENTS.get(qualifier, qualifier)


def canonical_unit(unit: str) -> str:
    value = unit.lower()
    value = UNIT_EQUIVALENTS.get(value, value)
    if value.endswith("s") and value not in {"ss"}:
        value = value[:-1]
    return value


def display_unit(unit: str, start: str, end: str) -> str:
    value = canonical_unit(unit)
    if start != "1" or end != "1":
        value += "s"
    return value


def extract_number_units(text: str) -> dict[str, list[str]]:
    text = strip_contacts(text)
    units: dict[str, list[str]] = {}
    for match in UNIT_PATTERN.finditer(text):
        number = match.group("number")
        unit = canonical_unit(match.group("unit"))
        units.setdefault(number, [])
        if unit not in units[number]:
            units[number].append(unit)
    return units


def extract_ranges(text: str) -> list[str]:
    text = strip_contacts(text)
    ranges = []
    for pattern in (RANGE_PATTERN, BETWEEN_RANGE_PATTERN):
        for match in pattern.finditer(text):
            start = match.group("start")
            end = match.group("end")
            unit = match.group("unit") or ""
            if unit:
                unit = display_unit(unit, start, end)
            value = f"{start} to {end}" + (f" {unit}" if unit else "")
            if value not in ranges:
                ranges.append(value)
    return ranges


def canonical_amount(value: str) -> str:
    return value.replace(",", "").strip()


def canonical_currency(value: str) -> str:
    return CURRENCY_EQUIVALENTS[value.lower()]


def extract_money(text: str) -> dict[str, tuple[str, str]]:
    text = strip_contacts(text)
    money: dict[str, tuple[str, str]] = {}
    for match in MONEY_SYMBOL_PATTERN.finditer(text):
        display = match.group(0).replace(" ", "")
        money[display] = (canonical_amount(match.group("amount")), canonical_currency(match.group("currency")))
    for match in MONEY_WORD_PATTERN.finditer(text):
        display = match.group(0)
        money[display] = (canonical_amount(match.group("amount")), canonical_currency(match.group("currency")))
    return money


def extract_times(text: str) -> dict[str, tuple[str, str, str]]:
    times: dict[str, tuple[str, str, str]] = {}
    for match in TIME_PATTERN.finditer(text):
        hour = str(int(match.group("hour")))
        minute = match.group("minute") or "00"
        ampm = match.group("ampm").replace(".", "").lower()[0]
        zone = (match.group("zone") or "").upper()
        display = re.sub(r"\s+", " ", match.group(0).strip())
        times[display] = (hour, minute, ampm, zone)
    return times


def extract_ratings(text: str) -> dict[str, str]:
    ratings: dict[str, str] = {}
    for pattern in RATING_PATTERNS:
        for match in pattern.finditer(text):
            score = match.group("score")
            display = f"{score} stars" if "star" in match.group(0).lower() else f"{score} out of 5"
            ratings[display] = score
    return ratings


def canonical_contact(value: str) -> str:
    value = value.rstrip(".,!?")
    if "@" in value:
        return value.lower()
    if value.lower().startswith(("http://", "https://")):
        return value.rstrip("/").lower()
    digits = re.sub(r"\D", "", value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def extract_contacts(text: str) -> dict[str, str]:
    contacts: dict[str, str] = {}
    for pattern in CONTACT_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0).strip()
            contacts[value.rstrip(".,!?")] = canonical_contact(value)
    return contacts


def extract_source_codes(text: str) -> list[str]:
    text = strip_contacts(text)
    codes = []
    for match in SOURCE_CODE_PATTERN.finditer(text):
        code = match.group(0)
        if len(code.replace("-", "")) < 4:
            continue
        codes.append(code)
    return sorted(set(codes), key=lambda item: (text.find(item), item))


def extract_multipliers(text: str) -> list[str]:
    multipliers = []
    for pattern in (MULTIPLIER_PATTERN, TIMES_MULTIPLIER_PATTERN):
        for match in pattern.finditer(text):
            value = f"{match.group('number')}x {canonical_multiplier_tail(match.group('tail'))}"
            if value not in multipliers:
                multipliers.append(value)
    for match in WORD_MULTIPLIER_PATTERN.finditer(text):
        number = WORD_MULTIPLIERS[re.sub(r"\s+", " ", match.group("number").lower())]
        value = f"{number}x {canonical_multiplier_tail(match.group('tail'))}"
        if value not in multipliers:
            multipliers.append(value)
    return multipliers


def extract_ranks(text: str) -> list[str]:
    ranks = []
    for match in RANK_PATTERN.finditer(text):
        rank = canonical_number_word(match.group("rank"))
        value = f"#{rank}"
        if value not in ranks:
            ranks.append(value)
    for match in TOP_RANK_PATTERN.finditer(text):
        rank = canonical_number_word(match.group("rank"))
        value = f"top {rank}"
        if value not in ranks:
            ranks.append(value)
    return ranks


def rank_preserves_fact(fact: str, source_ranks: list[str], final_ranks: set[str]) -> bool:
    return any(rank.endswith(" " + fact) or rank.endswith(fact) for rank in source_ranks if rank in final_ranks)


def canonical_number_word(value: str) -> str:
    return WORD_NUMBERS.get(value.lower(), value)


def canonical_multiplier_tail(value: str) -> str:
    tail = re.sub(r"\s+", " ", value.lower()).strip()
    return MULTIPLIER_TAIL_EQUIVALENTS.get(tail, tail)


def extract_source_limits(text: str) -> list[str]:
    lower = text.lower()
    limits = []
    for label, patterns in SOURCE_LIMIT_PATTERNS.items():
        if any(re.search(pattern, lower) for pattern in patterns):
            limits.append(label)
    return limits


def extract_source_caveats(text: str) -> list[str]:
    lower = text.lower()
    caveats = []
    for label, patterns in SOURCE_CAVEAT_PATTERNS.items():
        if any(re.search(pattern, lower) for pattern in patterns):
            caveats.append(label)
    return caveats


def extract_billing_cadence(text: str) -> list[str]:
    lower = text.lower()
    cadences = []
    for label, patterns in BILLING_CADENCE_PATTERNS.items():
        if any(re.search(pattern, lower) for pattern in patterns):
            cadences.append(label)
    return cadences


def extract_offer_terms(text: str) -> list[str]:
    lower = text.lower()
    offers = []
    for label, patterns in OFFER_TERM_PATTERNS.items():
        if any(re.search(pattern, lower) for pattern in patterns):
            offers.append(label)
    return offers


def clean_source_term(term: str) -> str:
    parts = term.strip(" .,!?:;()[]{}").split()
    while parts and parts[0] in COMMON_TITLE_STARTS:
        parts.pop(0)
    return " ".join(parts)


def extract_source_terms(text: str) -> list[str]:
    terms = []
    for pattern in (TITLE_TERM_PATTERN, CONTEXT_TERM_PATTERN):
        for match in pattern.finditer(text):
            raw = match.group(1) if match.lastindex else match.group(0)
            term = clean_source_term(raw)
            if not term or term in COMMON_TITLE_STARTS:
                continue
            if term in extract_facts(term):
                continue
            terms.append(term)
    lower = text.lower()
    for term, display in KNOWN_SOURCE_TERMS.items():
        pattern = r"(?<![a-z0-9-])" + re.escape(term) + r"(?![a-z0-9-])"
        if re.search(pattern, lower):
            terms.append(display)
    return sorted(set(terms), key=lambda item: (text.find(item), item))


def is_allowed_value(value: str, allowed: set[str]) -> bool:
    lower_value = value.lower()
    return lower_value in allowed or any(lower_value in allowed_term for allowed_term in allowed)


def evaluate(
    text: str,
    required_terms: list[str],
    allowed_terms: list[str] | None = None,
    cta: bool = False,
    headline: bool = False,
    source_text: str | None = None,
) -> dict:
    sentences = split_sentences(text)
    sentence_lengths = [len(words(sentence)) for sentence in sentences]
    word_count = sum(sentence_lengths)
    avg_sentence_words = (word_count / len(sentences)) if sentences else 0
    max_sentence_words = max(sentence_lengths) if sentence_lengths else 0
    grade = flesch_kincaid_grade(text)
    findings: list[Finding] = []
    allowed = {term.lower() for term in (allowed_terms or [])}
    protected_words = protected_term_words(required_terms + (allowed_terms or []))

    if not text.strip():
        findings.append(Finding("fail", "Copy is empty.", "Add the shortest useful line that preserves the user's goal."))

    if avg_sentence_words > 10:
        findings.append(Finding("fail", f"Average sentence length is {avg_sentence_words:.1f} words. Target is 10 or less.", "Split the copy into shorter sentences with one idea each."))

    if max_sentence_words > 14:
        findings.append(Finding("fail", f"Longest sentence is {max_sentence_words} words. Target is 14 or less.", "Break the longest sentence at the main verb or before a connector."))

    if ";" in text:
        findings.append(Finding("fail", "Semicolon found. Split the sentence.", "Use a period or comma, or write two short sentences."))

    for char, label in BAD_PUNCTUATION.items():
        if char in text:
            findings.append(Finding("fail", f"{label.capitalize()} found. Use plain punctuation.", "Use straight quotes, commas, periods, or parentheses."))

    if cta:
        word_list = words(text)
        first = word_list[0].lower() if word_list else ""
        if first not in CTA_VERBS:
            findings.append(Finding("fail", f"CTA starts with '{first or '(empty)'}'. Use a clear action verb.", "Start with a verb like See, Get, Start, Try, Book, Save, or Find."))
        generic_label = normalize_label(text)
        if generic_label in GENERIC_CTA_LABELS and generic_label not in allowed:
            findings.append(Finding("fail", f"Generic CTA found: {generic_label}.", "Say what happens next, such as See plans, Book a demo, Get the guide, or Start free."))

    if headline:
        word_list = words(text)
        if len(word_list) > 8:
            findings.append(Finding("fail", f"Headline has {len(word_list)} words. Target is 8 or less.", "Cut setup words and lead with the user's outcome."))
        if word_list and word_list[0].lower() in HEADLINE_FILLER_STARTS:
            findings.append(Finding("fail", f"Headline starts with filler word '{word_list[0]}'. Lead with the user outcome.", "Remove the opener and start with the benefit."))

    if grade is not None and grade > 3.5 and word_count >= 20:
        findings.append(Finding("warn", f"Estimated Flesch-Kincaid grade is {grade:.1f}. Target is about 3 or lower.", "Use shorter words and split long sentences."))

    lower = text.lower()
    for pattern in STACKED_CLAUSE_PATTERNS:
        if re.search(pattern, lower):
            findings.append(Finding("warn", f"Possible stacked clause found: {pattern}", "Rewrite the clause as its own sentence."))

    passive_matches = sorted(set(match.group(0) for match in PASSIVE_PATTERN.finditer(text)))
    if passive_matches:
        findings.append(Finding("warn", "Possible passive voice found: " + ", ".join(passive_matches), "Name who does the action when you can."))

    hard_words = []
    for word in words(text):
        lower_word = word.lower().strip("$")
        if (
            len(lower_word) >= 9
            and count_syllables(lower_word) >= 4
            and not any(char.isdigit() for char in lower_word)
            and lower_word not in protected_words
            and lower_word not in allowed
            and lower_word not in COMMON_LONG_WORDS
        ):
            hard_words.append(word)
    if hard_words:
        findings.append(Finding("fail", "Hard words found: " + ", ".join(sorted(set(hard_words))), "Replace hard words with common words, or allow a required term and explain it nearby."))

    vague_hits = [term for term in term_hits(text, VAGUE_SUPERLATIVES) if term.lower() not in allowed]
    if vague_hits:
        findings.append(Finding("fail", "Vague superlatives found: " + ", ".join(vague_hits), "Replace hype with a concrete user result."))

    vague_claim_hits = [phrase for phrase in phrase_hits(text, VAGUE_CLAIMS) if phrase.lower() not in allowed]
    if vague_claim_hits:
        hints = [VAGUE_CLAIM_HINTS.get(phrase, "") for phrase in vague_claim_hits]
        findings.append(Finding("fail", "Vague claims found: " + ", ".join(vague_claim_hits), " ".join(hint for hint in hints if hint)))

    risky_claim_hits = [phrase for phrase in exact_phrase_hits(text, RISKY_CLAIMS) if phrase.lower() not in allowed]
    if risky_claim_hits:
        findings.append(Finding("fail", "Risky absolute claims found: " + ", ".join(risky_claim_hits), "Soften the claim or add proof and limits. Do not promise more than the product can prove."))

    jargon_hits = [term for term in term_hits(text, JARGON) if term.lower() not in allowed]
    if jargon_hits:
        findings.append(Finding("fail", "Possible jargon found: " + ", ".join(jargon_hits), replacement_hint(jargon_hits, JARGON_REPLACEMENTS)))

    childish_hits = [phrase for phrase in sorted(CHILDISH_PHRASES) if phrase in lower]
    if childish_hits:
        findings.append(Finding("fail", "Childish phrasing found: " + ", ".join(childish_hits), "Keep the copy plain, but use adult words and a calm tone."))

    missing = [term for term in required_terms if term not in text]
    if missing:
        findings.append(Finding("fail", "Required terms missing: " + ", ".join(missing), "Put the required term back, then explain it simply if needed."))

    if source_text is not None:
        source_facts = extract_facts(source_text)
        source_qualifiers = extract_fact_qualifiers(source_text)
        final_qualifiers = extract_fact_qualifiers(text)
        source_units = extract_number_units(source_text)
        final_units = extract_number_units(text)
        source_ranges = extract_ranges(source_text)
        final_ranges = set(extract_ranges(text))
        source_money = extract_money(source_text)
        final_money = set(extract_money(text).values())
        source_times = extract_times(source_text)
        final_times = set(extract_times(text).values())
        source_ratings = extract_ratings(source_text)
        final_rating_scores = set(extract_ratings(text).values())
        source_contacts = extract_contacts(source_text)
        final_contacts = set(extract_contacts(text).values())
        source_codes = extract_source_codes(source_text)
        final_codes = set(extract_source_codes(text))
        source_multipliers = extract_multipliers(source_text)
        final_multipliers = set(extract_multipliers(text))
        source_ranks = extract_ranks(source_text)
        final_ranks = set(extract_ranks(text))
        source_limits = extract_source_limits(source_text)
        final_limits = set(extract_source_limits(text))
        source_caveats = extract_source_caveats(source_text)
        final_caveats = set(extract_source_caveats(text))
        source_billing = extract_billing_cadence(source_text)
        final_billing = set(extract_billing_cadence(text))
        source_offers = extract_offer_terms(source_text)
        final_offers = set(extract_offer_terms(text))
        source_terms = extract_source_terms(source_text)
        final_facts = set(extract_facts(text))
        missing_facts = [
            fact
            for fact in source_facts
            if fact not in final_facts
            and not is_allowed_value(fact, allowed)
            and not (fact in source_money and source_money[fact] in final_money)
            and not any(fact.lower() in term.lower() for term in source_terms)
            and not rank_preserves_fact(fact, source_ranks, final_ranks)
        ]
        if missing_facts:
            findings.append(Finding("fail", "Source facts missing from final copy: " + ", ".join(missing_facts), "Restore the missing fact or intentionally allow it only if the source changed."))
        changed_qualifiers = []
        for fact, qualifiers in source_qualifiers.items():
            if fact in final_facts and not is_allowed_value(fact, allowed):
                final_canonical = {canonical_qualifier(qualifier) for qualifier in final_qualifiers.get(fact, [])}
                missing_qualifiers = [
                    qualifier
                    for qualifier in qualifiers
                    if canonical_qualifier(qualifier) not in final_canonical
                ]
                if missing_qualifiers:
                    formatted = [
                        f"{fact} {qualifier}" if qualifier.startswith("or ") else f"{qualifier} {fact}"
                        for qualifier in missing_qualifiers
                    ]
                    changed_qualifiers.append(" / ".join(formatted))
        if changed_qualifiers:
            findings.append(Finding("fail", "Source qualifiers missing from final copy: " + ", ".join(changed_qualifiers), "Keep words like up to, at least, less than, within, or less/or more, from, before, or after when they limit a claim."))
        changed_units = []
        for number, units in source_units.items():
            if number in final_facts and not is_allowed_value(number, allowed):
                final_number_units = set(final_units.get(number, []))
                missing_units = [unit for unit in units if unit not in final_number_units]
                if missing_units:
                    changed_units.append(number + " " + " / ".join(missing_units))
        if changed_units:
            findings.append(Finding("fail", "Source units missing or changed in final copy: " + ", ".join(changed_units), "Keep the unit with each number, such as minutes, days, users, seats, or months."))
        missing_ranges = [
            value
            for value in source_ranges
            if value not in final_ranges and not is_allowed_value(value, allowed)
        ]
        if missing_ranges:
            findings.append(Finding("fail", "Source ranges missing from final copy: " + ", ".join(missing_ranges), "Keep ranges like 5 to 10 users or 10% to 20% as ranges, not separate numbers."))
        missing_money = [
            display
            for display, canonical in source_money.items()
            if canonical not in final_money and not is_allowed_value(display, allowed)
        ]
        if missing_money:
            findings.append(Finding("fail", "Source money amounts missing or changed in final copy: " + ", ".join(missing_money), "Keep currency and amount together, such as $49, €99, or 99 euros, unless the source changed."))
        missing_times = [
            display
            for display, canonical in source_times.items()
            if canonical not in final_times and not is_allowed_value(display, allowed)
        ]
        if missing_times:
            findings.append(Finding("fail", "Source times missing or changed in final copy: " + ", ".join(missing_times), "Keep event times and time zones like 5 PM ET or 9:30 AM UTC unless the source changed."))
        missing_ratings = [
            display
            for display, score in source_ratings.items()
            if score not in final_rating_scores and not is_allowed_value(display, allowed)
        ]
        if missing_ratings:
            findings.append(Finding("fail", "Source ratings missing from final copy: " + ", ".join(missing_ratings), "Keep rating proof like 4.9 stars or 4.9 out of 5 unless the source changed."))
        missing_contacts = [
            display
            for display, canonical in source_contacts.items()
            if canonical not in final_contacts and not is_allowed_value(display, allowed)
        ]
        if missing_contacts:
            findings.append(Finding("fail", "Source contact details missing from final copy: " + ", ".join(missing_contacts), "Keep source emails, phone numbers, and public URLs unless the source changed."))
        missing_codes = [
            code
            for code in source_codes
            if code not in final_codes and not is_allowed_value(code, allowed)
        ]
        if missing_codes:
            findings.append(Finding("fail", "Source codes missing from final copy: " + ", ".join(missing_codes), "Keep promo, coupon, invite, and access codes exactly unless the source changed."))
        missing_multipliers = [
            value
            for value in source_multipliers
            if value not in final_multipliers and not is_allowed_value(value, allowed)
        ]
        if missing_multipliers:
            findings.append(Finding("fail", "Source multipliers missing from final copy: " + ", ".join(missing_multipliers), "Keep multiplier claims like 2x faster or 3x more leads unless the source changed."))
        missing_ranks = [
            value
            for value in source_ranks
            if value not in final_ranks and not is_allowed_value(value, allowed)
        ]
        if missing_ranks:
            findings.append(Finding("fail", "Source ranks missing from final copy: " + ", ".join(missing_ranks), "Keep ranking claims like #1, No. 1, or top 3 unless the source changed."))
        missing_limits = [
            limit
            for limit in source_limits
            if limit not in final_limits and not is_allowed_value(limit, allowed)
        ]
        if missing_limits:
            findings.append(Finding("fail", "Source limits missing from final copy: " + ", ".join(missing_limits), "Keep limits like no credit card, no setup fee, no contract, no hidden fees, or cancel anytime."))
        missing_caveats = [
            caveat
            for caveat in source_caveats
            if caveat not in final_caveats and not is_allowed_value(caveat, allowed)
        ]
        if missing_caveats:
            findings.append(Finding("fail", "Source caveats missing from final copy: " + ", ".join(missing_caveats), "Keep caveats like beta, invite only, limited availability, subject to approval, terms apply, or waitlist unless the source changed."))
        missing_billing = [
            cadence
            for cadence in source_billing
            if cadence not in final_billing and not is_allowed_value(cadence, allowed)
        ]
        if missing_billing:
            findings.append(Finding("fail", "Source billing cadence missing or changed in final copy: " + ", ".join(missing_billing), "Keep billing cadence like billed annually or monthly plan unless the source changed."))
        missing_offers = [
            offer
            for offer in source_offers
            if offer not in final_offers and not is_allowed_value(offer, allowed)
        ]
        if missing_offers:
            findings.append(Finding("fail", "Source offer terms missing from final copy: " + ", ".join(missing_offers), "Keep offer terms like free trial, free plan, or free forever unless the source changed."))
        final_lower = text.lower()
        missing_terms = [term for term in source_terms if term.lower() not in final_lower and not is_allowed_value(term, allowed)]
        if missing_terms:
            findings.append(Finding("fail", "Source names missing from final copy: " + ", ".join(missing_terms), "Restore the product, brand, or named term unless it was intentionally removed."))

    failed = any(finding.severity == "fail" for finding in findings)
    suggestion = suggest_rewrite(text, cta=cta, headline=headline) if findings else ""
    if suggestion == text.strip():
        suggestion = ""

    return {
        "pass": not failed,
        "metrics": {
            "sentences": len(sentences),
            "words": word_count,
            "avg_sentence_words": round(avg_sentence_words, 1),
            "max_sentence_words": max_sentence_words,
            "flesch_kincaid_grade": round(grade, 1) if grade is not None else None,
            "source_facts_checked": len(extract_facts(source_text)) if source_text is not None else None,
            "source_qualifiers_checked": sum(len(items) for items in extract_fact_qualifiers(source_text).values()) if source_text is not None else None,
            "source_units_checked": sum(len(items) for items in extract_number_units(source_text).values()) if source_text is not None else None,
            "source_ranges_checked": len(extract_ranges(source_text)) if source_text is not None else None,
            "source_money_checked": len(extract_money(source_text)) if source_text is not None else None,
            "source_times_checked": len(extract_times(source_text)) if source_text is not None else None,
            "source_ratings_checked": len(extract_ratings(source_text)) if source_text is not None else None,
            "source_contacts_checked": len(extract_contacts(source_text)) if source_text is not None else None,
            "source_codes_checked": len(extract_source_codes(source_text)) if source_text is not None else None,
            "source_multipliers_checked": len(extract_multipliers(source_text)) if source_text is not None else None,
            "source_ranks_checked": len(extract_ranks(source_text)) if source_text is not None else None,
            "source_limits_checked": len(extract_source_limits(source_text)) if source_text is not None else None,
            "source_caveats_checked": len(extract_source_caveats(source_text)) if source_text is not None else None,
            "source_billing_checked": len(extract_billing_cadence(source_text)) if source_text is not None else None,
            "source_offers_checked": len(extract_offer_terms(source_text)) if source_text is not None else None,
            "source_names_checked": len(extract_source_terms(source_text)) if source_text is not None else None,
        },
        "findings": [asdict(finding) for finding in findings],
        "suggestion": suggestion,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate copy against third-grade-copy gates.")
    parser.add_argument("file", nargs="?", help="Text file to evaluate. Reads stdin when omitted.")
    parser.add_argument("--source", help="Original copy file. Checks that facts like prices, dates, times, percentages, units, ranges, money amounts, billing cadence, offer terms, ratings, contact details, source codes, multipliers, ranks, limits, caveats, and all-caps terms were preserved.")
    parser.add_argument("--required-term", action="append", default=[], help="Exact term that must remain in the copy. Repeat as needed.")
    parser.add_argument("--allow-term", action="append", default=[], help="Term to allow after human review. Repeat as needed.")
    parser.add_argument("--cta", action="store_true", help="Require the copy to start with a clear CTA action verb.")
    parser.add_argument("--headline", action="store_true", help="Apply headline-specific checks.")
    parser.add_argument("--suggest", action="store_true", help="Print a conservative first-pass rewrite suggestion when checks fail.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    args = parser.parse_args()

    try:
        if args.file:
            with open(args.file, "r", encoding="utf-8") as handle:
                text = handle.read()
        else:
            text = sys.stdin.read()

        source_text = None
        if args.source:
            with open(args.source, "r", encoding="utf-8") as handle:
                source_text = handle.read()
    except OSError as error:
        print(f"File error: {error}", file=sys.stderr)
        return 2

    result = evaluate(text, args.required_term, args.allow_term, args.cta, args.headline, source_text)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        status = "PASS" if result["pass"] else "FAIL"
        print(status)
        print(json.dumps(result["metrics"], indent=2))
        for finding in result["findings"]:
            print(f"- {finding['severity'].upper()}: {finding['message']}")
            if finding.get("hint"):
                print(f"  Hint: {finding['hint']}")
        if args.suggest and result.get("suggestion"):
            print("Suggestion:")
            print(result["suggestion"])

    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

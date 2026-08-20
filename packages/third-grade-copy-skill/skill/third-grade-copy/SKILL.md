---
name: third-grade-copy
description: Use when writing, editing, reviewing, or auditing marketing copy, product page copy, landing pages, ads, emails, onboarding copy, CTAs, pricing copy, or website/app UI copy that should be clear enough for a third-grade reader.
---

# Third-grade copy

## Overview

Rewrite marketing copy so a third-grade reader can understand it. Use this as the required plain-language pass after the `humanizer` skill for product and marketing copy.

## Required order

1. Run the `humanizer` pass first when the copy may be AI-written, salesy, bloated, or generic.
2. Run this third-grade pass on the humanized copy.
3. Do not stop at "simpler." Audit the final text against the checks below.

## What counts as marketing copy

Apply this skill to public or user-facing copy that sells, explains, persuades, activates, or reassures:

- Landing pages, home pages, feature pages, pricing pages, comparison pages, and SEO pages
- Ad copy, social posts, launch copy, email campaigns, SMS, push messages, and popups
- Hero text, headlines, subheads, CTAs, empty states, onboarding screens, upgrade prompts, and product tours
- In-app copy that explains value, encourages action, handles objections, or asks users to buy, sign up, book, start, upgrade, or share

Do not apply this skill to code identifiers, legal text that must remain exact, API docs, technical docs for developers, logs, database values, or user-generated content unless the user asks.

## Reading standard

Aim for grade 3 or lower:

- Use common words a child knows.
- Keep most sentences under 12 words.
- Put one idea in each sentence.
- Split scope clauses like "from signup to launch" into a second sentence when they make a line too long.
- Use active voice.
- Use concrete nouns and verbs.
- Use "you" and "we" when the product voice allows it.
- Replace abstract claims with simple outcomes.
- Avoid absolute promises like "guaranteed," "always," "never," "instant," and "risk-free" unless the product or legal source proves them.
- Explain required hard words in plain words.
- Keep product names, legal claims, required facts, prices, and dates accurate.
- Keep price currency accurate, such as dollars, euros, pounds, yen, or currency symbols.
- Keep billing cadence accurate, such as billed annually, billed monthly, annual plan, or monthly plan.
- Keep offer terms accurate, such as free trial, free plan, and free forever.
- Keep event times and time zones accurate, such as 5 PM ET or 9:30 AM UTC.
- Keep units with numbers accurate, such as minutes, days, users, seats, and months.
- Keep numeric ranges accurate, such as 5 to 10 users or 10% to 20%.
- Keep contact details accurate, such as email addresses, phone numbers, and public URLs.
- Keep promo, coupon, invite, and access codes exact, such as SAVE20 or BETA-2026.
- Keep multiplier claims accurate, such as 2x faster or 3x more leads.
- Keep ranking claims accurate, such as #1, No. 1, and top 3.
- Keep integration and provider names accurate, even when the source writes them in lowercase.
- Keep limits and exclusions accurate, such as no credit card, no setup fee, no contract, no hidden fees, and cancel anytime.
- Keep availability and legal caveats accurate, such as beta, invite only, limited availability, subject to approval, terms apply, and waitlist.
- Keep necessary domain terms, then explain them in plain words.
- Keep the tone plain, not childish.

Prefer:

| Instead of | Write |
| --- | --- |
| "optimize workflows" | "save time on busy work" |
| "streamline workflows" | "make work faster" |
| "streamline operations" | "make work faster" |
| "robust platform" | "tool" or "app" |
| "seamless experience" | "easy to use" |
| "leverage insights" | "use what you learn" |
| "enhance visibility" | "see more" |
| "empower teams" | "help your team" |

## Process

1. Find every piece of marketing copy in the requested scope. For code changes, include visible strings in components, route metadata, email templates, config files, CMS seed data, and tests or snapshots that assert copy.
2. Preserve the job of each line: headline, proof, feature, benefit, CTA, warning, or reassurance.
3. Rewrite for short words and short sentences. Keep the promise specific.
4. Keep proof, numbers, ranges, units, ratings, review counts, contact details, source codes, multipliers, rankings, integration names, product names, dates, times, prices, currencies, billing cadence, offer terms, limits, caveats, and exclusions intact, including qualifiers like "up to," "less than," "within," "or less," "or more," "from," "before," and "after," plus comparison symbols like `<`, `>`, `<=`, and `>=`.
5. Make CTAs start with a clear action verb, such as get, start, see, find, book, save, send, read, continue, or try.
6. Replace generic CTA labels like "Learn more," "Click here," "Read more," and "Submit" with the next action or result.
7. Read the final copy aloud. Split any sentence that carries two ideas.
8. Audit for hard words, jargon, long sentences, vague claims, and missing meaning.
9. When editing files, run `scripts/evaluate_copy.py` on important final copy blocks, or pipe the text into it. Use `--source original.txt` when rewriting existing copy so prices, currencies, billing cadence like "billed annually" or "monthly plan," offer terms like "free trial," "free plan," or "free forever," dates, event times like "5 PM ET" or "9:30 AM UTC," percentages, rating proof like "4.9 stars" or "4.9 out of 5," contact details like `sales@example.com`, `(312) 555-0198`, or `https://example.com/pricing`, source codes like `SAVE20` or `BETA-2026`, ranking claims like "#1" or "top 3," multiplier claims like "2x faster," number ranges like "5 to 10 users," number units like "2 minutes," "10 users," or "1,200 reviews," integration names like Stripe or Slack, limits like "no credit card" or "cancel anytime," caveats like "beta," "invite only," or "terms apply," claim qualifiers like "up to," "less than," "within," "or less," "or more," "before," `<`, `>`, `<=`, or `>=`, all-caps terms, and named product or brand terms are not lost. Use `--required-term` for product names, prices, compliance terms, or legal terms that must stay. Use `--cta` for CTA labels and `--headline` for headlines.
10. Return or commit only the final copy unless the user asks to see the audit.

## Hard gates

The final copy should pass these checks unless accuracy requires an exception:

- Average sentence length is 10 words or less.
- No sentence is over 14 words.
- No semicolons.
- No em dashes, en dashes, or curly quotes.
- No stacked clauses joined by "while," "by," "through," or "so that."
- No vague superlatives: best, easiest, powerful, seamless, robust, world-class.
- No vague claims: everything you need, work smarter, get results, move faster, drive growth.
- No risky absolute claims: guaranteed, always, never, instant, risk-free, no risk.
- No generic CTA labels: learn more, click here, read more, submit.
- No unexplained hard terms. If a term must stay, add a short explanation near it.
- Headlines are 8 words or less and lead with the user's outcome.
- For copy blocks of 20+ words, estimated Flesch-Kincaid grade is about 3 or lower. Treat this as a warning, not a replacement for judgment.

## Audit checklist

Before finishing, verify:

- No sentence is hard to say in one breath.
- No sentence has more than one main idea.
- No jargon remains unless users already know it.
- No claim got broader or less accurate.
- No claim became absolute unless the source supports it.
- Every CTA starts with a clear verb.
- Every CTA names the next action or outcome.
- Headlines say what the user gets, not what the product "is."
- Benefits are concrete: time saved, money found, risk reduced, steps removed, mistakes caught.
- The copy still sounds human after the grade-level rewrite.
- The copy does not sound like it was written for babies.

## Evaluation helper

Use `scripts/scan_copy.py` to find likely marketing strings in source files:

```bash
python scripts/scan_copy.py path/to/app --json
python scripts/scan_copy.py path/to/app --suggest
python scripts/scan_copy.py path/to/app --markdown --suggest
python scripts/scan_copy.py path/to/app --sarif > third-grade-copy.sarif
python scripts/scan_copy.py path/to/app --github-annotations
python scripts/scan_copy.py path/to/app --include-warnings --markdown
python scripts/scan_copy.py path/to/app --fail-on-warnings --markdown
python scripts/scan_copy.py path/to/app --include-docs --json
python scripts/scan_copy.py path/to/app --config third-grade-copy.json --markdown --suggest
```

By default, the scanner skips generated files, package manifests, README files, docs, migrations, scripts, and tests so repo scans focus on app/source/content copy. It scans likely visible string literals, common UI attributes such as `aria-label`, `alt`, `placeholder`, and `title`, JSX/HTML text nodes, Markdown/MDX headings, paragraphs, and list items, plus simple YAML content values in `.yml` and `.yaml` files. Text split across lines is included. Common labels like "Start free trial," "Book a demo," "Try for free," and "View pricing" are treated as CTAs even when the attribute or prop name is generic. Use `--include-docs` only when docs or README copy are in scope. Use `--include-warnings` for a stricter review pass; warning-only copy is reported but does not make the command fail. Use `--fail-on-warnings` when warning-only copy should fail CI or a pre-commit check.

Use an optional JSON config for repo-specific scope. The scanner auto-loads `third-grade-copy.json` or `.third-grade-copy.json` from the scan root. Use `--config` when the file lives somewhere else.

```json
{
  "include_docs": false,
  "fail_on_warnings": false,
  "skip_dirs": ["fixtures"],
  "skip_files": ["legacy-copy.json"],
  "copy_keys": ["marketingLine"],
  "cta_keys": ["actionText"],
  "headline_keys": ["mainHeadline"],
  "required_terms": ["SOC 2"],
  "allowed_terms": ["implementation"]
}
```

Config files are validated before scanning. Unknown keys, wrong value types, or extension names without a leading dot stop the scan with a config error.

For a deliberate one-line exception, add `third-grade-copy-ignore` on the same line. To ignore the next line, add `third-grade-copy-ignore next-line` on the line before it. Use this only for copy that has been reviewed and must remain as written.

Use `scripts/evaluate_copy.py` for a focused mechanical check:

```bash
python scripts/evaluate_copy.py final-copy.txt --required-term "SOC 2" --required-term "$49"
python scripts/evaluate_copy.py final-copy.txt --source original-copy.txt
echo See plans | python scripts/evaluate_copy.py --cta
echo Close deals faster | python scripts/evaluate_copy.py --headline
echo Optimize workflows. | python scripts/evaluate_copy.py --suggest
```

The script checks sentence length, semicolons, em dashes, en dashes, curly quotes, hard words, vague superlatives, vague claims, risky absolute claims, common jargon including plural forms, passive voice warnings, childish phrases, missing required terms, generic CTA labels, CTA verb starts, headline length/filler, source fact, source qualifier, source unit, source range, source money amount, source billing cadence, source offer term, source time, source rating, source contact details, source code, source multiplier, source rank, source limit, source caveat, source name preservation, and a rough reading-grade estimate. Findings include fix hints. Use `--suggest` for a conservative first-pass rewrite suggestion when the helper can make a concrete change, including some warning-only passive voice fixes. Use `--allow-term` only after deciding a hard word must stay, after confirming an absolute claim or generic CTA is allowed, or after intentionally removing a source fact, qualifier, unit, range, money amount, billing cadence, offer term, time, rating, contact detail, source code, multiplier, ranking, limit, caveat, or name. Passing the script is not enough. The copy must still keep the promise, proof, and intent.

`scan_copy.py` is a broad scanner. It can produce false positives, but every failure is worth a human look before finalizing marketing copy.

When changing this skill, run the bundled regression evals:

```bash
python scripts/run_evals.py
python scripts/run_scan_evals.py
```

## Common mistakes

Avoid these failure modes:

- Do not remove the sales point. Simpler copy still needs to sell.
- Do not turn specific proof into vague comfort copy.
- Do not drop prices, currencies, billing cadence, offer terms, dates, percentages, ratings, review counts, product names, compliance terms, limits, or caveats from the source copy.
- Do not replace a precise term with a wrong simple word.
- Do not flatten every line into the same short rhythm.
- Do not add fake claims, fake numbers, or fake urgency.
- Do not use childish phrasing like "super easy," "big helper," or "no worries" unless that is already the brand voice.

## Example

Before:

> Our comprehensive revenue intelligence platform empowers cross-functional teams to optimize pipeline visibility and accelerate strategic decision-making.

After:

> See every deal in one place. Know what needs work. Help your team close faster.

Audit:

- "Revenue intelligence," "cross-functional," "optimize," and "strategic decision-making" were too hard.
- The rewrite keeps the promise: better deal visibility and faster sales work.

## Necessary hard term example

Before:

> Get SOC 2-ready evidence collection with automated compliance workflows.

After:

> Get ready for SOC 2. We help collect the proof you need for the audit.

Audit:

- "SOC 2" stays because it is the thing users need.
- "Evidence collection," "automated," "compliance," and "workflows" became plain words.

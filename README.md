# ventora-platform: one contract, two runtimes

A polyglot monorepo: 20 TypeScript packages, 6 Python packages, and 5 Cloudflare Workers that
share one event taxonomy and one set of PII redaction rules. It was the shared infrastructure
layer behind several small SaaS products (analytics, auth, billing, storage, email,
observability, SEO, and two embeddable AI assistants) which consumed these packages as private
dependencies rather than deploying this repository directly.

> [!IMPORTANT]
> **Status: retired, as of 2026-08-13.** `pnpm verify` still runs clean against this frozen tree:
> schema drift, metrics drift, tracked-secret scanning, script tests, lint, typecheck, per-file
> coverage across every package, and both consumer smoke tests, nine steps end to end. Ventora
> Labs wound down and the products that consumed these packages retired with it, so the tree is
> published to be read rather than deployed against.

> [!NOTE]
> Built by Angel Campa, sole author of every package here. Source-available for reading and
> review: all rights are reserved and no license to use, copy, modify, or redistribute is
> granted. See [License](#license).

![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178c6?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.12+-3776ab?style=flat-square)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?style=flat-square)
![Coverage](https://img.shields.io/badge/coverage-95%25%20per--file-2f855a?style=flat-square)

![The AI-CS support panel rendered four times side by side under the CAMAudit, CapVeri, GrantPipe
and Lextract themes: green, purple, near-black and orange headers, each with a matching send
button, escalation pill and message bubbles, all answering the same "How do I get started?"
question](portfolio/screenshots/widget-matrix.png)

*The same widget build under four brand themes, captured by a scripted Playwright run against
fully mocked Workers, with no API key and no network beyond localhost. Brand tokens are data, so
adding a product does not fork the client. CAMAudit and CapVeri are the same product under its old
and new names, so these four themes correspond to three products.*

## Contents

- [If you read one thing](#if-you-read-one-thing)
- [What it did](#what-it-did)
- [Architecture](#architecture)
- [Worth reading](#worth-reading)
- [By the numbers](#by-the-numbers)
- [Testing](#testing)
- [Screenshots](#screenshots)
- [Repository map](#repository-map)
- [Documentation](#documentation)
- [Built with AI agents](#built-with-ai-agents)
- [Running it locally](#running-it-locally)
- [Who built this](#who-built-this)
- [License](#license)

## If you read one thing

Read [`portfolio/ARCHITECTURE-CONTRACTS.md`](portfolio/ARCHITECTURE-CONTRACTS.md). The whole
reason this repository exists is one contract enforced across two runtimes, and that document
proves the enforcement mechanism (codegen for event names, AST extraction for redaction rules, an
HTTP bridge for email) against the actual source instead of asserting it in prose. The full
write-ups live in [`portfolio/`](portfolio/README.md); this file is the entry point, not the
destination.

## What it did

This was the shared infrastructure layer behind several small SaaS products: analytics, auth,
billing, storage, email, observability, SEO, and two embeddable AI assistants. Those products
lived in their own repositories and consumed these packages as private dependencies, so nothing
here was a deployment target: a change shipped by publishing a version, not by pushing to an
environment.

A product repo shows you what got built. This one shows you the rules those products were built
against, and the gates that made the rules hold when two runtimes disagreed.

The constraint that shaped most of the design is that half the consumers were TypeScript and half
were Python. Analytics event names and PII redaction rules are therefore generated from JSON
schemas into both languages and byte-compared in the gate, so the two runtimes cannot drift apart
quietly. Email is the exception, and it is the more interesting half of the story: React Email
templates cannot be reimplemented in Python, so Python calls TypeScript over an HMAC-signed HTTP
bridge instead of pretending to have parity. [What that costs, and why it beat the
alternative, is below.](#the-exception-email)

There is no hosted CI service. The gate is `pnpm verify`, and it ran on the machine that wrote the
code.

## Architecture

Four claims organise the design, and [`portfolio/ARCHITECTURE.md`](portfolio/ARCHITECTURE.md) and
its three companion documents each exist to prove one of them against the source: there are
exactly two trust boundaries and neither is CORS; the Python side borrows event names, redaction
rules, and email rendering from TypeScript rather than reimplementing them; session state lives in
Durable Objects with an alarm-driven retry ladder so the SSE stream never waits on a side effect;
and the supply chain is self-hosted end to end, with two Workers on R2 speaking npm and PyPI.

![System map: the browser and product backend on the left, the five Cloudflare Workers in the
middle, and the self-hosted npm and PyPI registries on R2, with the HMAC-signed assertion path,
the Python-to-TypeScript email render bridge, and the durable CRM outbox drawn between
them](portfolio/screenshots/system-map.svg)

### The five Workers

Everything else in the repo was published as a package. These five were the ones deployed.

| Worker | Surface | The part worth reading |
| --- | --- | --- |
| `email-renderer` | `POST /render` | Lets Python render React Email templates without a JS runtime. Requests carry an HMAC over one canonical JSON string holding timestamp, nonce, method, path, and the body itself, checked against a 5-minute freshness window plus a nonce map. |
| `ai-sdr-worker` | `/v1/sessions`, `/v1/chat` (SSE), `/v1/handoff` | Session state in a Durable Object. Lead pushes to a product CRM go through a durable outbox with alarm-driven retry at 0s, 30s, 2m, 10m, 1h, so the streaming response never waits on a third party. |
| `ai-cs-worker` | `/v1/sessions`, `/v1/chat` (SSE), `/v1/escalations` | Fetches a signed per-app context from the product, verifies the signature, and *still* treats the payload as untrusted data. Every field is sanitized and length-capped before it reaches the prompt. |
| `package-registry` | npm protocol on R2 | A private npm registry implemented from scratch: packument and tarball endpoints, timing-safe token comparison, gzip magic-byte and SHA integrity checks on publish. |
| `python-registry` | PEP 503 HTML, PEP 691 JSON, legacy upload | The Python sibling, content-negotiated on `application/vnd.pypi.simple.v1+json`, so `uv` and `pip` can install private `ventora_*` packages. |

### What's in here

<!-- metrics:package-table:start -->
| Package | Source | Tests | Purpose |
| --- | ---: | ---: | --- |
| **Contracts** | | | |
| `@ventora/ai-assistant-contracts` | 520 | 244 | Shared assistant protocol contracts for Ventora AI-SDR and AI-CS runtimes |
| `@ventora/ai-cs-contracts` | 372 | 117 | AI customer support protocol contracts for authenticated Ventora apps |
| `@ventora/ai-sdr-contracts` | 492 | 624 | Shared AI-SDR protocol contracts for Ventora products |
| **Workers (deployed)** | | | |
| `@ventora/ai-cs-worker` | 4,068 | 7,186 | Private Cloudflare Worker runtime for Ventora AI-CS |
| `@ventora/ai-sdr-worker` | 6,192 | 13,399 | Private Cloudflare Worker runtime for Ventora AI-SDR |
| `@ventora/email-renderer` | 280 | 446 | Cloudflare Worker: POST /render returns HTML+text for Python clients |
| `@ventora/package-registry` | 680 | 771 | Private npm-compatible registry for Ventora packages on Cloudflare Workers |
| `@ventora/python-registry` | 736 | 1,332 | Private PEP 503/691 Python package index for Ventora packages on Cloudflare Workers |
| **Libraries (published)** | | | |
| `@ventora/ai-cs` | 3,260 | 6,079 | Browser client helpers for Ventora AI customer support |
| `@ventora/ai-sdr` | 1,399 | 2,074 | Browser client and embeddable widget for Ventora AI-SDR |
| `@ventora/analytics` | 460 | 535 | PostHog analytics wrapper with compile-time event taxonomy for Ventora products |
| `@ventora/api-client` | 558 | 913 | Fetch-based API client factory with typed errors, retry, and TanStack Query defaults |
| `@ventora/auth-better` | 654 | 797 | Better Auth factory and helpers for Ventora products |
| `@ventora/billing` | 574 | 919 | Stripe billing abstraction: plans, checkout, webhooks, and trial lifecycle |
| `@ventora/email` | 416 | 654 | Resend email client with idempotency, unsubscribe tokens, and CAN-SPAM helpers |
| `@ventora/email-templates` | 1,003 | 170 | React Email templates for all Ventora products |
| `@ventora/observability` | 739 | 828 | Sentry, correlation IDs, error hierarchy, and PII redaction for Ventora products |
| `@ventora/seo` | 892 | 1,449 | JSON-LD, page metadata, sitemaps, feeds, and IndexNow for Ventora products |
| `@ventora/storage` | 716 | 1,009 | R2/S3 object storage abstraction with signed URLs and filename sanitization |
| `@ventora/third-grade-copy-skill` | 3,472 | 1 | Packaged Codex/Agents/Claude skill for third-grade marketing copy review |
| **Python** | | | |
| `ventora-analytics` | 356 | 485 | PostHog analytics wrapper with approved event taxonomy for Ventora Python services |
| `ventora-billing` | 447 | 839 | Stripe billing abstraction: plans, checkout, webhooks, and trial lifecycle |
| `ventora-email` | 387 | 592 | Resend email client with template rendering, unsubscribe tokens, and CAN-SPAM helpers |
| `ventora-llm` | 454 | 936 | OpenRouter multi-pass LLM extraction pipeline for Ventora document processing |
| `ventora-observability` | 591 | 1,095 | Sentry, structured logging, PII redaction, and error hierarchy for Ventora Python services |
| `ventora-storage` | 485 | 733 | R2/S3 object storage abstraction for Ventora Python services |
<!-- metrics:package-table:end -->

The full trust model, request paths, session/outbox mechanics, and package layering are in the
four-document [`portfolio/ARCHITECTURE.md`](portfolio/ARCHITECTURE.md) series, indexed in
[`portfolio/README.md`](portfolio/README.md).

## Worth reading

### One schema, two languages, byte-for-byte

[`schemas/analytics-events.json`](schemas/analytics-events.json) is the only place an analytics
event name is defined. [`scripts/codegen-schemas.mjs`](scripts/codegen-schemas.mjs) reads it and
writes two files: a TypeScript union in `packages/analytics/src/_generated-events.ts` and a Python
`Literal` in `py/ventora_analytics/src/ventora_analytics/_generated_events.py`. Passing `--check`
regenerates both in memory and byte-compares them against what is on disk.

The failure mode this removes is the boring one: someone adds an event to the TypeScript side,
ships it, and the Python service silently never emits it. Now the build stops.

![Schema drift detection failing on an injected event: the codegen check regenerates both the
TypeScript union and the Python Literal, byte-compares them against the files on disk, and exits
with a DRIFT error naming the event that was added to only one
side](portfolio/screenshots/term-schema-drift.svg)

→ [ARCHITECTURE-CONTRACTS.md §4, Cross-language
parity](portfolio/ARCHITECTURE-CONTRACTS.md#4-cross-language-parity) draws the whole pipeline: one
schema in, two generated files out, three sources compared, all of it feeding `pnpm verify`

### The exception: email

The rest of the cross-language contract is generated and compared. Email is not, because React
Email templates are React, and there is no honest way to reimplement them in Python. So
`ventora_email` does not render anything. It builds a payload, signs it, and posts it to
`ventora-email-renderer`, which returns HTML and text.

The parity that matters there is not code parity. It is byte parity of the string that gets
signed. [`py/ventora_email/src/ventora_email/renderer.py`](py/ventora_email/src/ventora_email/renderer.py)
serializes timestamp, nonce, method, path, and body in exactly the key order that
[`packages/email-renderer/src/index.ts`](packages/email-renderer/src/index.ts) uses to rebuild the
same string, so `json.dumps(separators=(",", ":"))` and `JSON.stringify` have to agree byte for
byte or the HMAC fails. [`scripts/e2e/email-renderer-bridge.e2e.mjs`](scripts/e2e/email-renderer-bridge.e2e.mjs)
boots the real Worker under `wrangler dev` and drives the real Python client against it, so that
agreement is proven rather than asserted.

The cost is a network hop and a Worker to keep alive. The alternative was a second template set
that would drift within a month.

→ [ARCHITECTURE-CONTRACTS.md §3, The Python-to-TypeScript render
bridge](portfolio/ARCHITECTURE-CONTRACTS.md#3-the-python-to-typescript-render-bridge) sequences the
whole round trip, down to the line in each file where the canonical payload is built

### Redaction rules verified by AST, across three sources

Redaction is different. The TypeScript implementation in `packages/observability/src/redact.ts` is
authored directly and needs to stay that way, so it cannot be generated. Instead
[`scripts/check-redaction-rules.mjs`](scripts/check-redaction-rules.mjs) parses that file with the
TypeScript compiler API, pulls the `DEFAULT_RULES` object literal out of the AST, normalizes it,
and deep-compares it against both the JSON schema and the Python copy.

Three independent sources are compared in one gate, and nothing in that comparison parses source
code with a regex. Sorting before comparison means key ordering is not a false positive.

### A gate you can actually run

`pnpm verify` chains nine steps, ending with two consumer harnesses that install the built
artifacts and import them the way a product would. Two of those steps are the ones above; another
scans every tracked file for credentials.

![Terminal running scripts/check-tracked-secrets.mjs, which names the one tracked file holding a
planted credential and the rule that caught it: an OpenRouter API key identified by its
sk-or-v1- prefix](portfolio/screenshots/term-secret-scan.svg)

The counting rules behind this README's own numbers get the same treatment.
[`scripts/__tests__/repo-metrics.test.mjs`](scripts/__tests__/repo-metrics.test.mjs) checks the
test-case matcher against `it.each`, `test.skip`, commented-out tests, and strings that merely
contain `test(`.

→ [`portfolio/TESTING.md`](portfolio/TESTING.md) covers the testing strategy in full: the four
test tiers, why `perFile` is the load-bearing word in the coverage gate, the per-package exclusion
table, and where the numbers are weakest. →
[`portfolio/ENGINEERING-LOG.md`](portfolio/ENGINEERING-LOG.md) covers strictness settings quoted
from the actual configs, the release flow, and how this repo's own documentation stays gated.

## By the numbers

<!-- metrics:at-a-glance:start -->
| | |
| --- | --- |
| Packages | 20 TypeScript · 6 Python |
| Deployable Workers | 5 |
| Project lines | 92,119 across 442 files (lockfiles excluded) |
| Test code | 39,822 TypeScript lines (64.7%) · 4,680 Python lines (50.1%) |
| Test cases declared | 2,059 vitest · 448 pytest · 227 node:test |
| Coverage floor | 95% lines, branches, functions, statements, enforced **per file** across 19 vitest configs and 6 Python packages |
| Zero-runtime-dependency packages | 18 of 20 TypeScript packages |
| Cross-language contract | 46 analytics events, 35 redaction field keys, 7 patterns |
<!-- metrics:at-a-glance:end -->

Every number above is computed by [`scripts/repo-metrics.mjs`](scripts/repo-metrics.mjs) and
written to [`docs/metrics.json`](docs/metrics.json). `pnpm run metrics:check` recomputes them and
fails if this file has drifted, so the documentation cannot quietly go stale. The full breakdown
(language mix, source-versus-test by package, coverage exclusions) is in
[`portfolio/METRICS.md`](portfolio/METRICS.md).

## Testing

Four test tiers run against this repository, and only two of them (vitest unit tests and the
`node:test` suite over the CI scripts themselves) are wired into the default `pnpm verify` gate.
The other two (in-process E2E against real `wrangler dev` Workers, and Playwright browser E2E
against that stack) are run deliberately, not on every commit.

The headline structural claim is `perFile: true` at a 95% threshold across lines, branches,
functions, and statements, set in all 19 TypeScript `vitest.config.ts` files and all 6 Python
`pyproject.toml` files. Ten of the twenty TypeScript packages, including the two largest,
`@ventora/ai-sdr-worker` and `@ventora/ai-cs-worker`, exclude nothing from that gate beyond build
and test scaffolding.

`scripts/repo-metrics.mjs` counts *declared* test cases by parsing source, not by running
anything, and says so plainly: Python declares 448 cases but `uv run pytest` executes 472, because
`@pytest.mark.parametrize` turns one declaration into several runs. A count of declarations
measures how many test cases are written in the tree.

![Coverage gate](portfolio/screenshots/term-coverage-table.svg)

*Real `pnpm --filter @ventora/ai-sdr-worker test:coverage` output for the largest package in the
repository.*

→ [`portfolio/TESTING.md`](portfolio/TESTING.md) is the full write-up: all four tiers, the nine
steps of `pnpm verify` and what each one rejects, the per-package coverage-exclusion table, and two
terminal captures of gates actually refusing bad input rather than merely passing.

## Screenshots

Every capture below comes from `scripts/docs/capture-docs-shots.mjs`, which drives the real hosted
widget clients in a browser against `wrangler dev` Workers and a fully mocked model server, with no
API key and no network beyond localhost, and waits for CSS transitions to settle before the shutter
fires, so no reply is caught mid fade-in. Email renders come from
`scripts/docs/render-email-previews.mjs`, importing the built `@ventora/email-templates` package
directly. None of it is sourced from the gitignored `output/` directory, which holds ungated,
mid-animation working captures rather than curated documentation assets.

**AI-SDR**, the anonymous marketing assistant served from `@ventora/ai-sdr-worker`:

<table>
<tr>
<td width="50%"><img src="portfolio/screenshots/widget-sdr-answered-desktop.png" alt="Orange Chat with Lextract widget showing the question 'What does this product do for my team?' and a reply about pulling facts from uploaded files, with a Copy button below it"></td>
<td width="50%"><img src="portfolio/screenshots/widget-sdr-typed-desktop.png" alt="Chat with Lextract widget in its opening state with a greeting, two suggestion chips reading 'What does it cost?' and 'How do I get started?', and a typed but unsent question in the input box"></td>
</tr>
<tr>
<td>Answered state. The reply streams in over SSE and carries a copy action.</td>
<td>Opening state, with a question typed into the composer but not yet sent.</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="portfolio/screenshots/widget-sdr-answered-mobile.png" alt="Same orange Chat with Lextract widget at a narrow mobile width, showing the question and file-upload answer with the rest of the screen left empty"></td>
<td width="50%"><img src="portfolio/screenshots/widget-dark-sdr-desktop.png" alt="Chat with Lextract widget under a dark theme with a blue header and blue user message bubble, showing the same question about the product and the file-upload answer"></td>
</tr>
<tr>
<td>The same widget at a mobile viewport.</td>
<td>The same widget under a dark brand override. Theme tokens are per-product, not a second stylesheet.</td>
</tr>
</table>

**AI-CS**, the authenticated in-app support assistant served from `@ventora/ai-cs-worker`:

<table>
<tr>
<td width="50%"><img src="portfolio/screenshots/widget-cs-launcher-desktop.png" alt="Closed orange pill-shaped launcher button reading 'Need help?' with a speech-bubble icon"></td>
<td width="50%"><img src="portfolio/screenshots/widget-cs-empty-desktop.png" alt="Support widget empty state with header 'Support, we typically reply instantly', the prompt 'How can we help?', a Talk to a person button, and an empty question input"></td>
</tr>
<tr>
<td>The closed launcher.</td>
<td>The empty state, before any turn has been taken.</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="portfolio/screenshots/widget-cs-answered-desktop.png" alt="Support widget showing the question 'How do I get started?' and a reply about uploading a file to extract and export key facts, with Copy, Retry, and Talk to a person options"></td>
<td width="50%"><img src="portfolio/screenshots/widget-cs-answered-mobile.png" alt="Same Support widget conversation at a narrow mobile width, with the file-upload answer and Talk to a person button near the top and empty space below"></td>
</tr>
<tr>
<td>Answered state on desktop.</td>
<td>The same conversation at a mobile viewport.</td>
</tr>
</table>

**Email templates**, rendered by `@ventora/email-templates` and reached from Python through the
`@ventora/email-renderer` Worker:

![Grid of ten labeled email templates: welcome, password-reset, email-verification, trial-ending,
trial-expired, payment-receipt, payment-failed, lead-magnet-delivery, nurture-step, and
internal-error-fallback, each with its own heading and colored CTA
button](portfolio/screenshots/email-templates-sheet.png)

<table>
<tr>
<td width="50%"><img src="portfolio/screenshots/email-trial-ending.png" alt="Trial-ending email with the headline 'Your trial ends in 3 days', body text about upgrading to keep data and features, and an orange Upgrade Now button"></td>
<td width="50%"><img src="portfolio/screenshots/email-payment-receipt.png" alt="Payment receipt email listing Plan: Lextract Team, Amount Paid: USD 49.00, Date: August 1, 2026, and a purple Download Invoice button"></td>
</tr>
</table>

→ [`portfolio/GALLERY.md`](portfolio/GALLERY.md) collects every capture, including the terminal
recordings and generated charts referenced elsewhere in this file.

## Repository map

```text
packages/          20 TypeScript packages (15 published, 5 deployed Workers)
py/                6 Python packages, uv workspace
schemas/           JSON source of truth for cross-language contracts
scripts/           codegen, quality gates, E2E harness, docs tooling
  e2e/             mock OpenRouter + context servers, real `wrangler dev` boots
  docs/            screenshot, email preview, and terminal-SVG capture
test-consumer/     smoke harnesses that install the built artifacts
portfolio/         Retrospective write-ups: architecture, metrics, testing, gallery; start at
                   portfolio/README.md
docs/              Integration guides, embed snippets, generated metrics.json, and this
                   portfolio pass's own working ledger
```

## Documentation

[`portfolio/`](portfolio/README.md) is the retrospective, evidence-backed write-up of this
repository, indexed with one row per document. [`docs/`](docs/PUBLISHING.md) is prospective and
self-addressed: integration guides a consuming product needed
([`AI_SDR.md`](docs/AI_SDR.md), [`AI_CS.md`](docs/AI_CS.md),
[`AI_WIDGET_EMBED_SNIPPETS.md`](docs/AI_WIDGET_EMBED_SNIPPETS.md)), the historical publishing
runbook, and the generated `metrics.json` every number here is read from.

## Built with AI agents

Every package in this repository was built with Claude Code and Codex as the primary editors,
under human review. `CLAUDE.md` and `AGENTS.md` at the repository root are committed on purpose
and reviewed like source, not scrubbed before publishing: they are the actual operating rules an
agent worked under, including the sub-agent parallelism policy `AGENTS.md` describes. This
particular repository has no `.claude/` or `.codex/` directory. Those exist in some sibling
repositories in the portfolio and not here, so nothing has been hidden by their absence.

The concrete thing the process enforced, rather than merely encouraged: `CLAUDE.md` mandates a
95%-per-file coverage floor and forbids `any` in TypeScript, TODO markers, and placeholder code.
Those are not aspirational lines in a prompt: they are the identical `vitest` and `pytest`
thresholds, and the identical `biome`/`ruff` rules, enforced by `pnpm verify`. An agent could not
merge code that violated them any more than a human could, because the same command rejects both.

The real number that survives the squash: through Cycle 5, this portfolio pass ran five documented
audit cycles against nine findings (five fixed, two retracted claims, two deliberate wontfixes),
logged in [`docs/goal-portfolio-public/LEDGER.md`](docs/goal-portfolio-public/LEDGER.md) with the
exact method used to check each one.

## Running it locally

```bash
pnpm install
pnpm exec turbo run build
pnpm verify
```

Python packages live in a separate [uv](https://docs.astral.sh/uv/) workspace:

```bash
cd py
uv sync
uv run pytest
```

Single package, single file, single test:

```bash
pnpm --filter @ventora/analytics test
pnpm --filter @ventora/analytics test -- src/events.test.ts
pnpm --filter @ventora/analytics test -- -t "redacts PII"
```

Regenerate documentation assets:

```bash
pnpm run metrics
node scripts/docs/capture-terminal-svgs.mjs
```

## Who built this

Built by Angel Campa, sole author of every package here. Questions about the design decisions in
this tree are welcome via [github.com/AngelCampa1](https://github.com/AngelCampa1).

## License

This repository is published as an engineering portfolio piece. It is source-available for reading
and review; all rights are reserved and no license to use, copy, modify, or redistribute is
granted. Package manifests are marked `UNLICENSED` accordingly. Full text in
[`LICENSE`](LICENSE).

It is not accepting contributions and is not a supported product. Product names that appear here
were real consumers of these packages. Worker deployment URLs, account identifiers, and
credentials are deliberately absent. The origin allowlists in the Worker configs are the one
exception, and they are meant to be readable: they hold public product domains, and an allowlist
you can inspect is a security control rather than a leak. The Workers read every secret from the
environment, and `scripts/check-tracked-secrets.mjs` runs in the gate to keep it that way.

© 2026 Angel Campa

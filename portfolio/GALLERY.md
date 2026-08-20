# Gallery

Everything under `portfolio/screenshots/` in one place. The README and the other documents pull a
few of these inline; the rest live here so the whole captured set stays visible.

Nothing here is a mockup. The widget shots come from the real hosted clients running against
`wrangler dev` Workers and a mock model server, with animations disabled immediately before the
shutter fires so no reply is caught mid fade-in; the email shots come from the real React Email
templates; the terminal shots are recorded stdout from the actual gates; and the charts are
generated from `docs/metrics.json`. The scripts that produce them are
`scripts/docs/capture-docs-shots.mjs`, `scripts/docs/render-email-previews.mjs`,
`scripts/docs/capture-terminal-svgs.mjs`, and `scripts/repo-metrics.mjs --charts`.

## System map

The one hand-drawn asset in the repository. Everything else is generated or captured.

![Boxed flow diagram of customer browser, product backend, and Cloudflare Worker leading to a
Durable Object session, CRM ingest and outbox, plus a separate Python-to-email-renderer-to-R2-registries
path, linked by signed-request arrows](screenshots/system-map.svg)

## AI-SDR widget

The anonymous marketing assistant, served as a script from `@ventora/ai-sdr-worker` and injected
into the customer's own document with no shadow DOM.

<table>
<tr>
<td width="50%"><img src="screenshots/widget-sdr-answered-desktop.png" alt="Orange Chat with Lextract widget showing the question 'What does this product do for my team?' and a reply about pulling facts from uploaded files, with a Copy button below it"></td>
<td width="50%"><img src="screenshots/widget-sdr-typed-desktop.png" alt="Chat with Lextract widget in its opening state with a greeting, two suggestion chips reading 'What does it cost?' and 'How do I get started?', and a typed but unsent question in the input box"></td>
</tr>
<tr>
<td>Answered state. The reply streams in over SSE and carries a copy action.</td>
<td>Opening state with the greeting and two suggestion chips, and a question typed into the composer.</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="screenshots/widget-sdr-answered-mobile.png" alt="Same orange Chat with Lextract widget at a narrow mobile width, showing the question and file-upload answer with the rest of the screen left empty"></td>
<td width="50%"><img src="screenshots/widget-dark-sdr-desktop.png" alt="Chat with Lextract widget under a dark theme with a blue header and blue user message bubble, showing the same question about the product and the file-upload answer"></td>
</tr>
<tr>
<td>The same widget at a mobile viewport.</td>
<td>The same widget again, under a dark brand override. Colours come from per-product theme tokens, not a second stylesheet.</td>
</tr>
</table>

## AI-CS widget

The authenticated in-app support assistant, served from `@ventora/ai-cs-worker`.

<table>
<tr>
<td width="50%"><img src="screenshots/widget-cs-launcher-desktop.png" alt="Closed orange pill-shaped launcher button reading 'Need help?' with a speech-bubble icon"></td>
<td width="50%"><img src="screenshots/widget-cs-empty-desktop.png" alt="Support widget empty state with header 'Support, we typically reply instantly', the prompt 'How can we help?', a Talk to a person button, and an empty question input"></td>
</tr>
<tr>
<td>The closed launcher.</td>
<td>The empty state, before any turn has been taken.</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="screenshots/widget-cs-answered-desktop.png" alt="Support widget showing the question 'How do I get started?' and a reply about uploading a file to extract and export key facts, with Copy, Retry, and Talk to a person options"></td>
<td width="50%"><img src="screenshots/widget-cs-answered-mobile.png" alt="Same Support widget conversation at a narrow mobile width, with the file-upload answer and Talk to a person button near the top and empty space below"></td>
</tr>
<tr>
<td>Answered state on desktop.</td>
<td>The same conversation at a mobile viewport.</td>
</tr>
</table>

### Four brands, one build

![Four Support widgets in green, indigo, dark navy, and orange, labeled CAMAudit, CapVeri,
GrantPipe, and Lextract, each answering 'How do I get started?' with a different product-specific
onboarding step](screenshots/widget-matrix.png)

The same widget code under four brand themes. Brand tokens are data, so adding a product does
not fork the client. CAMAudit and CapVeri are the same product under its old and new names, so
these four themes correspond to three products.

## Email templates

Rendered by `@ventora/email-templates`. Python services reach these through the
`@ventora/email-renderer` Worker rather than running a JavaScript runtime.

![Grid of ten labeled email templates: welcome, password-reset, email-verification, trial-ending,
trial-expired, payment-receipt, payment-failed, lead-magnet-delivery, nurture-step, and
internal-error-fallback, each with its own heading and colored CTA
button](screenshots/email-templates-sheet.png)

Two of the ten at full width, from different layout families:

<table>
<tr>
<td width="50%"><img src="screenshots/email-trial-ending.png" alt="Trial-ending email with the headline 'Your trial ends in 3 days', body text about upgrading to keep data and features, and an orange Upgrade Now button"></td>
<td width="50%"><img src="screenshots/email-payment-receipt.png" alt="Payment receipt email listing Plan: Lextract Team, Amount Paid: USD 49.00, Date: August 1, 2026, and a purple Download Invoice button"></td>
</tr>
</table>

## Gates, recorded

Real stdout, rendered to SVG so it stays readable at any zoom and diffs as text. Two of these are
captures of a gate refusing bad input, which is the part worth seeing.

![Terminal running 'node scripts/codegen-schemas.mjs --check', reporting drift in the generated
TypeScript and Python event files and an instruction to rerun the codegen
script](screenshots/term-schema-drift.svg)

A single event added to `schemas/analytics-events.json` and nothing else. The byte-comparison
against the generated TypeScript and Python files catches it.

![Terminal running the secret scanner, reporting an OpenRouter API key detected in
docs/integrations/bff-templates/nextjs-app-router.ts](screenshots/term-secret-scan.svg)

A fake OpenRouter key written into a tracked file. The scanner that runs inside `pnpm verify`
finds it.

![Terminal running pnpm test:coverage, showing the ai-sdr-worker package's coverage table with
every file above 98 percent and a Turbo summary of 34 successful tasks in 32.487
seconds](screenshots/term-coverage-all.svg)

![Terminal running the ai-sdr-worker test:coverage command, listing six passing test files
totaling 501 tests, then a coverage table with every file between 98 and 100
percent](screenshots/term-coverage-table.svg)

`@ventora/ai-sdr-worker` is the largest package in the repository and excludes nothing from
coverage.

![Terminal running pytest with coverage, showing every ventora_observability module at 100
percent, 206 statements with zero missed, and 116 tests passed in 2.72
seconds](screenshots/term-pytest-cov.svg)

## Charts

Generated from `docs/metrics.json`, so they cannot drift from the numbers in the docs.

![Horizontal stacked bar chart of source versus test lines per package, led by ai-sdr-worker at
19,591 total lines and ai-cs-worker at 11,254, down to ai-cs-contracts at
489](screenshots/chart-test-vs-source.svg)

![Horizontal bar chart of project lines by language: TypeScript 61,562, JavaScript 12,003, Python
9,336, Markdown 6,201, JSON 2,542, TOML 391, Other 70, and
YAML 14](screenshots/chart-language-mix.svg)

Lockfiles are excluded from the language chart and counted separately, which the caption inside
the image states as well.

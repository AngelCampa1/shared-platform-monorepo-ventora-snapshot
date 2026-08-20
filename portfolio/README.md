# Portfolio index

This directory is written for a reader, not for the author. Every claim in it traces to a file,
a line, or a number, and every number traces to the command in
[`scripts/repo-metrics.mjs`](../scripts/repo-metrics.mjs) that produced it. If a sentence here
says something the source doesn't back up, that's a bug in the documentation, not a style choice;
[`docs/goal-portfolio-public/LEDGER.md`](../docs/goal-portfolio-public/LEDGER.md) records the
audits that have already caught and fixed a few of those.

## If you read one thing

Read [ARCHITECTURE-CONTRACTS.md](ARCHITECTURE-CONTRACTS.md). The whole reason this repository
exists is one contract enforced across two runtimes, and that document is where the enforcement
mechanism (codegen for event names, AST extraction for redaction rules, an HTTP bridge for email)
is proven against the actual source rather than asserted in prose.

## Documents

| Document | Length | Summary |
| --- | ---: | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 216 lines | Trust model: the client-assertion boundary and the signed-context boundary, and the AI-SDR request path both gate |
| [ARCHITECTURE-CONTRACTS.md](ARCHITECTURE-CONTRACTS.md) | 133 lines | The Python-to-TypeScript email render bridge and the codegen/AST pipeline behind cross-language parity |
| [ARCHITECTURE-RUNTIME.md](ARCHITECTURE-RUNTIME.md) | 137 lines | Durable Object session state, the CRM outbox retry ladder, and the two self-hosted package registries |
| [ARCHITECTURE-PACKAGES.md](ARCHITECTURE-PACKAGES.md) | 85 lines | The `@ventora/*` dependency graph and what the repository deliberately does not have |
| [METRICS.md](METRICS.md) | 129 lines | Every headline number (scale, language mix, source-vs-test, coverage, the cross-language contract) with its source command |
| [SECURITY.md](SECURITY.md) | 293 lines | The redaction contract's real coverage, the auth model across all five Workers, the origin allowlist, secrets handling, what `@ventora/billing` touches, and the scope of what has been verified |
| [TESTING.md](TESTING.md) | 273 lines | The four test tiers, why "declared" isn't "passing", the coverage floor, and the nine steps of `pnpm verify` |
| [ENGINEERING-LOG.md](ENGINEERING-LOG.md) | 159 lines | Strictness settings quoted from the actual configs, the release flow, and how this repo's own docs stay honest |
| [GALLERY.md](GALLERY.md) | 150 lines | Every captured screenshot, terminal recording, and chart in one place |

`portfolio/screenshots/` holds every image referenced above: widget captures, email renders,
terminal SVGs, and generated charts. None of it is sourced from `output/`; see
[ENGINEERING-LOG.md's documentation-assets section](ENGINEERING-LOG.md#documentation-assets) for
why that directory is off-limits.

This directory holds the finite, evidence-backed retrospective; integration guides, the publishing
runbook, and this pass's own working ledger live in [`docs/`](../docs/PUBLISHING.md) instead.

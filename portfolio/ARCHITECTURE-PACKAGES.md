# Architecture: package layering and deliberate absences

Part of the [ARCHITECTURE.md](ARCHITECTURE.md) series. This document closes the loop: how the
`@ventora/*` packages depend on each other, and what the repository deliberately does not have.

---

## 7. Package layering

The dependency graph among `@ventora/*` packages is deliberately shallow. Reading it from the
`dependencies` and `peerDependencies` of every `packages/*/package.json`:

```text
ai-assistant-contracts ──┬── ai-sdr-contracts ──┬── ai-sdr-worker
                         │                      └── ai-sdr
                         └── ai-cs-contracts  ──┬── ai-cs-worker
                                                └── ai-cs
observability          ──┬── api-client
                         └── storage
email-templates        ─── email-renderer

no internal deps: analytics, auth-better, billing, email, seo,
package-registry, python-registry, third-grade-copy-skill
```

`@ventora/ai-assistant-contracts` holds what AI-SDR and AI-CS genuinely share: the HMAC payload
builder and verifier, `stableJson`, the base SSE event union, and
`createAssistantSseEventValidator`. Each product contracts package extends that base with its own
events: AI-SDR adds `plan.recommendation`, `trial.cta`, `handoff.requested`, and `lead.captured`
(`packages/ai-sdr-contracts/src/index.ts:180`). A Worker and its browser client depend on the same
contracts package, which is how the wire format stays in step across a deploy and a published npm
version.

Publishable packages follow a fixed shape: a `tsup.config.ts` emitting ESM, CJS, and `.d.ts`, a
`vitest.config.ts` with a 95% threshold, and `src/index.ts` as the barrel. The 5 Worker packages
skip the publish-only parts (no `exports` map, no tsup config) but keep strict types and the same
coverage gate. `docs/metrics.json` records 19 vitest configs carrying a 95 threshold with per-file
enforcement everywhere, and all 6 Python packages gated at `--cov-fail-under=95`.

Two smoke harnesses check the outside of the boundary rather than the inside.
`test-consumer/ts-consumer` installs the built `@ventora/*` packages and imports them the way a
product would; `test-consumer/py-consumer/smoke.py` does the same for the Python wheels. Both run
inside `pnpm verify` as `smoke:ts` and `smoke:py`.

<!-- metrics:test-scale:start -->
For scale: `docs/metrics.json` (regenerated and checked by `scripts/repo-metrics.mjs`) reports
21,740 lines of TypeScript source against 39,822 lines of TypeScript test across 2,059 test
cases, plus 448 Python test cases and 227 in Node's own test runner for the `scripts/` tooling.
<!-- metrics:test-scale:end -->
Those figures are generated. If you find them stale, `pnpm run metrics:check` will say so.

---

## 8. What is deliberately not here

**No GitHub Actions, and no GitHub-hosted anything.** CI is `pnpm verify` run locally, plus the
`simple-git-hooks` pre-commit hook that runs `lint-staged` and `scripts/run-affected-checks.mjs`.
Release is `pnpm release:cloudflare` for TypeScript and `pnpm publish:python` for Python. The
`.github` directory does not exist and adding one is called out as out of scope in `CLAUDE.md`.

**No shadow DOM in the widgets, and no shared database between Workers.** The first cost is paid
in scoped selectors, consistently rather than forgotten in one rule. The second means each
Worker's state is its own Durable Object namespace: the AI-SDR outbox does not know AI-CS exists,
and cross-boundary state moves as signed HTTP.

**No `any` in TypeScript, and no TODO markers.** Narrowing is done with explicit predicates:
`isProductContext`, `isSession`, `isCrmLeadIngestRequest`, `isLeadProfile`, and unknown input is
`unknown` until one of them proves otherwise.

**No product code.** Products live in their own repositories and consume published versions. This
repo is the propagation point, so a change here ships as a version bump, not a deploy, with the
five Workers as the only exception, since they are deploy-only and marked `"private": true`.

**No secrets in the tree.** `scripts/check-tracked-secrets.mjs` scans every git-tracked file for
OpenRouter key shapes and for real-looking values assigned to `AI_SDR_CONTEXT_SECRET` or
`CRM_INGEST_SECRET`, distinguishing them from placeholders such as `changeme` or `<...>`. It runs
as `secrets:check` inside `pnpm verify`. The three `wrangler.toml` files name their required
secrets in comments and nothing else; the two registry `wrangler.jsonc` files declare only an R2
binding and `ENVIRONMENT`.

---

Continue with [SECURITY.md](SECURITY.md): the redaction contract's real coverage, the auth model
across all five Workers, and the scope of what has been verified by reading the code.

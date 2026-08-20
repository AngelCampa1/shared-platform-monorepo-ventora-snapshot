# AGENTS.md

## Design Canon

- **Buttons are pills.** Treat fully rounded button geometry as a standing product preference. Every button or button-styled CTA should use pill corners (`border-radius: 9999px`, `rounded-full`, or equivalent), including primary/secondary actions, link-buttons, toolbar buttons, segmented/toggle controls, and icon buttons (circular when square). Do not introduce square or mildly rounded button shapes unless the user explicitly asks for that exception.

This file provides guidance to coding agents working in this repository. It mirrors `CLAUDE.md` and adds the sub-agent role/parallelism rules referenced from there.

## What This Repo Is

`ventora-platform` is the polyglot monorepo that houses shared infrastructure packages for Ventora products. Products (grantpipe, camaudit-v2, lextract, etc.) live in independent repos and consume these packages as private dependencies.

**This repo is the propagation point — not the product deployment point.** A change here ships by publishing a new package version; product repos pull it in.

## Architecture

Two parallel package trees publish the same surface area in two languages, kept in sync by shared schemas:

- `packages/` → TypeScript `@ventora/*`, pnpm + Turborepo workspace, built with tsup (ESM + CJS + `.d.ts`), published to the configured private package registry.
- `py/` → Python `ventora_*`, uv workspace, published independently. Mirrors the TS surface for backend services.
- `schemas/` → JSON source of truth (`analytics-events.json`, `billing-plans.schema.json`, `redaction-rules.json`). Cross-language contracts live here.
- `scripts/codegen-schemas.mjs` reads `schemas/analytics-events.json` and writes generated files into **both** `packages/analytics/src/_generated-events.ts` and `py/ventora_analytics/src/ventora_analytics/_generated_events.py`. Local CI's `schemas:check` fails if these drift from the schema.
- `test-consumer/{ts-consumer,py-consumer}` are smoke harnesses that import the built packages — use them to verify the consumer-facing API, not just internal unit tests.

The Python↔TS bridge that runs at runtime is `@ventora/email-renderer`: a Cloudflare Worker exposing `POST /render`. `ventora_email` (Python) calls it over HTTP so Python services can use React Email templates without a JS runtime.

The AI-SDR runtime is `@ventora/ai-sdr-worker`: a Cloudflare Worker exposing the shared AI-SDR session, chat, and handoff APIs. The AI-CS runtime is `@ventora/ai-cs-worker`: a separate Cloudflare Worker exposing authenticated app-support session, chat, context, and escalation APIs. Both are private and deploy-only. Everything else in this repo is published as package versions.

The private TypeScript package registry is `@ventora/package-registry`: a Cloudflare Worker exposing npm-compatible package metadata and tarball downloads backed by R2. It is deployed so product repos can install private `@ventora/*` packages. Package source still ships by publishing new versions into that registry.

## Commands

Root (runs across all TS packages via Turbo):
```bash
pnpm install
pnpm build                  # turbo run build
pnpm typecheck              # turbo run typecheck
pnpm test                   # turbo run test
pnpm test:coverage          # turbo run test:coverage (95% gate per package)
pnpm lint                   # biome check --write .
pnpm lint:ci                # biome check . (no autofix)
pnpm verify                 # local CI gate: schemas:check + lint:ci + typecheck + test:coverage + smoke tests
```

Single TS package:
```bash
pnpm --filter @ventora/analytics build
pnpm --filter @ventora/analytics test
pnpm --filter @ventora/analytics test -- src/events.test.ts        # single file
pnpm --filter @ventora/analytics test -- -t "redacts PII"           # single test by name
```

Python (workspace at `py/`):
```bash
cd py
uv sync
uv run pytest                                                       # all packages
uv run pytest ventora_analytics/tests                               # single package
uv run pytest ventora_analytics/tests/test_events.py::test_name     # single test
uv run pytest --cov=src --cov-report=term-missing --cov-fail-under=95
uv run mypy ventora_analytics/src
uv run ruff check ventora_analytics/src
```

Schema codegen (run after editing any file under `schemas/`):
```bash
pnpm schemas:generate       # regenerates TS + Python generated files
pnpm schemas:check          # CI mode — fails if generated files are stale
```

Release / publish:
```bash
pnpm changeset              # author a changeset for any package-touching change
pnpm release:cloudflare     # turbo run build && publish private packages to the Cloudflare registry
```

Deployable Workers:
```bash
pnpm --filter @ventora/email-renderer run deploy
pnpm --filter @ventora/ai-sdr-worker run deploy
pnpm --filter @ventora/ai-cs-worker run deploy
pnpm --filter @ventora/package-registry run deploy
```

## Quality Gates — Mandatory

- **95% coverage on every file you touch** (per file, not repo average). Both `vitest --coverage` and `pytest --cov-fail-under=95` enforce this.
- **No `any` in TypeScript** — use proper types or `unknown` with narrowing.
- **No TODO/FIXME/HACK comments** — fix it now or don't mention it.
- **No placeholder code** — every function fully implemented.
- **TDD cycle**: write failing test → confirm fail → implement → confirm pass → refactor.

## Package Conventions

Each TS package under `packages/` must have:
- `package.json` with `"name": "@ventora/<name>"`, `"version": "0.1.0"`, `exports` map
- `tsconfig.json` extending `../../tsconfig.base.json`
- `tsup.config.ts` emitting both ESM and CJS with `.d.ts`
- `vitest.config.ts` with coverage >= 95% threshold
- `src/index.ts` as the export barrel

Private deployable Worker packages under `packages/` may omit publish-only conventions such as `exports`, `tsup.config.ts`, `.d.ts` output, and an export barrel when they are not consumed as libraries. They still need `tsconfig.json`, `vitest.config.ts`, strict types, and coverage for touched source files.

Multiple subpath exports are normal (e.g. `@ventora/analytics` exposes `.`, `./browser`, `./server`, `./events`) — each subpath needs its own tsup entry and `exports` entry.

The pnpm workspace only includes `packages/*` and `test-consumer/ts-consumer` (see `pnpm-workspace.yaml`). Don't add new top-level workspace globs without coordination.

## Schemas Are the Contract

Never hand-edit `_generated-events.ts` or `_generated_events.py` — they're regenerated from `schemas/analytics-events.json`. If you need a new event, add it to the schema, run `pnpm schemas:generate`, then commit both the schema change and the generated files together.

## Worktree Policy

All feature/fix work must use a worktree under `.claude/worktrees/<branch>`.

## Process Safety

Never kill all `codex` processes or use broad process-kill commands that match Codex by name. Multiple parallel agents may be running; only stop a specific process you started and have positively identified.

## Local CI Only

This repo does not use a hosted CI service. Do not add `.github/workflows`, hosted release automation, or package-registry publishing config tied to a hosted CI provider.

CI is local. Treat `pnpm verify` plus the relevant Python package checks as the required CI gate before handoff. If release automation is needed, document or script it as part of the local release process.

## Deploy vs Publish

Packages are **published**, not deployed:
1. Run the local CI gate (`pnpm verify`) and package-specific Python checks.
2. Create the required changeset for package-touching changes.
3. Run the local release process that publishes to the Cloudflare private registry.

The deployed artifacts are `@ventora/email-renderer` (Cloudflare Worker `ventora-email-renderer`), `@ventora/ai-sdr-worker` (Cloudflare Worker `ventora-ai-sdr-worker`), `@ventora/ai-cs-worker` (Cloudflare Worker `ventora-ai-cs-worker`), and `@ventora/package-registry` (Cloudflare Worker `ventora-package-registry`). Product packages are published to the registry, not deployed.

## Sub-Agent Roles

### Orchestrator
- Owns task decomposition, context curation, schema changes, and integration.
- Does Phase A scaffolding directly. Delegates implementation to worker sub-agents.
- Reviews sub-agent output before marking work complete.

### Worker Sub-Agents (per-package)
Each package implementation agent receives:
- The package name and target directory
- Exact export signatures from the plan
- Seed file paths to read for pattern extraction
- Verification command to run before reporting done

Worker agents must report:
- Files created/modified
- Test coverage achieved
- Any blockers or assumptions made

### Reviewer Sub-Agent
Runs after each phase wave completes. Checks:
1. All exports declared in plan are present in `src/index.ts`
2. Test coverage meets 95% threshold
3. No `any` types, no `TODO` comments, no placeholder functions
4. `pnpm run build` passes for the package
5. Type declarations (`.d.ts`) present in `dist/`

## Parallelism Rules

- Phase B waves run in parallel — each agent writes to a disjoint package directory.
- No agent may write to `schemas/` — the orchestrator owns that.
- No agent may write to root `package.json`, `turbo.json`, or `pnpm-workspace.yaml`.
- Python agents write only under `py/<package_name>/`.
- TS agents write only under `packages/<package_name>/`.
- `test-consumer/` is orchestrator-only.

## Verification Per Package

TS packages:
```bash
cd packages/<name>
pnpm run build              # tsup emits dist/
pnpm run typecheck          # tsc --noEmit
pnpm run test:coverage      # vitest --coverage; 95% threshold
```

Python packages:
```bash
cd py/<name>
uv run pytest --cov=src --cov-report=term-missing --cov-fail-under=95
uv run mypy src/
uv run ruff check src/
```

## AI Agent Orchestration

AI agent instances operating in this repository are orchestrators. They must delegate exploration, implementation, verification, and other execution work to sub-agents whenever the work can be cleanly scoped, preserving the orchestrator's context window for coordination, integration, and final judgment.

## Required marketing copy pass

For this repo, all marketing copy must pass through both writing checks before completion:

1. Use the `humanizer` skill to remove AI-sounding, bloated, or generic copy.
2. Use the `third-grade-copy` skill to rewrite and audit the result for a third-grade reading level.

This applies to landing pages, hero copy, CTAs, pricing copy, onboarding copy, emails, ads, popups, social copy, SEO pages, and user-facing UI text that sells, explains, persuades, activates, or reassures.

Do not apply this rule to code identifiers, logs, API docs, technical docs for developers, exact legal text, database values, or user-generated content unless the user asks.

<!-- BEGIN: User-Facing Copy Guardrails -->
## User-Facing Copy Guardrails

For any user-facing copy in this repo, run the copy through these guardrails before you call the work done. This applies to product UI text, landing pages, hero copy, CTAs, pricing copy, onboarding copy, emails, ads, popups, social posts, SEO pages, help text, empty states, reassurance text, and any copy that sells, explains, persuades, activates, or reassures.

Required order:

1. Run the globally installed `humanizer` skill to remove AI-sounding, bloated, or generic copy.
2. Run the globally installed `third-grade-copy` skill to rewrite and audit the result for a third-grade reading level. The source package for this skill lives at `packages/third-grade-copy-skill/` in this repo; if the global skill is missing or stale, reinstall or sync it from there before finalizing copy.
3. Verify there are zero lies: no made-up numbers, claims, proof, testimonials, guarantees, rankings, integrations, prices, timelines, or capabilities. Check claims against the product source of truth before publishing.
4. Verify the message fits the whole place it appears: the page, flow, audience, offer, brand voice, surrounding copy, and user intent. Do not approve a line just because it is clear in isolation.

Do not apply this rule to code identifiers, logs, API docs, technical docs for developers, exact legal text, database values, or user-generated content unless the user asks.
<!-- END: User-Facing Copy Guardrails -->

## Working autonomously
- **Poll, don't idle.** When a task, build, test run, or hook is running, actively poll its status and output until it finishes. Don't just sit and wait passively for it to return.
- **Keep going.** When working toward a goal, finishing one chunk of work means moving straight to the next chunk. Don't stop and wait for further input mid-goal — continue until the goal is done or you are genuinely blocked.
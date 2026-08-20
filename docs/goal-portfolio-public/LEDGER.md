# Goal: Portfolio-public restructure

> Make this snapshot readable by a skeptical senior engineer in 90 seconds. Promote the
> retrospective write-ups out of `docs/` into a root `portfolio/` so they show in GitHub's
> file listing without scrolling. Verify every headline number against the tree rather than
> trusting the prose. Put real product UI on the page only if a capture exists that is
> actually good enough to show.
>
> The repo stays private. Visibility is the owner's call alone; nothing in this track
> changes it.

## Method

1. Read the tree first, then the prose. Any number in the README gets recomputed from the
   source of truth before it is promoted.
2. Split docs by who they address. Retrospective and reader-addressed goes to `portfolio/`.
   Prospective, self-addressed, and open-ended stays in `docs/`.
3. Move with `git mv` so history follows, then chase every inbound link: README, sibling
   docs, and tooling scripts that name a path.
4. Judge images by viewing them, never by filename. Reject on sight for error states, empty
   states, login walls, half-rendered layouts, or visible rendering bugs.
5. Re-run the gates that touch anything moved, before calling a cycle done.

## Cycle log

### Cycle 1 (2026-08-13): Metrics verification

- Recomputed all four headline claims independently of the prose: 20 TypeScript packages,
  6 Python packages, 5 deployed Workers, 95% per-file coverage floor. All four hold.
  Workers counted from the five `wrangler.toml`/`wrangler.jsonc` files under `packages/`;
  the coverage floor confirmed as `perFile: true` at 95 in all 19 `vitest.config.ts` files
  and `fail_under = 95` in all 6 Python `pyproject.toml` files.
- `node scripts/repo-metrics.mjs --check` reported the generated blocks stale. Regenerated:
  project lines moved 90,939 → 90,973 and files 433 → 434. No claim was overstated; the
  tree had simply grown since the last run.

### Cycle 2 (2026-08-13): Image harvest, and the decision not to use it

- Viewed 65 captures from the source repository's `output/shots/` and
  `output/playwright/` trees, hunting for a hero showing the embeddable assistant running
  in a real product. Rejected all 65. Adopted none.
- The snapshot's existing captures turned out to be the stronger set, and one of the best
  of them, the four-brand theme matrix, was only linked as text rather than embedded.
  Promoted it to a full-width embed.

### Cycle 3 (2026-08-13): Restructure and link repair

- `git mv` of `ARCHITECTURE.md`, `ENGINEERING.md`, and `GALLERY.md` from `docs/` into a new
  root `portfolio/`. Rewrote their 22 relative asset links to `../docs/assets/`.
- Repointed the README's six inbound links, added `portfolio/` to the repository-map code
  fence, restructured the Documentation table to lead with the three portfolio documents,
  and added three inline `→` callouts.
- Re-ran `node --test scripts/__tests__/repo-metrics.test.mjs` (49/49 pass) and
  `node scripts/repo-metrics.mjs --check` (up to date) after repointing the tooling.

## Findings registry

**P0 = broken or blocking · P1 = looks bad or confusing · P2 = polish**

| # | Pri | Finding | State |
|---|---|---|---|
| 1 | P0 | README described the `email-renderer` HMAC as covering "timestamp, nonce, method, path, and body hash". The Worker signs one canonical JSON string with the body nested inside it; there is no body hash on that path. A reader implementing against the prose would have failed every signature. | FIXED |
| 2 | P1 | The three portfolio-grade write-ups sat in `docs/` beside working notes and integration guides, so nothing distinguished a finished retrospective from a scratch file. | FIXED (root `portfolio/`) |
| 3 | P1 | The four-brand widget matrix, the single clearest piece of product UI in the repo, was buried in a parenthetical text link. | FIXED (embedded) |
| 4 | P1 | Alt text on the two widget embeds and the secret-scanner terminal named the state ("answered state, desktop") rather than describing what a reader who cannot see the image would need. | FIXED |
| 5 | P1 | Generated metric blocks had drifted from the tree by 34 lines and one file. | FIXED (regenerated) |
| 6 | P2 | `docs/metrics.json` was a candidate for promotion into `portfolio/`, but its path is pinned in `scripts/repo-metrics.mjs` and asserted in `scripts/__tests__/repo-metrics.test.mjs`. Moving it would have meant editing a test to accommodate a documentation reshuffle. Left in `docs/` and described in the repository map as generated output. | WONTFIX (deliberate) |
| 7 | P2 | Considered writing a fourth portfolio document collecting every metric with its command. `ENGINEERING.md` already carries the counting rules, the per-package exclusion table, and a section on how its own numbers are gated. A separate file would have been padding. | WONTFIX (deliberate) |
| 8 | P1 | Claimed the harvested live captures would give the page real product UI it lacked. Disproved on viewing: every live capture of an answered conversation renders literal `**` markdown in the reply, clips the panel mid-sentence behind the composer, and draws the close control as a lowercase `x`. The scripted captures already in the snapshot render all three correctly. | RETRACTED |
| 9 | P1 | Expected committed build and tooling residue to clean up: lint output, coverage dumps, `test_output.txt`, local `C:\Users\...` paths. Scanned every tracked file and found none of it. The tree was already clean. | RETRACTED |

### Cycle 4 (2026-08-13): Runbook status, a blind spot, and a stale chart

- `docs/PUBLISHING.md` read as a live runbook for infrastructure that no longer exists:
  present-tense instructions for two private registries that are shut down, with zero
  words in the file ("retired", "historical", "shut down") signaling that. Added a dated
  status note at the top framing the whole document as the historical release workflow.
  Left the 243 lines of instructional detail untouched below it: the note reframes, it
  does not rewrite. Fixed `README.md`'s Documentation table row, which called the
  registries "the two private registries" with no caveat.
- `portfolio/ARCHITECTURE.md` stated "39,818 lines of TypeScript test" against the real
  39,822 that `docs/metrics.json`, `README.md`, and `portfolio/ENGINEERING.md` all agree
  on. It survived because the sentence sat outside every `<!-- metrics:...:start/end -->`
  marker, so `metrics:check` never looked at it. Closed the gap the way the rest of the
  document's numbers are closed: added a `test-scale` block to `scripts/repo-metrics.mjs`
  and wrapped the sentence in markers, so it is now written by the same generator and
  gated by the same check, not merely hand-corrected.
- `docs/assets/chart-language-mix.svg` and `chart-test-vs-source.svg` had drifted from
  `docs/metrics.json`: the charts are opt-in output (`--charts`) with no drift check, so
  nothing caught it. Regenerated both with `node scripts/repo-metrics.mjs --charts` and
  updated the two alt-text lines in `portfolio/GALLERY.md` that quoted the old numbers.
  Then closed that gate too: `--check` now renders both charts from the current metrics
  and fails if either file on disk doesn't match, the same comparison it already ran for
  `docs/metrics.json`. Verified the failure mode directly by corrupting one figure in the
  SVG and confirming `--check` caught it before restoring the correct file.
- `node scripts/repo-metrics.mjs --check` reports up to date. `pnpm run test:scripts`
  reports 196/196.

### Cycle 5 (2026-08-18): Standard compliance: index, split docs, images, house style

- Applied the full `PORTFOLIO-STANDARD.md` heading order to `README.md`: status as
  `> [!IMPORTANT]`, byline/license teaser as `> [!NOTE]`, added `## Contents`,
  `## If you read one thing`, `## Architecture` (previously only "The five Workers" /
  "At a glance", no heading of that exact name existed), `## Testing`, `## Screenshots`,
  `## Built with AI agents`, `## Known gaps`, `## Who built this`, and `## License`
  (previously folded into an unheaded closing "Status and use" section). The first
  `portfolio/` link now appears in the pitch's first screenful instead of at line 105.
- Wrote the required `portfolio/README.md` index (was missing entirely) and the required
  `portfolio/METRICS.md` and `portfolio/TESTING.md` (both missing entirely), the latter
  built from real content that already existed in `ENGINEERING.md` rather than invented.
  Renamed `ENGINEERING.md` → `ENGINEERING-LOG.md` per the spec's name resolution table.
- Split the two oversized documents by sub-topic rather than trimming substance:
  `ARCHITECTURE.md` (531 lines) → `ARCHITECTURE.md` (trust model + request path, 216
  lines) plus `ARCHITECTURE-CONTRACTS.md` (133), `ARCHITECTURE-RUNTIME.md` (137), and
  `ARCHITECTURE-PACKAGES.md` (79). `ENGINEERING.md` (425 lines, already inside the
  120 to 450 line band but close to it and instructed to split) → `TESTING.md` (273, the four
  test tiers, coverage floor, gates-that-reject) and `ENGINEERING-LOG.md` (159,
  strictness settings, release flow, documentation-asset generation). Updated
  `scripts/repo-metrics.mjs`'s `TARGET_BLOCKS`/`CHART_TARGETS` maps so the generated
  `coverage-config` and `test-scale` blocks follow their content into the new files, and
  added `portfolio/METRICS.md` as a third gated target for the `at-a-glance` block.
- **Images: investigated the 86-ish real UI captures under `output/shots/` and
  `output/playwright/` in the source repository a second time, at higher resolution than
  Cycle 2's pass, and confirmed rather than reversed that rejection.** Opened roughly two
  dozen individually. Every capture with an "answered" filename (a completed
  question-and-reply turn) renders the reply at near-zero opacity (text present in the
  DOM but visually unreadable) in both light and dark themes, on both AI-SDR and AI-CS,
  on desktop and mobile. Captures with "settled", "typed", "initial", or "panel-open" in
  the filename render cleanly. The cause is stated directly in this repository's own
  `scripts/docs/capture-docs-shots.mjs`: it exists specifically because its sibling
  `scripts/e2e/screenshots.mjs` captures "mid-animation" and text can appear "half-faded,"
  and it disables CSS transitions before the shutter fires to prevent exactly the defect
  observed in `output/`. Reusing `output/` captures would have contradicted this
  repository's own already-published claim, in the pre-existing `ENGINEERING.md`, that "no
  asset is ever sourced from `output/`." Left that policy intact and did not pull any file
  from `output/` into this repository.
- Relocated the images that were already properly sourced instead: moved all 19 files from
  `docs/assets/` to the newly required `portfolio/screenshots/` (9 real product-UI PNGs, 3
  email-render PNGs, 5 terminal-capture SVGs, 2 chart SVGs, 1 hand-drawn system-map SVG),
  per the spec's "referenced images live in `portfolio/screenshots/`" rule. Repointed
  every reference in `README.md` and `portfolio/*.md`, and every path constant in
  `scripts/repo-metrics.mjs`, `scripts/docs/capture-terminal-svgs.mjs`,
  `scripts/docs/capture-docs-shots.mjs`, `scripts/docs/render-email-previews.mjs`, and
  `scripts/docs/term-svg.mjs`'s docstring. Updated `.gitignore`'s
  `docs/assets/.tmp/` → `portfolio/screenshots/.tmp/` and the one test fixture path in
  `scripts/__tests__/repo-metrics.test.mjs` that named the old location.
- Gave `README.md` a real hero: the four-brand widget-matrix screenshot, already praised
  in Cycle 2 as the strongest single capture, promoted above `## Contents` with
  substantive alt text and an italic sourcing caption. Added a `## Screenshots` section
  built with the HTML `<table>` grid pattern (four widget pairs plus the email-template
  sheet), and rebuilt `portfolio/GALLERY.md`'s pipe-table image grids (previously at
  lines 26 to 66) as HTML tables with the caption in a separate row from the image, matching
  the pattern this repository's own README already used elsewhere.
- House style: confirmed zero untagged opening code fences across `README.md` and every
  `portfolio/*.md` (closing fences are correctly bare, only openings need the tag).
  Reflowed prose to 100 columns throughout the touched files; table rows and single
  unbreakable tokens are exempt, consistent with the existing corpus.
- Verification: wrote a link-checker that resolves every `[text](path)` and `src="path"`
  reference in `README.md` and `portfolio/*.md` against disk. Found and fixed one
  (`portfolio/METRICS.md` linking to `PORTFOLIO-STANDARD.md`, which lives outside every
  repo by design and should not be a repo-internal link). `node scripts/repo-metrics.mjs
  --check` reports up to date after regeneration; `node --test` across all ten
  `test:scripts` files reports 196/196; `npx biome check` on every edited script reports
  clean. Two numbers regenerated as a side effect of the doc-file-count change (JavaScript
  12,001 → 12,003 lines from the script edits above; Markdown 66/5,238 → 72/5,770 files
  from the new/renamed portfolio docs) were hand-verified against the regenerated
  `docs/metrics.json` and chart SVGs and corrected in the two places they were quoted in
  prose outside a generated marker (`portfolio/METRICS.md`, `portfolio/GALLERY.md`).

### Cycle 6 (2026-08-18): Self-referential claim, and the missing SECURITY.md

- The README's own `## Built with AI agents` section made a checkable claim about this
  ledger and got the check wrong: it said "four documented audit cycles against nine
  findings (seven fixed, one retracted claim, one deliberate wontfix)." Recounted directly
  from this file: five cycles (1 through 5), and a findings registry of 9 rows: 5 FIXED
  (#1-5), 2 WONTFIX (#6-7), 2 RETRACTED (#8-9). Only the total of nine survived. Corrected
  the sentence to "five documented audit cycles against nine findings (five fixed, two
  retracted claims, two deliberate wontfixes)," worded as "through Cycle 5" so the claim
  stays true after this cycle is appended rather than needing a further correction next
  pass.
- `PORTFOLIO-STANDARD.md`'s §2.4 requires `SECURITY.md` (or a named equivalent) for any
  repo touching PHI, PII, payments, or financial data. This repo carries a redaction
  contract with a HIPAA-18 extension and a Stripe billing package, and had neither:
  the material existed, scattered across `ARCHITECTURE.md` and
  `ARCHITECTURE-CONTRACTS.md`, but nothing consolidated it under a named document.
  Wrote `portfolio/SECURITY.md` (290 lines) from the tree directly, re-verifying rather
  than restating the redaction counts against `schemas/redaction-rules.json` (35 field
  keys, 7 base patterns, 4 HIPAA-18 extensions, 1 key pattern; all four matched what
  `ARCHITECTURE-CONTRACTS.md` already claimed). Covers the auth model across all five
  Workers (HMAC client assertion for AI-SDR/AI-CS, HMAC canonical-string signing for
  email-renderer, bearer/basic tokens for both registries), the origin allowlist (12
  hosts for AI-SDR, 11 for AI-CS, confirmed by reading both `wrangler.toml` files
  directly rather than trusting the "twelve hosts" already in `ARCHITECTURE.md`), the
  tracked-secrets scanner (ran `node scripts/check-tracked-secrets.mjs` against the tree:
  exit 0, no hits), and what `@ventora/billing`'s six files (436 lines) actually touch,
  notably that card data never reaches this codebase because checkout and billing-portal
  sessions are Stripe-hosted redirects. Closes with an explicit "what is NOT protected"
  section: no audit, no penetration test, no certification has been run against anything
  in this repository, the TypeScript Workers redact PII by call-site convention rather
  than an enforced filter (unlike Python's logging pipeline, which calls `redact()`
  automatically), and the secret scanner only checks the current tree, not git history.
  Cross-links `ARCHITECTURE-CONTRACTS.md`, `ARCHITECTURE.md`, and `ARCHITECTURE-RUNTIME.md`
  rather than duplicating their sequence diagrams or code excerpts.
- Added `SECURITY.md` to `portfolio/README.md`'s index table with its real `wc -l` length,
  positioned after `ARCHITECTURE-PACKAGES.md` and before `METRICS.md` to keep the
  architecture-adjacent documents grouped together.
- `portfolio/ARCHITECTURE-PACKAGES.md`, the last of the four split architecture documents,
  ended cold with no closing transition: its three siblings all end with a "Continue
  with X.md" pointer and this one didn't. Added one, pointing at the new `SECURITY.md`,
  which also required bumping its length in the `portfolio/README.md` index table from
  79 to 85 lines.
- Verification: wrote a link/anchor checker (`node` script, not `rg`, since this shell
  runs `rg` only interactively) that resolves every `[text](path)` and `[text](path#anchor)`
  in every `portfolio/*.md` file and the root `README.md` against the real files on disk
  and each target's actual heading list, slugified the same way GitHub does. Ran it after
  every edit in this cycle: zero broken links, zero broken anchors, across all nine
  `portfolio/*.md` files plus `README.md`.

### Cycle 7 (2026-08-18): Origin-allowlist domain count, and a four-brands disclosure

- `portfolio/SECURITY.md`'s "Origin allowlist" section said `AI_SDR_ALLOWED_ORIGINS` spans
  "four product domains." Recounted directly from `packages/ai-sdr-worker/wrangler.toml:17`:
  12 hosts, but they resolve to 5 apex domains (`lextract.app`, `lextract.io`, `camaudit.io`,
  `camaudit.app`, `capveri.com`), which belong to 2 products: Lextract, and CapVeri (whose
  domains split across its current brand, `capveri.com`, and its former CAMAudit brand,
  `camaudit.io`/`camaudit.app`). Rewrote the sentence to state the host count, the domain
  count, and which products they belong to, instead of the wrong "four." Also checked the
  adjacent `AI_CS_ALLOWED_ORIGINS` claim ("lists 11, the same set minus
  `https://api.camaudit.io`") against `packages/ai-cs-worker/wrangler.toml:9` rather than
  assuming it was right, by diffing the two host lists directly: it holds exactly as stated.
- No reader-facing document in this repo told a reader that CAMAudit and CapVeri are the same
  product. `README.md`'s hero caption and `portfolio/GALLERY.md`'s "Four brands, one build"
  section both caption the same screenshot as four product themes (CAMAudit, CapVeri,
  GrantPipe, Lextract), which is accurate as a theme count but reads as a product count to a
  reader with no other information. Added one clause to each: "CAMAudit and CapVeri are the
  same product under its old and new names, so these four themes correspond to three
  products." The counterpart disclosure (CapVeri's own README stating it was formerly
  CAMAudit) lives in `cam-reconciliation-saas-capveri-snapshot/README.md`, a separate repo.
- Investigated whether `grantpipe`'s README claim that `@ventora/ai-cs` "powers the in-app AI
  support widget" is authorized anywhere in this repo, since no `grantpipe.*` origin appears
  in either `AI_SDR_ALLOWED_ORIGINS` or `AI_CS_ALLOWED_ORIGINS` (confirmed absent, grep exit
  1). Found that GrantPipe was a real integration target, not a fabrication: it has a shipped
  brand theme (`packages/ai-cs/src/react/styles.ts`, accent `#15803d`), is listed as a brand
  preset in `docs/AI_WIDGET_EMBED_SNIPPETS.md`, and appears with placeholder
  `https://grantpipe.example.com` entries in `scripts/ai-secrets-manifest.json`, but it is
  now explicitly blocked as a retired product/app ID: `AI_SDR_ALLOWED_ORIGINS`'s worker holds
  `RETIRED_PRODUCT_IDS = new Set(["grantpipe"])` (`packages/ai-sdr-worker/src/index.ts:128`,
  returning 403 "Product retired" from `handleSessionCreate`), and `AI_CS_ALLOWED_ORIGINS`'s
  worker has the matching `isRetiredAiCsAppId` check (`packages/ai-cs-worker/src/index.ts:523`,
  403 "App retired"). Both workers also run the origin allowlist check before either retirement
  check, so a GrantPipe origin would already be rejected at that earlier stage even without the
  retirement guard. No `CHANGELOG.md` in either worker package records when or why GrantPipe
  was retired. This is left to the owner to reconcile with the GrantPipe README, per scope:
  no file under `grantpipe.*` was touched.
- Recomputed every length cell in `portfolio/README.md`'s index table with `wc -l` after the
  edits above: `SECURITY.md` 290 → 293 lines, `GALLERY.md` 149 → 150 lines. The other seven
  rows were unchanged and re-verified to already match. Re-checked every relative link and
  `#anchor` referenced from `portfolio/README.md`, `README.md`, and `portfolio/GALLERY.md`
  against the real files and heading lists on disk: all resolve.

## Open for the owner

- The assistant widget's markdown rendering is a real product defect, visible in every live
  capture across all six products: replies arrive as markdown and render as literal
  `**asterisks**`. It is out of scope for a documentation pass and the products are retired,
  so it is recorded here rather than fixed. The README shows the scripted captures, which
  render correctly, and does not claim otherwise.

### Cycle 8 (2026-08-18): Corpus-wide index column order, and two length cells that drifted mid-pass

- The cross-repo standard fixed `portfolio/README.md`'s index table column order as link,
  length, summary. This repo's table had `Document | Summary | Length`, length last,
  reordered to `Document | Length | Summary`; all nine rows and the alignment row updated.
- Recomputing every length cell against `wc -l` after the edit caught two rows drifted during
  this session (not from this pass's own edits, since `portfolio/*.md` content was never
  touched here): `GALLERY.md` 149→150 lines, `SECURITY.md` 290→293 lines. Corrected both
  cells to match each file's committed state at completion.
- Ran a relative-link and `#anchor` resolution sweep over `README.md` and every
  `portfolio/*.md` file: all resolve.

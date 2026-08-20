# Publishing Guide - ventora-platform

> **Status: historical record, 2026-08-13.** This document describes the release workflow
> as it ran while Ventora Labs was actively publishing packages. The two private registries
> it describes (`@ventora/package-registry` and `@ventora/python-registry`) are shut down.
> No command below can be run against a live registry today. The steps are kept for the
> detail of how the process worked, not as instructions to follow now.

TypeScript packages under `packages/` are published under the `@ventora` scope to the Ventora private registry hosted on Cloudflare Workers and R2, except deploy-only Workers such as `@ventora/email-renderer`, `@ventora/ai-sdr-worker`, `@ventora/ai-cs-worker`, and the two registry Workers (`@ventora/package-registry`, `@ventora/python-registry`). Python packages (`ventora_*`) are published to a private Cloudflare-hosted Python index (the `@ventora/python-registry` Worker) and can also still be path-installed via `uv add --editable` for local development.

This repo does not use GitHub, GitHub Actions, GitHub PRs, GitHub Packages, or `npm.pkg.github.com`. CI and release verification are local.

---

## 1. One-Time Setup

Configure the Cloudflare registry once, then configure npm/pnpm authentication for `@ventora/*` packages.

### Cloudflare resources

From this repo:

```bash
pnpm install
pnpm --filter @ventora/package-registry exec wrangler login
pnpm --filter @ventora/package-registry exec wrangler r2 bucket create ventora-package-registry
```

The registry intentionally does not use KV. Package metadata is stored as small JSON objects in the same private R2 bucket as the package tarballs to avoid KV read/write costs.

Generate two long random tokens outside source control:

```bash
pnpm --filter @ventora/package-registry exec wrangler secret put REGISTRY_READ_TOKEN
pnpm --filter @ventora/package-registry exec wrangler secret put REGISTRY_ADMIN_TOKEN
```

`REGISTRY_READ_TOKEN` is for product repos that install packages. `REGISTRY_ADMIN_TOKEN` is for local publishing and can also read packages.

Deploy the registry Worker:

```bash
pnpm --filter @ventora/package-registry run deploy
```

Wrangler prints the deployed `workers.dev` URL after a successful deploy. The default shape is:

```text
https://ventora-package-registry.<your-cloudflare-subdomain>.workers.dev
```

Use that full host in the npm settings below, or configure a custom Cloudflare route and use that host instead.

Cloudflare Workers and R2 have free tiers and usage-based billing. This registry is designed for low internal traffic, so normal Ventora package publishing/installing should be small, but billing still depends on actual Worker requests, Worker CPU, R2 storage, and R2 operations in the Cloudflare account. R2 has no egress charges, but reads and writes are still operations. The Worker config sets a 50 ms CPU limit and 1% observability sampling to reduce runaway-bill risk.

### npm/pnpm authentication

Use the deployed Worker URL or a custom Cloudflare route. Keep credentials out of source control.

Product repos use the read token:

```ini
@ventora:registry=https://<registry-host>/
//<registry-host>/:_authToken=${VENTORA_REGISTRY_TOKEN}
```

For local publishing, put the admin token in the repo-local ignored file `.env.publish.local`:

```dotenv
VENTORA_REGISTRY_URL=https://<registry-host>/
VENTORA_REGISTRY_HOST=<registry-host>
VENTORA_REGISTRY_TOKEN=<admin-token>
```

`.env.publish.local` is intentionally ignored by git. Agents can then run `pnpm publish:cloudflare` or `pnpm release:cloudflare` without re-entering the token. Shell variables still take precedence when set explicitly:

```powershell
$env:VENTORA_REGISTRY_URL = "https://<registry-host>/"
$env:VENTORA_REGISTRY_HOST = "<registry-host>"
$env:VENTORA_REGISTRY_TOKEN = "<admin-token>"
```

`VENTORA_REGISTRY_HOST` is intentional typo protection. For the default `workers.dev` URL it is optional, but set it anyway once you know the host. For a custom domain it is required.

---

## 2. First Publish

The first publish creates version `0.1.0` for all packages already set in each `package.json`.

```bash
# 1. Run the local CI gate
pnpm verify

# 2. Create a changeset describing the initial release
pnpm changeset

# 3. Bump versions according to the changeset
pnpm changeset version

# 4. Build all packages and publish to Cloudflare
pnpm release
```

`pnpm release` delegates to `pnpm release:cloudflare`, which runs `turbo run build` then uploads package tarballs and npm metadata to the private Cloudflare registry. The publish script stages each package locally, rewrites internal `workspace:*` dependencies to the current package versions inside the packed tarball, then uploads through the registry Worker.

---

## 3. Regular Release Cycle

After the initial publish, the standard local workflow is:

1. Make changes in a worktree.
2. Add a changeset before handoff:
   ```bash
   pnpm changeset
   # Select the packages affected, choose patch/minor/major, write a summary
   ```
   This creates a new markdown file in `.changeset/`.
3. Run the local CI gate:
   ```bash
   pnpm verify
   ```
4. Run any relevant Python package checks:
   ```bash
   cd py
   uv run pytest --cov=src --cov-report=term-missing --cov-fail-under=95
   uv run mypy <package>/src
   uv run ruff check <package>/src
   ```
5. Run the local release process:
   ```bash
   pnpm changeset version
   pnpm release
   ```

Never manually edit `CHANGELOG.md` files. Changesets manages them.

### Changeset types

| Type | When to use |
|---|---|
| `patch` | Bug fixes, documentation-only changes |
| `minor` | New backwards-compatible functionality |
| `major` | Breaking changes that require consumer migration |

---

## 4. Consumer Setup

Each product repo that consumes `@ventora/*` packages needs registry authentication for the same private registry.

### `.npmrc` in the product repo root

```ini
@ventora:registry=https://<registry-host>/
//<registry-host>/:_authToken=${VENTORA_REGISTRY_TOKEN}
```

### Install

```bash
pnpm add @ventora/observability @ventora/analytics
# etc.
```

### Local CI

In the product's local CI environment, ensure `pnpm install` runs with the private registry token available:

```bash
VENTORA_REGISTRY_TOKEN=<read-token> pnpm install --frozen-lockfile
```

---

## 5. Python Packages

Python packages (`ventora_*`) publish to a private Cloudflare-hosted Python index, the
`@ventora/python-registry` Worker (`ventora-python-registry`). It is the Python sibling of
the `@ventora/package-registry` npm index: an R2-backed Worker that serves a PEP 503/691
"simple" index and accepts the PyPI legacy multipart upload protocol, gated by the same
read/admin token model. The packages are `UNLICENSED`/proprietary, so they never go to
public PyPI.

### One-time setup

Mirror the npm registry setup. From this repo:

```bash
pnpm --filter @ventora/python-registry exec wrangler login
pnpm --filter @ventora/python-registry exec wrangler r2 bucket create ventora-python-registry
pnpm --filter @ventora/python-registry exec wrangler secret put REGISTRY_READ_TOKEN
pnpm --filter @ventora/python-registry exec wrangler secret put REGISTRY_ADMIN_TOKEN
pnpm --filter @ventora/python-registry run deploy
```

`REGISTRY_READ_TOKEN` is for product repos that install packages; `REGISTRY_ADMIN_TOKEN`
is for local publishing and can also read. Wrangler prints the deployed host, e.g.
`https://ventora-python-registry.<subdomain>.workers.dev`.

For local publishing, add the admin token to the repo-local ignored `.env.publish.local`:

```dotenv
VENTORA_PYTHON_REGISTRY_URL=https://<python-registry-host>/
VENTORA_PYTHON_REGISTRY_HOST=<python-registry-host>
VENTORA_PYTHON_REGISTRY_TOKEN=<admin-token>
```

### Publishing

After bumping versions in the relevant `py/<package>/pyproject.toml` (and recording the
change in `py/RELEASE_NOTES.md`), run:

```bash
# build + upload every workspace package; already-published files are skipped
pnpm publish:python

# or scope to specific packages, and preview without uploading
pnpm publish:python -- --packages ventora-billing,ventora-storage
pnpm publish:python -- --dry-run
```

The script builds each package with `uv build`, computes each artifact's SHA-256, checks
the simple index for idempotency, and uploads the wheel and sdist via the Worker's
`/legacy/` endpoint. `uv` must be on `PATH` (or set `UV_BIN`). Files are immutable: a
version's wheel/sdist cannot be overwritten, so bump the version to republish.

### Consumer setup

Product repos add the index and authenticate with the read token:

```toml
# pyproject.toml in a product repo
[[tool.uv.index]]
name = "ventora"
url = "https://<python-registry-host>/simple/"
```

```bash
# credentials for the private index (keep out of source control)
export UV_INDEX_VENTORA_USERNAME=__token__
export UV_INDEX_VENTORA_PASSWORD=<read-token>
uv add ventora-observability ventora-analytics
```

Local path installs via `uv add --editable ../ventora-platform/py/<package>` remain
available for sibling-checkout development.

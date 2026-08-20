# AI-SDR / AI-CS secrets runbook

The durable answer to "the AI widgets stopped working / secrets drifted." This
repo is the propagation point for the two shared AI runtimes; their HMAC secrets
must agree across the central worker and every product. This runbook + the doctor
turn silent drift into a visible red row.

## The model in one paragraph

Two central Cloudflare Workers serve every product:

- **AI-SDR** (`ventora-ai-sdr-worker`) — anonymous marketing widget.
- **AI-CS** (`ventora-ai-cs-worker`) — authenticated in-app support widget.

Each talks to a product over **two HMAC handshakes**, so there are **two shared
secrets per agent**:

1. **Client assertion** — the product BFF signs its `POST /v1/*` calls to the
   worker; the worker validates. (`AI_SDR_CLIENT_ASSERTION_SECRET`,
   `AI_CS_CLIENT_ASSERTION_SECRET`.)
2. **Context** — the worker signs a `GET` to the product's context endpoint; the
   product validates the request, returns context, and signs its response, which
   the worker validates. (`AI_SDR_CONTEXT_SECRET`, `AI_CS_CONTEXT_SECRET`.)

For each secret, **the worker's copy and every product's copy must be byte-identical.**
Cloudflare secrets are write-only, so a mismatch is invisible until a user hits a
401/502. That is what the doctor exists to catch.

The HMAC scheme (identical on every side):

```
payload   = `${timestamp}.${nonce}.${METHOD}.${path}.${sha256Hex(stableJson(body))}`
signature = HMAC_SHA256(secret, payload)   // hex
headers   = X-Ventora-Timestamp (ISO), X-Ventora-Nonce, X-Ventora-Signature
```

`stableJson` sorts object keys recursively. Skew window 300s; nonces are
replay-protected. Client-assertion signs over `path = pathname` only; context
signs over `path = pathname + search`. The context request body is
`{appId, userId}` (AI-CS) or `{productId}` (AI-SDR) — **nothing else** (no
`currentPath`; it travels in the query string).

## Canonical values

Live in the gitignored `.ai-secrets.local` at this repo root, mirrored into each
product repo's own `.ai-secrets.local`. **Never commit values.** The manifest and
this runbook hold names only.

## Daily / pre-handoff check

```bash
pnpm ai-secrets:doctor          # human table, exits non-zero on drift
pnpm ai-secrets:doctor -- --json   # machine-readable
```

The doctor reads `scripts/ai-secrets-manifest.json` + `.ai-secrets.local` and, for
every surface in the manifest, signs a real probe with the canonical value:

- **client-assertion** → `POST /v1/sessions` with canonical secret: `201`=GREEN,
  `401`=DRIFT. Plus a disallowed-origin control that must `403`.
- **context** → signs a `GET` to each product context endpoint as the worker:
  `200`=GREEN; any body that names the signature as invalid (e.g. `Invalid
  signature`, `INVALID_SIGNATURE`)=DRIFT; a downstream authz failure
  (membership/unknown-user `401/403/404`) still means the **signature was
  accepted** = secret OK; `503`=UNSET. For AI-CS the probe also appends a
  `currentPath` query param (as a real chat does) while keeping the signed body
  `{appId,userId}`. That combination is what catches a handler that wrongly folds
  `currentPath` into the signed body: sessions and a probe without `currentPath`
  both look healthy, and every real chat turn still 401s.

The canonical `.ai-secrets.local` uses canonical key names, not whatever a given
product happens to call the variable in its own wrangler config. Per-product
naming quirks live in the manifest; the doctor keys off canonical names only.

Every product in the manifest is probed. An undeployed or unreachable domain
surfaces as a `DARK` row (detected from the network failure itself) instead of
being silently skipped.

> The doctor catches **secret drift**, not code-contract bugs. For the full
> "does chat actually answer" proof, run the per-repo authenticated E2E with the
> test creds in each repo's `.ai-secrets.local`.

## Fixing drift

When the doctor shows DRIFT or UNSET, re-provision the offending side with the
canonical value. Cloudflare secrets apply immediately (no redeploy):

```bash
# Run from the directory holding the target surface's wrangler config:
printf '%s' "<canonical value>" | npx wrangler secret put <NAME>
```

The two central workers are provisioned from `packages/ai-sdr-worker` and
`packages/ai-cs-worker`. Each product is provisioned from wherever that product
repo keeps its own wrangler config, which is not always the repo root: a product
that bundles its BFF into a frontend build provisions from the frontend
directory, one with a separate API worker provisions from the API directory.

Two things to check in the manifest before assuming a name:

- A product may read a product-specific context variable instead of the canonical
  one. The value is still the canonical secret; only the variable name differs.
  Each product's `productCtxVar` records what that product actually reads.
- A product may expose the product-specific name *alongside* the canonical one.

## After deploying a product that bundles its BFF

Re-provisioning secrets does **not** ship code. Cloudflare applies a new secret to
the already-deployed script. If you changed product proxy code, run the product's
full build and deploy, not the deploy step alone: a deploy-only command re-ships
the previously built artifact and silently deploys stale code.

## Rotating a secret (all sides at once)

1. Generate a new value.
2. `wrangler secret put` it on the worker **and** every product that shares it.
   Update `.ai-secrets.local` here and in each product repo.
3. `pnpm ai-secrets:doctor` → expect all GREEN.
4. Run the per-repo authenticated chat E2E for at least one product per agent.

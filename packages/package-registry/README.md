# @ventora/package-registry

Cloudflare Worker exposing an npm-compatible package registry (metadata + tarball download + publish) backed by R2, so product repos can install private `@ventora/*` packages.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /-/ping` | Liveness check. |
| `PUT /-/ventora/packages` | Publish a package version (packument + base64 tarball). Requires admin token. |
| `GET /@ventora/<name>` | Fetch the packument (npm `dist-tags`/`versions`/`time`) for a package. Requires read or admin token. |
| `GET /@ventora/<name>/-/<tarball>.tgz` | Download a published tarball. Requires read or admin token. |

## Configuration

| Binding / secret | Purpose |
| --- | --- |
| `REGISTRY_BUCKET` (R2 bucket) | Stores packuments (`metadata/<name>/packument.json`), tarballs (`tarballs/<name>/<version>/<file>.tgz`), version claims, and per-package publish locks. |
| `ENVIRONMENT` (var) | Set to `production`. |
| `REGISTRY_READ_TOKEN` (secret) | Bearer token authorizing metadata/tarball reads. |
| `REGISTRY_ADMIN_TOKEN` (secret) | Bearer token authorizing publish; also satisfies read checks. |

## Deploy

```bash
pnpm --filter @ventora/package-registry run deploy
```

## Notes
- Publish is protected by a per-package R2 lock (`onlyIf: { etagDoesNotMatch: "*" }`, 15-minute TTL, up to 25 acquire attempts with a 20ms backoff) plus a separate per-version claim object, so two concurrent publishes of the same package or version cannot race each other or partially overwrite a packument.
- Every published tarball is verified against its declared integrity before it is written: the gzip magic bytes (`0x1f 0x8b 0x08`) are checked, then the SHA-512 (`sha512-<base64>` npm integrity string) and SHA-1 shasum are recomputed and compared with a timing-safe equality check.
- Bearer tokens (`REGISTRY_READ_TOKEN`, `REGISTRY_ADMIN_TOKEN`) are compared with the same constant-time `timingSafeEqual`, not `===`, to avoid timing side-channels on auth checks.

# @ventora/python-registry

Cloudflare Worker exposing a PEP 503/691 "simple" Python package index plus the PyPI legacy multipart upload endpoint, backed by R2, so product repos can install private `ventora_*` packages with `uv`.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /-/ping` | Liveness check. |
| `POST /legacy`, `POST /legacy/` | Legacy PyPI multipart upload (`:action=file_upload`). Requires admin token. |
| `GET /simple/<project>/` | PEP 503/691 project index; returns JSON (`application/vnd.pypi.simple.v1+json`) or HTML depending on `Accept`. Requires read or admin token. |
| `GET /files/<project>/<filename>` | Download a wheel or sdist. Requires read or admin token. |

## Configuration

| Binding / secret | Purpose |
| --- | --- |
| `REGISTRY_BUCKET` (R2 bucket) | Stores project indexes (`metadata/<name>/index.json`), files (`files/<name>/<filename>`), upload claims, and per-project publish locks. |
| `ENVIRONMENT` (var) | Set to `production`. |
| `REGISTRY_READ_TOKEN` (secret) | Token authorizing index/file reads (sent as HTTP Basic password or Bearer token). |
| `REGISTRY_ADMIN_TOKEN` (secret) | Token authorizing upload; also satisfies read checks. |

## Deploy

```bash
pnpm --filter @ventora/python-registry run deploy
```

## Notes
- Content negotiation on `/simple/<project>/` follows PEP 691: an `Accept: application/vnd.pypi.simple.v1+json` request gets the JSON simple-index format, everything else gets the PEP 503 HTML link list, both served from the same `ProjectIndex` record.
- Project names are normalized per PEP 503 (`normalizeName`) and restricted to the `ventora-*` pattern; filenames are validated against the escaped distribution name and classified as wheel or sdist before they are accepted or served.
- Auth accepts either an HTTP Basic `Authorization` header (the password half, since `uv`/`pip` send `<username>:<token>`) or a Bearer token, compared with a constant-time `timingSafeEqual`; a missing/invalid token gets a `WWW-Authenticate: Basic` challenge so CLI tooling knows to prompt for credentials.
- Uploads are serialized per project with an R2 lock (`onlyIf: { etagDoesNotMatch: "*" }`, 15-minute TTL, up to 25 attempts) plus a per-filename claim object, and the declared `sha256_digest` (if sent) is checked against the recomputed SHA-256 before the file is accepted.

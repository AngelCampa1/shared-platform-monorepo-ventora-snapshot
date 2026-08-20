# @ventora/email-renderer

Cloudflare Worker exposing `POST /render` so Python services can render `@ventora/email-templates` React Email templates over HTTP.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `POST /render` | Render a named template (`{ template, vars, timestamp?, nonce?, hmac? }`) to `{ html, text }` (or the shape returned by `@ventora/email-templates`'s `render`). |

## Configuration

| Binding / secret | Purpose |
| --- | --- |
| `ENVIRONMENT` (var) | Set to `production`. Non-`local`/`development`/`test` values require a signed request. |
| `RENDERER_HMAC_SECRET` (secret) | HMAC secret for signing render requests. Absent + non-dev `ENVIRONMENT` -> the Worker returns 500 rather than rendering unsigned. |

## Deploy

```bash
pnpm --filter @ventora/email-renderer run deploy
```

## Notes
- Requests are verified with an HMAC over `{ timestamp, nonce, method: "POST", path: "/render", body: { template, vars } }`, gated by a 5-minute freshness window (`RENDER_HMAC_WINDOW_MS`) and a best-effort isolate-local nonce cache to reject replays within that window.
- This is the Python-to-TypeScript bridge: `ventora_email` (Python) calls this endpoint over HMAC-signed HTTP because React Email templates cannot run in a Python runtime.

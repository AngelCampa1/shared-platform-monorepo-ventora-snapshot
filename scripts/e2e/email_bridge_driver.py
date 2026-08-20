"""Cross-language E2E driver for the @ventora/email-renderer bridge.

Invoked by ``scripts/e2e/email-renderer-bridge.e2e.mjs`` via ``uv run`` against
the py/ workspace, so the REAL ``ventora_email.TemplateRenderer`` client (the
production caller of the email-renderer Worker) signs and issues the HTTP
round-trip — no mock on either side of the Python<->TS boundary.

Configuration arrives via environment variables (avoids shell-quoting the
JSON vars on Windows):

  EMAIL_RENDERER_URL   base URL of the booted ventora-email-renderer worker
  EMAIL_RENDERER_SECRET  HMAC secret (omit/empty -> client sends an unsigned request)
  EMAIL_TEMPLATE       template name (e.g. "welcome")
  EMAIL_VARS_JSON      JSON object of template vars

The driver always prints exactly one JSON line to stdout and exits 0 for any
outcome the harness should assert on:

  {"html": "...", "text": "..."}                       success
  {"error": "HTTPStatusError", "status": 401, ...}      worker rejected the call
  {"driverError": "..."}  (exit 2)                       setup/import failure
"""

from __future__ import annotations

import json
import os
import sys


def main() -> int:
    url = os.environ["EMAIL_RENDERER_URL"]
    secret = os.environ.get("EMAIL_RENDERER_SECRET") or None
    template = os.environ["EMAIL_TEMPLATE"]
    template_vars = json.loads(os.environ["EMAIL_VARS_JSON"])

    try:
        from ventora_email.renderer import TemplateRenderer
    except Exception as exc:  # noqa: BLE001 - import/setup failure is a driver error
        print(json.dumps({"driverError": f"import failed: {exc!r}"}))
        return 2

    renderer = TemplateRenderer(url, hmac_secret=secret)

    try:
        html, text = renderer.render(template, template_vars)
    except Exception as exc:  # noqa: BLE001 - report any client-observed failure as data
        import httpx

        status = None
        body = None
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            body = exc.response.text
        print(
            json.dumps(
                {
                    "error": type(exc).__name__,
                    "message": str(exc),
                    "status": status,
                    "body": body,
                }
            )
        )
        return 0

    print(json.dumps({"html": html, "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

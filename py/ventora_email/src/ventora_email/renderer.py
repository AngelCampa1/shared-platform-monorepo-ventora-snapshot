from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _generate_renderer_hmac(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class TemplateRenderer:
    """HTTP client for the @ventora/email-renderer Cloudflare Worker."""

    def __init__(self, renderer_url: str, hmac_secret: str | None = None) -> None:
        self._url = renderer_url.rstrip("/")
        self._secret = hmac_secret

    def render(self, template: str, template_vars: dict[str, Any]) -> tuple[str, str]:
        """Render a template. Returns (html, text) tuple."""
        body: dict[str, Any] = {"template": template, "vars": template_vars}
        if self._secret:
            timestamp = _timestamp()
            nonce = uuid.uuid4().hex
            payload = json.dumps(
                {
                    "timestamp": timestamp,
                    "nonce": nonce,
                    "method": "POST",
                    "path": "/render",
                    "body": {"template": template, "vars": template_vars},
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
            body["timestamp"] = timestamp
            body["nonce"] = nonce
            body["hmac"] = _generate_renderer_hmac(payload, self._secret)
        response = httpx.post(
            f"{self._url}/render",
            json=body,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return data["html"], data["text"]

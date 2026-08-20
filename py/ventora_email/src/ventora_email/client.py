from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from .canspam import assert_can_spam_compliance, build_list_unsubscribe_headers
from .renderer import TemplateRenderer

logger = logging.getLogger(__name__)

RESEND_API_BASE = "https://api.resend.com"


@dataclass
class EmailClientConfig:
    resend_api_key: str
    default_from: str
    postal_address: str
    renderer_url: str | None = None
    renderer_hmac_secret: str | None = None


@dataclass
class EmailSendParams:
    to: str | list[str]
    subject: str
    html: str
    text: str | None = None
    reply_to: str | None = None
    from_address: str | None = None
    headers: dict[str, str] | None = None
    tags: list[dict[str, str]] | None = None
    unsubscribe_url: str | None = None


@dataclass
class EmailSendResult:
    id: str


class EmailClient:
    def __init__(self, config: EmailClientConfig) -> None:
        assert_can_spam_compliance(config.postal_address)
        self._config = config
        self._renderer = (
            TemplateRenderer(config.renderer_url, config.renderer_hmac_secret)
            if config.renderer_url
            else None
        )

    def send(self, params: EmailSendParams) -> EmailSendResult:
        """Send an email via Resend API."""
        payload = self._build_payload(params)
        response = httpx.post(
            f"{RESEND_API_BASE}/emails",
            json=payload,
            headers={"Authorization": f"Bearer {self._config.resend_api_key}"},
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return EmailSendResult(id=data["id"])

    def send_idempotent(
        self,
        params: EmailSendParams,
        *,
        entity_id: str,
        operation_type: str,
    ) -> EmailSendResult:
        """Send with an idempotency key derived from entity_id + operation_type."""
        idempotency_key = f"{entity_id}:{operation_type}"
        payload = self._build_payload(params)
        response = httpx.post(
            f"{RESEND_API_BASE}/emails",
            json=payload,
            headers={
                "Authorization": f"Bearer {self._config.resend_api_key}",
                "Idempotency-Key": idempotency_key,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return EmailSendResult(id=data["id"])

    def send_template(
        self,
        *,
        template: str,
        template_vars: dict[str, Any],
        to: str | list[str],
        subject: str,
        unsubscribe_url: str | None = None,
        reply_to: str | None = None,
        from_address: str | None = None,
        tags: list[dict[str, str]] | None = None,
    ) -> EmailSendResult:
        """Render a template via the renderer Worker and send."""
        if not self._renderer:
            raise RuntimeError("renderer_url not configured — cannot send templates")
        html, text = self._renderer.render(template, template_vars)
        params = EmailSendParams(
            to=to,
            subject=subject,
            html=html,
            text=text,
            unsubscribe_url=unsubscribe_url,
            reply_to=reply_to,
            from_address=from_address,
            tags=tags,
        )
        return self.send(params)

    def _build_payload(self, params: EmailSendParams) -> dict[str, Any]:
        from_addr = params.from_address or self._config.default_from
        to = [params.to] if isinstance(params.to, str) else params.to
        headers: dict[str, str] = dict(params.headers or {})
        if params.unsubscribe_url:
            headers.update(build_list_unsubscribe_headers(params.unsubscribe_url))

        payload: dict[str, Any] = {
            "from": from_addr,
            "to": to,
            "subject": params.subject,
            "html": params.html,
        }
        if params.text:
            payload["text"] = params.text
        if params.reply_to:
            payload["reply_to"] = params.reply_to
        if headers:
            payload["headers"] = headers
        if params.tags:
            payload["tags"] = params.tags
        return payload


def create_email_client(config: EmailClientConfig) -> EmailClient:
    return EmailClient(config)

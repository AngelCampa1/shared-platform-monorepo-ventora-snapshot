from __future__ import annotations
import json

import httpx
import pytest
import respx

from ventora_email.client import (
    EmailClient,
    EmailClientConfig,
    EmailSendParams,
    create_email_client,
)

RESEND_API = "https://api.resend.com/emails"
RENDERER_URL = "https://email-renderer.example.workers.dev"

VALID_CONFIG = EmailClientConfig(
    resend_api_key="re_test_key",
    default_from="Ventora <angel.campa@example.com>",
    postal_address="1234 Main St, Springfield, IL 62701",
)

VALID_CONFIG_WITH_RENDERER = EmailClientConfig(
    resend_api_key="re_test_key",
    default_from="Ventora <angel.campa@example.com>",
    postal_address="1234 Main St, Springfield, IL 62701",
    renderer_url=RENDERER_URL,
)


def test_create_email_client_raises_on_invalid_postal_address():
    bad_config = EmailClientConfig(
        resend_api_key="re_test_key",
        default_from="noreply@example.com",
        postal_address="",
    )
    with pytest.raises(ValueError, match="CAN-SPAM"):
        create_email_client(bad_config)


def test_create_email_client_raises_on_placeholder_address():
    bad_config = EmailClientConfig(
        resend_api_key="re_test_key",
        default_from="noreply@example.com",
        postal_address="[Set your postal address here]",
    )
    with pytest.raises(ValueError, match="placeholder"):
        create_email_client(bad_config)


@respx.mock
def test_send_posts_to_resend_with_correct_payload():
    captured_body: dict = {}
    captured_headers: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        captured_headers.update(dict(request.headers))
        return httpx.Response(200, json={"id": "email-id-001"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Test Subject",
        html="<p>Hello</p>",
        text="Hello",
    )
    result = client.send(params)
    assert result.id == "email-id-001"
    assert captured_body["to"] == ["angel@example.com"]
    assert captured_body["subject"] == "Test Subject"
    assert captured_body["html"] == "<p>Hello</p>"
    assert captured_body["text"] == "Hello"
    assert captured_body["from"] == VALID_CONFIG.default_from
    assert "Bearer re_test_key" in captured_headers.get("authorization", "")


@respx.mock
def test_send_adds_list_unsubscribe_headers():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-id-002"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Newsletter",
        html="<p>News</p>",
        unsubscribe_url="https://example.com/unsub?token=abc",
    )
    client.send(params)
    headers_in_payload = captured_body.get("headers", {})
    assert "List-Unsubscribe" in headers_in_payload
    assert "List-Unsubscribe-Post" in headers_in_payload
    assert headers_in_payload["List-Unsubscribe"] == "<https://example.com/unsub?token=abc>"
    assert headers_in_payload["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"


@respx.mock
def test_send_to_list_of_recipients():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-id-003"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to=["a@example.com", "b@example.com"],
        subject="Bulk",
        html="<p>Hi all</p>",
    )
    client.send(params)
    assert captured_body["to"] == ["a@example.com", "b@example.com"]


@respx.mock
def test_send_idempotent_includes_idempotency_key_header():
    captured_headers: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(200, json={"id": "email-id-004"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Idempotent",
        html="<p>Once</p>",
    )
    result = client.send_idempotent(params, entity_id="order-999", operation_type="confirmation")
    assert result.id == "email-id-004"
    assert captured_headers.get("idempotency-key") == "order-999:confirmation"


@respx.mock
def test_send_template_calls_renderer_then_resend():
    # Mock renderer
    respx.post(f"{RENDERER_URL}/render").mock(
        return_value=httpx.Response(
            200,
            json={"html": "<h1>Welcome Angel</h1>", "text": "Welcome Angel"},
        )
    )
    # Mock Resend
    respx.post(RESEND_API).mock(
        return_value=httpx.Response(200, json={"id": "email-id-005"})
    )
    client = EmailClient(VALID_CONFIG_WITH_RENDERER)
    result = client.send_template(
        template="welcome",
        template_vars={"name": "Angel"},
        to="angel@example.com",
        subject="Welcome!",
    )
    assert result.id == "email-id-005"


@respx.mock
def test_send_template_surfaces_renderer_validation_before_resend():
    respx.post(f"{RENDERER_URL}/render").mock(
        return_value=httpx.Response(
            422,
            json={"error": 'Template "password-reset" requires string var "resetUrl"'},
        )
    )
    resend_route = respx.post(RESEND_API).mock(
        return_value=httpx.Response(200, json={"id": "email-id-should-not-send"})
    )
    client = EmailClient(VALID_CONFIG_WITH_RENDERER)

    with pytest.raises(httpx.HTTPStatusError):
        client.send_template(
            template="password-reset",
            template_vars={},
            to="angel@example.com",
            subject="Reset your password",
        )

    assert not resend_route.called


@respx.mock
def test_send_template_raises_when_renderer_not_configured():
    client = EmailClient(VALID_CONFIG)  # no renderer_url
    with pytest.raises(RuntimeError, match="renderer_url not configured"):
        client.send_template(
            template="welcome",
            template_vars={"name": "Angel"},
            to="angel@example.com",
            subject="Welcome!",
        )


@respx.mock
def test_send_uses_from_address_override():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-id-006"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Override From",
        html="<p>Hi</p>",
        from_address="Custom <support@example.com>",
    )
    client.send(params)
    assert captured_body["from"] == "Custom <support@example.com>"


@respx.mock
def test_send_includes_reply_to_when_set():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-id-007"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Reply Test",
        html="<p>Hi</p>",
        reply_to="support@example.com",
    )
    client.send(params)
    assert captured_body["reply_to"] == "support@example.com"


@respx.mock
def test_send_includes_tags_when_set():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-id-008"})

    respx.post(RESEND_API).mock(side_effect=capture_request)
    client = EmailClient(VALID_CONFIG)
    params = EmailSendParams(
        to="angel@example.com",
        subject="Tagged",
        html="<p>Hi</p>",
        tags=[{"name": "campaign", "value": "spring"}],
    )
    client.send(params)
    assert captured_body["tags"] == [{"name": "campaign", "value": "spring"}]

from __future__ import annotations
import json
import re
import hashlib
import hmac

import httpx
import pytest
import respx

from ventora_email.renderer import TemplateRenderer


RENDERER_URL = "https://email-renderer.example.workers.dev"


@respx.mock
def test_render_posts_to_render_endpoint_and_returns_html_text():
    mock_route = respx.post(f"{RENDERER_URL}/render").mock(
        return_value=httpx.Response(
            200,
            json={"html": "<h1>Hello</h1>", "text": "Hello"},
        )
    )
    renderer = TemplateRenderer(RENDERER_URL)
    html, text = renderer.render("welcome", {"name": "Angel"})
    assert html == "<h1>Hello</h1>"
    assert text == "Hello"
    assert mock_route.called


@respx.mock
def test_render_includes_hmac_when_secret_provided():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"html": "<p>Hi</p>", "text": "Hi"})

    respx.post(f"{RENDERER_URL}/render").mock(side_effect=capture_request)
    renderer = TemplateRenderer(RENDERER_URL, hmac_secret="my-secret")
    renderer.render("welcome", {"name": "Angel"})
    assert "hmac" in captured_body
    assert isinstance(captured_body["timestamp"], str)
    assert isinstance(captured_body["nonce"], str)
    assert isinstance(captured_body["hmac"], str)
    assert re.fullmatch(r"[0-9a-f]{64}", captured_body["hmac"])
    payload = json.dumps(
        {
            "timestamp": captured_body["timestamp"],
            "nonce": captured_body["nonce"],
            "method": "POST",
            "path": "/render",
            "body": {"template": "welcome", "vars": {"name": "Angel"}},
        },
        separators=(",", ":"),
    )
    expected = hmac.new("my-secret".encode(), payload.encode(), hashlib.sha256).hexdigest()
    assert captured_body["hmac"] == expected


@respx.mock
def test_render_hmac_matches_worker_json_for_non_ascii_vars():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"html": "<p>Hi</p>", "text": "Hi"})

    respx.post(f"{RENDERER_URL}/render").mock(side_effect=capture_request)
    renderer = TemplateRenderer(RENDERER_URL, hmac_secret="my-secret")
    renderer.render("welcome", {"name": "José"})
    payload = json.dumps(
        {
            "timestamp": captured_body["timestamp"],
            "nonce": captured_body["nonce"],
            "method": "POST",
            "path": "/render",
            "body": {"template": "welcome", "vars": {"name": "José"}},
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    expected = hmac.new("my-secret".encode(), payload.encode(), hashlib.sha256).hexdigest()
    assert captured_body["hmac"] == expected


@respx.mock
def test_render_does_not_include_hmac_when_no_secret():
    captured_body: dict = {}

    def capture_request(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content))
        return httpx.Response(200, json={"html": "<p>Hi</p>", "text": "Hi"})

    respx.post(f"{RENDERER_URL}/render").mock(side_effect=capture_request)
    renderer = TemplateRenderer(RENDERER_URL)
    renderer.render("welcome", {"name": "Angel"})
    assert "hmac" not in captured_body


@respx.mock
def test_render_raises_on_non_200_response():
    respx.post(f"{RENDERER_URL}/render").mock(
        return_value=httpx.Response(500, json={"error": "Internal Server Error"})
    )
    renderer = TemplateRenderer(RENDERER_URL)
    with pytest.raises(httpx.HTTPStatusError):
        renderer.render("welcome", {"name": "Angel"})


@respx.mock
def test_render_strips_trailing_slash_from_url():
    mock_route = respx.post(f"{RENDERER_URL}/render").mock(
        return_value=httpx.Response(200, json={"html": "<p>Hi</p>", "text": "Hi"})
    )
    renderer = TemplateRenderer(f"{RENDERER_URL}/")
    renderer.render("welcome", {})
    assert mock_route.called

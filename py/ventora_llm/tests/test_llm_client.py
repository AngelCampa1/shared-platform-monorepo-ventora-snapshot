from __future__ import annotations
import json
import pytest
import httpx
import respx
from unittest.mock import AsyncMock, patch

from ventora_llm.client import OpenRouterClient, OpenRouterError
from ventora_llm.types import LlmConfig, Message, LlmResponse


def make_config(**kwargs: object) -> LlmConfig:
    defaults = {
        "api_key": "sk-test-key",
        "max_retries": 1,  # Speed up tests by reducing retries
    }
    defaults.update(kwargs)
    return LlmConfig(**defaults)  # type: ignore[arg-type]


def make_messages() -> list[Message]:
    return [
        Message(role="system", content="You are helpful."),
        Message(role="user", content="Extract data."),
    ]


def make_chat_response(content: str = "Hello", model: str = "anthropic/claude-haiku-4-5") -> dict:
    return {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }


class TestOpenRouterClientComplete:
    @respx.mock
    async def test_complete_returns_llm_response(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response("Extracted data"))
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            response = await client.complete(make_messages())
        assert isinstance(response, LlmResponse)
        assert response.content == "Extracted data"
        assert response.finish_reason == "stop"
        assert response.usage == {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}

    @respx.mock
    async def test_complete_uses_response_model_field(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response(model="openai/gpt-4o"))
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            response = await client.complete(make_messages())
        assert response.model == "openai/gpt-4o"

    @respx.mock
    async def test_complete_raises_on_429(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(429, json={"error": "rate limited"})
        )
        config = make_config(max_retries=1)
        async with OpenRouterClient(config) as client:
            with pytest.raises(OpenRouterError) as exc_info:
                await client.complete(make_messages())
        assert exc_info.value.status == 429
        assert "Rate limited" in str(exc_info.value)

    @respx.mock
    async def test_complete_raises_on_4xx_client_error(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(400, text="Bad request body")
        )
        config = make_config(max_retries=1)
        async with OpenRouterClient(config) as client:
            with pytest.raises(OpenRouterError) as exc_info:
                await client.complete(make_messages())
        assert exc_info.value.status == 400
        assert "400" in str(exc_info.value)

    @respx.mock
    async def test_complete_does_not_retry_non_retryable_4xx_client_error(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(400, text="Bad request body")
        )
        config = make_config(max_retries=3)
        async with OpenRouterClient(config) as client:
            with pytest.raises(OpenRouterError) as exc_info:
                await client.complete(make_messages())
        assert exc_info.value.status == 400
        assert route.call_count == 1

    @respx.mock
    async def test_complete_raises_on_401(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(401, text="Unauthorized")
        )
        config = make_config(max_retries=1)
        async with OpenRouterClient(config) as client:
            with pytest.raises(OpenRouterError) as exc_info:
                await client.complete(make_messages())
        assert exc_info.value.status == 401

    @respx.mock
    async def test_complete_retries_on_5xx_then_succeeds(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions")
        route.side_effect = [
            httpx.Response(500, json={"error": "server error"}),
            httpx.Response(200, json=make_chat_response("Retry succeeded")),
        ]
        config = make_config(max_retries=2)
        async with OpenRouterClient(config) as client:
            response = await client.complete(make_messages())
        assert response.content == "Retry succeeded"
        assert route.call_count == 2

    @respx.mock
    async def test_complete_raises_after_all_retries_on_5xx(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(503, json={"error": "service unavailable"})
        )
        config = make_config(max_retries=2)
        async with OpenRouterClient(config) as client:
            with pytest.raises(OpenRouterError) as exc_info:
                await client.complete(make_messages())
        assert exc_info.value.status == 503

    @respx.mock
    async def test_complete_adds_http_referer_when_site_url_configured(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config(site_url="https://camaudit.io")
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages())
        request = route.calls[0].request
        assert request.headers.get("http-referer") == "https://camaudit.io"

    @respx.mock
    async def test_complete_adds_x_title_when_site_name_configured(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config(site_name="CAMAudit")
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages())
        request = route.calls[0].request
        assert request.headers.get("x-title") == "CAMAudit"

    @respx.mock
    async def test_complete_no_http_referer_when_site_url_not_configured(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages())
        request = route.calls[0].request
        assert "http-referer" not in request.headers

    @respx.mock
    async def test_complete_with_override_model(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages(), model="openai/gpt-4o")
        request_body = json.loads(route.calls[0].request.content)
        assert request_body["model"] == "openai/gpt-4o"

    @respx.mock
    async def test_complete_with_override_max_tokens(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages(), max_tokens=512)
        request_body = json.loads(route.calls[0].request.content)
        assert request_body["max_tokens"] == 512

    @respx.mock
    async def test_complete_with_override_temperature(self) -> None:
        route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response())
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            await client.complete(make_messages(), temperature=0.7)
        request_body = json.loads(route.calls[0].request.content)
        assert request_body["temperature"] == 0.7


class TestOpenRouterClientContextManager:
    @respx.mock
    async def test_context_manager_works(self) -> None:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=make_chat_response("ctx result"))
        )
        config = make_config()
        async with OpenRouterClient(config) as client:
            response = await client.complete(make_messages())
        assert response.content == "ctx result"

    async def test_aclose_closes_httpx_client(self) -> None:
        config = make_config()
        client = OpenRouterClient(config)
        # Verify the underlying httpx client is open initially
        assert not client._client.is_closed
        await client.aclose()
        assert client._client.is_closed

    async def test_context_manager_closes_client_on_exit(self) -> None:
        config = make_config()
        async with OpenRouterClient(config) as client:
            inner_client = client._client
        assert inner_client.is_closed

    async def test_context_manager_closes_on_exception(self) -> None:
        config = make_config()
        inner_client = None
        try:
            async with OpenRouterClient(config) as client:
                inner_client = client._client
                raise ValueError("test error")
        except ValueError:
            pass
        assert inner_client is not None
        assert inner_client.is_closed


class TestOpenRouterError:
    def test_error_stores_status(self) -> None:
        err = OpenRouterError(404, "Not found")
        assert err.status == 404

    def test_error_message(self) -> None:
        err = OpenRouterError(500, "Server blew up")
        assert str(err) == "Server blew up"

    def test_error_is_exception(self) -> None:
        err = OpenRouterError(400, "Bad")
        assert isinstance(err, Exception)

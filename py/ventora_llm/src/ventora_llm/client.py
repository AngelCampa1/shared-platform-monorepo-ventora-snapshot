from __future__ import annotations

import logging
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from .types import LlmConfig, LlmResponse, Message

logger = logging.getLogger(__name__)


class OpenRouterError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _is_retryable_openrouter_error(error: BaseException) -> bool:
    if isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, OpenRouterError):
        return error.status == 429 or error.status >= 500
    return False


class OpenRouterClient:
    def __init__(self, config: LlmConfig) -> None:
        self._config = config
        headers: dict[str, str] = {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        }
        if config.site_url:
            headers["HTTP-Referer"] = config.site_url
        if config.site_name:
            headers["X-Title"] = config.site_name
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            headers=headers,
            timeout=config.timeout_seconds,
        )

    async def complete(
        self,
        messages: list[Message],
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LlmResponse:
        """Send a chat completion request to OpenRouter."""
        payload: dict[str, Any] = {
            "model": model or self._config.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_tokens or self._config.max_tokens,
            "temperature": temperature if temperature is not None else self._config.temperature,
        }

        @retry(
            stop=stop_after_attempt(self._config.max_retries),
            wait=wait_exponential(multiplier=1, min=1, max=10),
            retry=retry_if_exception(_is_retryable_openrouter_error),
            reraise=True,
        )
        async def _send() -> LlmResponse:
            response = await self._client.post("/chat/completions", json=payload)
            if response.status_code == 429:
                raise OpenRouterError(429, "Rate limited")
            if response.status_code >= 500:
                raise OpenRouterError(response.status_code, f"Server error: {response.status_code}")
            if response.status_code >= 400:
                body = response.text
                raise OpenRouterError(
                    response.status_code,
                    f"Client error {response.status_code}: {body}",
                )
            data = response.json()
            choice = data["choices"][0]
            return LlmResponse(
                content=choice["message"]["content"],
                model=data.get("model", model or self._config.model),
                usage=data.get("usage", {}),
                finish_reason=choice.get("finish_reason", "stop"),
            )

        return await _send()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> OpenRouterClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.aclose()

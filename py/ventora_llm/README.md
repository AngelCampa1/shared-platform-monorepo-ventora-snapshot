# ventora-llm

Async OpenRouter chat-completion client with retry/backoff, plus types for multi-pass document extraction.

## Install

```bash
uv add ventora-llm
```

## Usage

```python
from ventora_llm import LlmConfig, Message, OpenRouterClient

config = LlmConfig(api_key="sk-or-...", model="anthropic/claude-haiku-4-5")

async with OpenRouterClient(config) as client:
    response = await client.complete(
        [
            Message(role="system", content="You are helpful."),
            Message(role="user", content="Extract data."),
        ]
    )
    print(response.content, response.usage)
```

## Notes
- `OpenRouterClient.complete` is async and retries transport errors, HTTP 429, and HTTP 5xx with exponential backoff (`tenacity`, up to `LlmConfig.max_retries` attempts); 4xx errors other than 429 raise `OpenRouterError` immediately.
- `OpenRouterClient` is an async context manager (`async with`); `aclose()` releases the underlying `httpx.AsyncClient` if you construct it directly instead.

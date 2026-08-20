from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ModelId = Literal[
    "anthropic/claude-opus-4",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
]

DEFAULT_MODEL: ModelId = "anthropic/claude-haiku-4-5"


@dataclass
class LlmConfig:
    api_key: str
    model: ModelId = DEFAULT_MODEL
    base_url: str = "https://openrouter.ai/api/v1"
    max_tokens: int = 4096
    temperature: float = 0.0
    timeout_seconds: float = 60.0
    max_retries: int = 3
    site_url: str | None = None   # OpenRouter HTTP-Referer header
    site_name: str | None = None  # OpenRouter X-Title header


@dataclass
class Message:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass
class LlmResponse:
    content: str
    model: str
    usage: dict[str, int]
    finish_reason: str


@dataclass
class ExtractionPass:
    """A single extraction pass definition."""
    name: str
    system_prompt: str
    user_prompt_template: str   # May contain {document} and {previous_results} placeholders
    output_schema: dict[str, Any] | None = None  # Optional top-level shape check
    model: ModelId | None = None  # Override per-pass model


@dataclass
class ExtractionResult:
    pass_name: str
    raw_response: str
    parsed: dict[str, Any] | None
    success: bool
    error: str | None = None
    tokens_used: int = 0


@dataclass
class MultiPassResult:
    document_id: str
    results: list[ExtractionResult] = field(default_factory=list)
    merged: dict[str, Any] = field(default_factory=dict)

    @property
    def success(self) -> bool:
        return all(r.success for r in self.results)

    @property
    def total_tokens(self) -> int:
        return sum(r.tokens_used for r in self.results)

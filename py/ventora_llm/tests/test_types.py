from __future__ import annotations
import pytest
from ventora_llm.types import (
    ExtractionResult,
    ExtractionPass,
    LlmConfig,
    LlmResponse,
    Message,
    MultiPassResult,
    DEFAULT_MODEL,
)


class TestMultiPassResultSuccess:
    def test_success_true_when_all_results_succeed(self) -> None:
        r1 = ExtractionResult(pass_name="p1", raw_response="", parsed=None, success=True)
        r2 = ExtractionResult(pass_name="p2", raw_response="", parsed=None, success=True)
        result = MultiPassResult(document_id="doc1", results=[r1, r2])
        assert result.success is True

    def test_success_false_when_any_result_failed(self) -> None:
        r1 = ExtractionResult(pass_name="p1", raw_response="", parsed=None, success=True)
        r2 = ExtractionResult(pass_name="p2", raw_response="", parsed=None, success=False)
        result = MultiPassResult(document_id="doc1", results=[r1, r2])
        assert result.success is False

    def test_success_false_when_all_results_failed(self) -> None:
        r1 = ExtractionResult(pass_name="p1", raw_response="", parsed=None, success=False)
        result = MultiPassResult(document_id="doc1", results=[r1])
        assert result.success is False

    def test_success_true_when_no_results(self) -> None:
        # all() on empty iterable returns True
        result = MultiPassResult(document_id="doc1", results=[])
        assert result.success is True


class TestMultiPassResultTotalTokens:
    def test_total_tokens_sums_across_results(self) -> None:
        r1 = ExtractionResult(pass_name="p1", raw_response="", parsed=None, success=True, tokens_used=100)
        r2 = ExtractionResult(pass_name="p2", raw_response="", parsed=None, success=True, tokens_used=250)
        result = MultiPassResult(document_id="doc1", results=[r1, r2])
        assert result.total_tokens == 350

    def test_total_tokens_zero_when_no_results(self) -> None:
        result = MultiPassResult(document_id="doc1", results=[])
        assert result.total_tokens == 0

    def test_total_tokens_single_result(self) -> None:
        r1 = ExtractionResult(pass_name="p1", raw_response="", parsed=None, success=True, tokens_used=42)
        result = MultiPassResult(document_id="doc1", results=[r1])
        assert result.total_tokens == 42


class TestExtractionResultDefaults:
    def test_error_default_none(self) -> None:
        r = ExtractionResult(pass_name="p1", raw_response="text", parsed=None, success=True)
        assert r.error is None

    def test_tokens_used_default_zero(self) -> None:
        r = ExtractionResult(pass_name="p1", raw_response="text", parsed=None, success=True)
        assert r.tokens_used == 0

    def test_explicit_error(self) -> None:
        r = ExtractionResult(
            pass_name="p1", raw_response="", parsed=None, success=False, error="some error"
        )
        assert r.error == "some error"

    def test_explicit_tokens(self) -> None:
        r = ExtractionResult(
            pass_name="p1", raw_response="", parsed=None, success=True, tokens_used=77
        )
        assert r.tokens_used == 77


class TestLlmConfigDefaults:
    def test_default_model(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.model == DEFAULT_MODEL
        assert config.model == "anthropic/claude-haiku-4-5"

    def test_default_base_url(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.base_url == "https://openrouter.ai/api/v1"

    def test_default_temperature(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.temperature == 0.0

    def test_default_max_tokens(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.max_tokens == 4096

    def test_default_timeout_seconds(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.timeout_seconds == 60.0

    def test_default_max_retries(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.max_retries == 3

    def test_default_site_url_none(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.site_url is None

    def test_default_site_name_none(self) -> None:
        config = LlmConfig(api_key="sk-test")
        assert config.site_name is None

    def test_custom_values(self) -> None:
        config = LlmConfig(
            api_key="sk-abc",
            model="openai/gpt-4o",
            base_url="https://custom.api/v1",
            max_tokens=2048,
            temperature=0.5,
            timeout_seconds=30.0,
            max_retries=5,
            site_url="https://example.com",
            site_name="MyApp",
        )
        assert config.api_key == "sk-abc"
        assert config.model == "openai/gpt-4o"
        assert config.base_url == "https://custom.api/v1"
        assert config.max_tokens == 2048
        assert config.temperature == 0.5
        assert config.timeout_seconds == 30.0
        assert config.max_retries == 5
        assert config.site_url == "https://example.com"
        assert config.site_name == "MyApp"


class TestMultiPassResultDefaults:
    def test_results_default_empty_list(self) -> None:
        result = MultiPassResult(document_id="doc1")
        assert result.results == []

    def test_merged_default_empty_dict(self) -> None:
        result = MultiPassResult(document_id="doc1")
        assert result.merged == {}


class TestExtractionPassFields:
    def test_basic_fields(self) -> None:
        p = ExtractionPass(
            name="test_pass",
            system_prompt="You are an extractor.",
            user_prompt_template="Extract from {document}",
        )
        assert p.name == "test_pass"
        assert p.system_prompt == "You are an extractor."
        assert p.user_prompt_template == "Extract from {document}"
        assert p.output_schema is None
        assert p.model is None

    def test_with_optional_fields(self) -> None:
        schema = {"type": "object", "properties": {"name": {"type": "string"}}}
        p = ExtractionPass(
            name="test_pass",
            system_prompt="sys",
            user_prompt_template="tmpl",
            output_schema=schema,
            model="openai/gpt-4o",
        )
        assert p.output_schema == schema
        assert p.model == "openai/gpt-4o"


class TestMessageAndLlmResponse:
    def test_message_fields(self) -> None:
        m = Message(role="user", content="hello")
        assert m.role == "user"
        assert m.content == "hello"

    def test_llm_response_fields(self) -> None:
        r = LlmResponse(
            content="some text",
            model="anthropic/claude-haiku-4-5",
            usage={"total_tokens": 50},
            finish_reason="stop",
        )
        assert r.content == "some text"
        assert r.model == "anthropic/claude-haiku-4-5"
        assert r.usage == {"total_tokens": 50}
        assert r.finish_reason == "stop"

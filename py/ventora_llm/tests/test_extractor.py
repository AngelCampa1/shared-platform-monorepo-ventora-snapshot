from __future__ import annotations
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from ventora_llm.extractor import MultiPassExtractor, _extract_json, _matches_json_type, _validate_schema
from ventora_llm.types import ExtractionPass, LlmConfig, LlmResponse, MultiPassResult


def make_config() -> LlmConfig:
    return LlmConfig(api_key="sk-test", max_retries=1)


def make_pass(
    name: str = "test_pass",
    system_prompt: str = "You are an extractor.",
    user_prompt_template: str = "Extract from: {document}",
    model: str | None = None,
) -> ExtractionPass:
    return ExtractionPass(
        name=name,
        system_prompt=system_prompt,
        user_prompt_template=user_prompt_template,
        model=model,  # type: ignore[arg-type]
    )


def make_llm_response(content: str, total_tokens: int = 50) -> LlmResponse:
    return LlmResponse(
        content=content,
        model="anthropic/claude-haiku-4-5",
        usage={"total_tokens": total_tokens},
        finish_reason="stop",
    )


class TestExtractJson:
    def test_extracts_plain_json_string(self) -> None:
        result = _extract_json('{"name": "Alice", "age": 30}')
        assert result == {"name": "Alice", "age": 30}

    def test_extracts_from_json_code_block(self) -> None:
        text = '```json\n{"name": "Bob"}\n```'
        result = _extract_json(text)
        assert result == {"name": "Bob"}

    def test_extracts_from_plain_code_block(self) -> None:
        text = '```\n{"key": "value"}\n```'
        result = _extract_json(text)
        assert result == {"key": "value"}

    def test_extracts_json_embedded_in_text(self) -> None:
        text = 'Here is the result: {"status": "ok"} and that is it.'
        result = _extract_json(text)
        assert result == {"status": "ok"}

    def test_extracts_nested_json_embedded_in_text(self) -> None:
        text = 'Here is the result: {"outer": {"inner": [1, 2, 3]}, "status": "ok"} and done.'
        result = _extract_json(text)
        assert result == {"outer": {"inner": [1, 2, 3]}, "status": "ok"}

    def test_returns_none_for_unparseable_text(self) -> None:
        result = _extract_json("This is just plain text with no JSON")
        assert result is None

    def test_returns_none_for_empty_string(self) -> None:
        result = _extract_json("")
        assert result is None

    def test_returns_none_for_malformed_json(self) -> None:
        result = _extract_json("{not valid json}")
        assert result is None

    def test_returns_none_for_non_object_json(self) -> None:
        result = _extract_json('["not", "an", "object"]')
        assert result is None

    def test_returns_none_for_malformed_json_in_code_block(self) -> None:
        # Hits the except branch inside the code-block regex path (lines 25-26)
        text = "```json\n{not: valid json}\n```"
        result = _extract_json(text)
        assert result is None

    def test_handles_whitespace_around_json(self) -> None:
        result = _extract_json('  \n  {"key": "val"}  \n  ')
        assert result == {"key": "val"}

    def test_nested_json_direct_parse(self) -> None:
        data = {"outer": {"inner": [1, 2, 3]}}
        result = _extract_json(json.dumps(data))
        assert result == data

    def test_extracts_nested_json_from_markdown_code_block(self) -> None:
        text = """Here is the extraction:
```json
{"outer": {"inner": [1, 2, 3]}, "status": "ok"}
```
"""
        result = _extract_json(text)
        assert result == {"outer": {"inner": [1, 2, 3]}, "status": "ok"}


class TestSchemaValidation:
    def test_rejects_missing_json_object(self) -> None:
        error = _validate_schema(None, {"type": "object"})
        assert error == "Response did not contain a JSON object"

    def test_ignores_non_list_required_value(self) -> None:
        error = _validate_schema({}, {"type": "object", "required": "name"})
        assert error is None

    def test_ignores_missing_optional_property(self) -> None:
        error = _validate_schema({}, {"type": "object", "properties": {"name": {"type": "string"}}})
        assert error is None

    def test_ignores_non_object_property_definition(self) -> None:
        error = _validate_schema({"name": "Ada"}, {"type": "object", "properties": {"name": True}})
        assert error is None

    def test_ignores_unknown_schema_type(self) -> None:
        assert _matches_json_type(object(), "custom") is True

    def test_shape_check_ignores_full_json_schema_keywords(self) -> None:
        schema = {
            "type": "object",
            "properties": {"status": {"type": "string", "enum": ["approved"]}},
            "additionalProperties": False,
        }
        error = _validate_schema({"status": "pending", "extra": True}, schema)
        assert error is None

    def test_matches_all_supported_json_types(self) -> None:
        assert _matches_json_type("Ada", "string") is True
        assert _matches_json_type(1.5, "number") is True
        assert _matches_json_type(1, "integer") is True
        assert _matches_json_type(True, "boolean") is True
        assert _matches_json_type([], "array") is True
        assert _matches_json_type({}, "object") is True
        assert _matches_json_type(None, "null") is True

    def test_rejects_boolean_as_number_or_integer(self) -> None:
        assert _matches_json_type(True, "number") is False
        assert _matches_json_type(True, "integer") is False


class TestMultiPassExtractorExtract:
    async def test_extract_single_pass_returns_result(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        response_content = '{"field": "value"}'

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response(response_content))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [make_pass()]
            result = await extractor.extract("doc1", "Some document text", passes)

        assert isinstance(result, MultiPassResult)
        assert result.document_id == "doc1"
        assert len(result.results) == 1
        assert result.results[0].pass_name == "test_pass"
        assert result.results[0].success is True

    async def test_extract_with_json_response_parses_correctly(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        response_content = '{"extracted_name": "John", "date": "2024-01-01"}'

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response(response_content, total_tokens=75))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [make_pass()]
            result = await extractor.extract("doc1", "document text", passes)

        assert result.results[0].parsed == {"extracted_name": "John", "date": "2024-01-01"}
        assert result.results[0].tokens_used == 75
        assert result.merged == {"extracted_name": "John", "date": "2024-01-01"}

    async def test_extract_with_markdown_wrapped_json(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        response_content = '```json\n{"category": "legal", "confidence": 0.95}\n```'

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response(response_content))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [make_pass()]
            result = await extractor.extract("doc1", "document text", passes)

        assert result.results[0].parsed == {"category": "legal", "confidence": 0.95}
        assert result.results[0].success is True

    async def test_extract_with_invalid_json_sets_parsed_none_success_true(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        response_content = "I cannot extract JSON from this document."

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response(response_content))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [make_pass()]
            result = await extractor.extract("doc1", "document text", passes)

        # Raw response is still captured even when JSON parse fails
        assert result.results[0].raw_response == response_content
        assert result.results[0].parsed is None
        assert result.results[0].success is True

    async def test_extract_with_non_object_json_does_not_merge_invalid_shape(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        response_content = '["not", "an", "object"]'

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response(response_content))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            result = await extractor.extract("doc1", "document text", [make_pass()])

        assert result.results[0].raw_response == response_content
        assert result.results[0].parsed is None
        assert result.results[0].success is True
        assert result.merged == {}

    async def test_extract_with_output_schema_rejects_missing_required_field(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response('{"name": "Ada"}'))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass_def = ExtractionPass(
                name="schema_pass",
                system_prompt="sys",
                user_prompt_template="Extract {document}",
                output_schema={
                    "type": "object",
                    "required": ["name", "age"],
                    "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
                },
            )
            result = await extractor.extract("doc1", "document text", [pass_def])

        assert result.results[0].success is False
        assert result.results[0].error == "Missing required field: age"

    async def test_extract_with_output_schema_rejects_wrong_type(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response('{"age": "30"}'))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass_def = ExtractionPass(
                name="schema_pass",
                system_prompt="sys",
                user_prompt_template="Extract {document}",
                output_schema={
                    "type": "object",
                    "properties": {"age": {"type": "integer"}},
                },
            )
            result = await extractor.extract("doc1", "document text", [pass_def])

        assert result.results[0].success is False
        assert result.results[0].error == "Field age must be integer"

    async def test_extract_with_output_schema_accepts_valid_output(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response('{"age": 30}'))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass_def = ExtractionPass(
                name="schema_pass",
                system_prompt="sys",
                user_prompt_template="Extract {document}",
                output_schema={
                    "type": "object",
                    "required": ["age"],
                    "properties": {"age": {"type": "integer"}},
                },
            )
            result = await extractor.extract("doc1", "document text", [pass_def])

        assert result.results[0].success is True
        assert result.results[0].error is None

    async def test_extract_when_complete_raises_sets_success_false(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(side_effect=Exception("API connection failed"))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [make_pass()]
            result = await extractor.extract("doc1", "document text", passes)

        assert result.results[0].success is False
        assert result.results[0].error == "API connection failed"
        assert result.results[0].raw_response == ""
        assert result.results[0].parsed is None

    async def test_extract_passes_previous_results_to_second_pass(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)
        pass1_response = '{"entity": "ACME Corp"}'
        pass2_response = '{"classification": "contract"}'

        captured_calls: list[dict] = []

        async def capture_complete(messages: list, model: str | None = None, **kwargs: object) -> LlmResponse:
            # Capture the user message for later inspection
            user_content = next(m.content for m in messages if m.role == "user")
            captured_calls.append({"user_content": user_content})
            if len(captured_calls) == 1:
                return make_llm_response(pass1_response)
            return make_llm_response(pass2_response)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = capture_complete
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass1 = make_pass(
                name="entity_extraction",
                user_prompt_template="Extract from: {document}",
            )
            pass2 = make_pass(
                name="classification",
                user_prompt_template="Classify. Doc: {document}\nPrevious: {previous_results}",
            )
            result = await extractor.extract("doc1", "contract text", [pass1, pass2])

        assert len(result.results) == 2
        assert result.results[0].success is True
        assert result.results[1].success is True
        # Second pass prompt should contain previous results
        second_call_content = captured_calls[1]["user_content"]
        assert "entity_extraction" in second_call_content
        assert "ACME Corp" in second_call_content

    async def test_extract_multi_pass_merges_results(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        responses = [
            '{"name": "Alice"}',
            '{"age": 30}',
        ]
        call_count = 0

        async def mock_complete(messages: list, model: str | None = None, **kwargs: object) -> LlmResponse:
            nonlocal call_count
            resp = make_llm_response(responses[call_count])
            call_count += 1
            return resp

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = mock_complete
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            passes = [
                make_pass(name="pass1", user_prompt_template="Extract name: {document}"),
                make_pass(name="pass2", user_prompt_template="Extract age: {document}"),
            ]
            result = await extractor.extract("doc1", "text", passes)

        assert result.merged == {"name": "Alice", "age": 30}
        assert result.success is True
        assert result.total_tokens == 100  # 50 + 50

    async def test_extract_failed_pass_not_added_to_previous_results(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        call_count = 0

        async def mock_complete(messages: list, model: str | None = None, **kwargs: object) -> LlmResponse:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First call (pass1) - raise exception
                raise Exception("pass1 failed")
            return make_llm_response('{"pass2_result": "ok"}')

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = mock_complete
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass1 = ExtractionPass(
                name="pass1",
                system_prompt="pass1 system",
                user_prompt_template="pass1 {document}",
            )
            pass2 = ExtractionPass(
                name="pass2",
                system_prompt="pass2 system",
                user_prompt_template="pass2 {document} prev: {previous_results}",
            )
            result = await extractor.extract("doc1", "text", [pass1, pass2])

        # pass1 failed, pass2 attempted, previous_results for pass2 should be empty
        assert result.results[0].success is False
        assert result.results[1].success is True
        # The merged should only have pass2 results (pass1 failed, so not in merged)
        assert "pass2_result" in result.merged
        assert "pass1" not in result.merged

    async def test_extract_document_id_preserved(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = AsyncMock(return_value=make_llm_response("{}"))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            result = await extractor.extract("my-unique-doc-id-123", "text", [make_pass()])

        assert result.document_id == "my-unique-doc-id-123"

    async def test_extract_with_pass_model_override(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        captured_model: list[str | None] = []

        async def mock_complete(messages: list, model: str | None = None, **kwargs: object) -> LlmResponse:
            captured_model.append(model)
            return make_llm_response('{"ok": true}')

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.complete = mock_complete
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            pass_with_model = ExtractionPass(
                name="test",
                system_prompt="sys",
                user_prompt_template="Extract {document}",
                model="openai/gpt-4o",  # type: ignore[arg-type]
            )
            await extractor.extract("doc1", "text", [pass_with_model])

        assert captured_model[0] == "openai/gpt-4o"

    async def test_extract_empty_passes_returns_empty_result(self) -> None:
        config = make_config()
        extractor = MultiPassExtractor(config)

        with patch("ventora_llm.extractor.OpenRouterClient") as MockClient:
            mock_instance = AsyncMock()
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=None)

            result = await extractor.extract("doc1", "text", [])

        assert result.results == []
        assert result.merged == {}
        assert result.success is True

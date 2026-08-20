from __future__ import annotations

import json
import logging
import re
from typing import Any

from .client import OpenRouterClient
from .types import ExtractionPass, ExtractionResult, LlmConfig, Message, MultiPassResult

logger = logging.getLogger(__name__)


def _extract_json(text: str) -> dict[str, Any] | None:
    """Try to extract JSON from LLM response (may be wrapped in markdown code blocks)."""
    # Try direct parse first
    try:
        parsed = json.loads(text.strip())
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    # Try to extract from ```json ... ``` block
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(1))
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass
    # Try balanced JSON object candidates embedded in prose.
    for candidate in _json_object_candidates(text):
        try:
            parsed = json.loads(candidate)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            continue
    return None


def _json_object_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    depth = 0
    start: int | None = None
    in_string = False
    escaped = False

    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
            continue
        if char == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                candidates.append(text[start : index + 1])
                start = None

    return candidates


def _validate_schema(value: dict[str, Any] | None, schema: dict[str, Any]) -> str | None:
    """Validate the top-level JSON object shape used by extraction passes."""
    if value is None:
        return "Response did not contain a JSON object"
    if schema.get("type") == "object":
        required = schema.get("required", [])
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    return f"Missing required field: {key}"
        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for key, definition in properties.items():
                if key not in value or not isinstance(definition, dict):
                    continue
                expected_type = definition.get("type")
                if isinstance(expected_type, str) and not _matches_json_type(
                    value[key], expected_type
                ):
                    return f"Field {key} must be {expected_type}"
    return None


def _matches_json_type(value: object, expected_type: str) -> bool:
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "null":
        return value is None
    return True


class MultiPassExtractor:
    """Orchestrates multiple LLM extraction passes over a document."""

    def __init__(self, config: LlmConfig) -> None:
        self._config = config

    async def extract(
        self,
        document_id: str,
        document_text: str,
        passes: list[ExtractionPass],
    ) -> MultiPassResult:
        result = MultiPassResult(document_id=document_id)

        async with OpenRouterClient(self._config) as client:
            previous_results: dict[str, Any] = {}

            for pass_def in passes:
                extraction = await self._run_pass(
                    client, pass_def, document_text, previous_results
                )
                result.results.append(extraction)

                if extraction.success and extraction.parsed:
                    previous_results[pass_def.name] = extraction.parsed
                    result.merged.update(extraction.parsed)

        return result

    async def _run_pass(
        self,
        client: OpenRouterClient,
        pass_def: ExtractionPass,
        document_text: str,
        previous_results: dict[str, Any],
    ) -> ExtractionResult:
        try:
            user_prompt = pass_def.user_prompt_template.format(
                document=document_text,
                previous_results=json.dumps(previous_results, indent=2),
            )
            messages = [
                Message(role="system", content=pass_def.system_prompt),
                Message(role="user", content=user_prompt),
            ]
            response = await client.complete(
                messages,
                model=pass_def.model,
            )
            parsed = _extract_json(response.content)
            if pass_def.output_schema is not None:
                schema_error = _validate_schema(parsed, pass_def.output_schema)
                if schema_error is not None:
                    return ExtractionResult(
                        pass_name=pass_def.name,
                        raw_response=response.content,
                        parsed=parsed,
                        success=False,
                        error=schema_error,
                        tokens_used=response.usage.get("total_tokens", 0),
                    )
            return ExtractionResult(
                pass_name=pass_def.name,
                raw_response=response.content,
                parsed=parsed,
                success=True,
                tokens_used=response.usage.get("total_tokens", 0),
            )
        except Exception as e:
            logger.exception("Extraction pass %r failed", pass_def.name)
            return ExtractionResult(
                pass_name=pass_def.name,
                raw_response="",
                parsed=None,
                success=False,
                error=str(e),
            )

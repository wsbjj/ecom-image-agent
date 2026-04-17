"""JSON Lines visual evaluation service with switchable judge backends."""

from __future__ import annotations

import argparse
import base64
import inspect
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, Field, ValidationError

from judge_prompt import build_judge_system_prompt


DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
DEFAULT_ANTHROPIC_MAX_TOKENS = 2048
DEFAULT_EVAL_BACKEND = "custom_anthropic"

IMAGE_CAPABILITY_ERROR_PATTERNS = (
    "image_url is only supported by certain models",
    "invalid content type",
    "does not support image",
    "image input is not supported",
    "unsupported image",
)

VISION_MODEL_HINT_KEYWORDS = (
    "vision",
    "vl",
    "4v",
    "image",
    "multimodal",
    "omni",
    "pixtral",
)

MODEL_FAMILY_HINTS = (
    "glm",
    "qwen",
    "gemini",
    "claude",
    "gpt",
    "grok",
    "doubao",
    "seed",
    "moonshot",
    "kimi",
    "ernie",
    "minimax",
    "yi",
)

OPENAI_COMPAT_ENV_KEYS = ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE")
ANTHROPIC_ENV_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL")
GEMINI_ENV_KEYS = ("GOOGLE_API_KEY", "GOOGLE_BASE_URL")
QWEN_ENV_KEYS = ("DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_API_BASE")


def get_preferred_env_value(
    primary_key: str,
    fallback_key: str,
    default: str | None = None,
) -> str | None:
    primary = os.environ.get(primary_key)
    if primary is not None and primary.strip():
        return primary.strip()

    fallback = os.environ.get(fallback_key)
    if fallback is not None and fallback.strip():
        return fallback.strip()

    return default


class RubricDimension(BaseModel):
    key: str
    name: str
    maxScore: int = Field(ge=1, le=100)
    weight: float = Field(ge=0)
    description: str


class Rubric(BaseModel):
    dimensions: list[RubricDimension]
    scoringNotes: str | None = None


class EvalRequest(BaseModel):
    request_id: str
    image_path: str
    product_name: str
    context: str
    rubric: Rubric
    pass_threshold: int = Field(ge=0, le=100)


class DimensionScore(BaseModel):
    key: str
    name: str
    score: int = Field(ge=0, le=100)
    maxScore: int = Field(ge=1, le=100)
    weight: float = Field(ge=0)
    issues: list[str]
    reason: str = ""


class DefectAnalysis(BaseModel):
    dimensions: list[DimensionScore]
    overall_recommendation: str
    summary: str | None = None


class EvalResponse(BaseModel):
    request_id: str
    total_score: int
    pass_threshold: int
    passed: bool
    defect_analysis: DefectAnalysis


class JudgeBackend(Protocol):
    backend_name: str
    model_name: str
    use_custom_model: bool

    def infer(self, request: EvalRequest) -> str:
        ...


def configure_stdio_utf8() -> None:
    """Force UTF-8 stdio for cross-platform child-process logging stability."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_env_file(env_path: Path) -> None:
    """Load .env values without overriding existing process env."""
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def parse_boolean_env(raw_value: str | None, fallback: bool) -> bool:
    if raw_value is None:
        return fallback
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return fallback


def ensure_image_exists(image_path: str) -> Path:
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"image not found: {path}")
    return path


def _is_image_capability_error(raw_message: str) -> bool:
    lowered = raw_message.lower()
    return any(pattern in lowered for pattern in IMAGE_CAPABILITY_ERROR_PATTERNS)


def _is_likely_vision_model(model_id: str) -> bool:
    lowered = model_id.strip().lower()
    if not lowered:
        return False
    if "claude" in lowered:
        return True

    for keyword in VISION_MODEL_HINT_KEYWORDS:
        if keyword in lowered:
            return True

    if lowered.startswith("gpt-4o") or lowered.startswith("chatgpt-4o"):
        return True

    if "gpt-4.1" in lowered:
        return True

    return False


def _extract_model_id(item: Any) -> str:
    value = getattr(item, "id", None)
    if value is None and isinstance(item, dict):
        value = item.get("id")
    return value.strip() if isinstance(value, str) else ""


def _infer_model_family(model_id: str) -> str:
    lowered = model_id.strip().lower()
    for token in MODEL_FAMILY_HINTS:
        if token in lowered:
            return token
    return ""


def _build_registry_model_kwargs(
    factory: Any,
    *,
    judge_api_key: str | None,
    judge_base_url: str | None,
) -> dict[str, str]:
    if not judge_api_key and not judge_base_url:
        return {}

    try:
        signature = inspect.signature(factory)
    except (TypeError, ValueError):
        return {}

    parameters = signature.parameters
    accepts_var_kwargs = any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )

    def accepts(name: str) -> bool:
        return accepts_var_kwargs or name in parameters

    kwargs: dict[str, str] = {}
    if judge_api_key:
        for key in ("api_key", "apikey", "key"):
            if accepts(key):
                kwargs[key] = judge_api_key
                break

    if judge_base_url:
        for key in ("base_url", "api_base", "api_base_url"):
            if accepts(key):
                kwargs[key] = judge_base_url
                break

    return kwargs


def _build_registry_env_overrides(
    *,
    model_name: str,
    judge_api_key: str | None,
    judge_base_url: str | None,
) -> dict[str, str]:
    family = _infer_model_family(model_name)
    overrides: dict[str, str] = {}

    def apply_keys(keys: tuple[str, ...], value: str | None) -> None:
        if not value:
            return
        for key in keys:
            overrides[key] = value

    if family == "claude":
        apply_keys((ANTHROPIC_ENV_KEYS[0],), judge_api_key)
        apply_keys((ANTHROPIC_ENV_KEYS[1],), judge_base_url)
        return overrides

    if family == "gemini":
        apply_keys((GEMINI_ENV_KEYS[0],), judge_api_key)
        apply_keys((GEMINI_ENV_KEYS[1],), judge_base_url)
        return overrides

    apply_keys((OPENAI_COMPAT_ENV_KEYS[0],), judge_api_key)
    apply_keys(OPENAI_COMPAT_ENV_KEYS[1:], judge_base_url)
    if family == "qwen":
        apply_keys((QWEN_ENV_KEYS[0],), judge_api_key)
        apply_keys(QWEN_ENV_KEYS[1:], judge_base_url)
    return overrides


def _apply_registry_env_overrides(
    *,
    model_name: str,
    judge_api_key: str | None,
    judge_base_url: str | None,
) -> None:
    overrides = _build_registry_env_overrides(
        model_name=model_name,
        judge_api_key=judge_api_key,
        judge_base_url=judge_base_url,
    )
    if not overrides:
        return

    for key, value in overrides.items():
        os.environ[key] = value

    sys.stderr.write(
        "[VLMEval] registry_model_env_applied "
        f"model={model_name} keys={','.join(sorted(overrides))}\n"
    )


def _pick_vision_fallback_model(
    *,
    current_model: str,
    available_model_ids: list[str],
) -> str | None:
    current_family = _infer_model_family(current_model)

    filtered: list[str] = []
    seen: set[str] = set()
    for model_id in available_model_ids:
        normalized = model_id.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        if _is_likely_vision_model(normalized):
            filtered.append(normalized)

    if not filtered:
        return None

    if current_family:
        same_family = [model_id for model_id in filtered if current_family in model_id.lower()]
        if same_family:
            return same_family[0]

    return filtered[0]


def _build_model_capability_error_message(
    *,
    model_name: str,
    fallback_model: str | None,
    model_list_preview: list[str],
    raw_error: str,
) -> str:
    suggestions: list[str] = []
    family = _infer_model_family(model_name)
    if family == "glm":
        suggestions.extend(["glm-4v-plus-0111", "glm-4v-plus"])
    elif family == "qwen":
        suggestions.extend(["qwen-vl-max", "qwen2.5-vl-72b-instruct"])
    elif family == "grok":
        suggestions.append("grok-2-vision")

    if fallback_model:
        suggestions.insert(0, fallback_model)

    for candidate in model_list_preview:
        if candidate not in suggestions:
            suggestions.append(candidate)
        if len(suggestions) >= 5:
            break

    suggestion_text = (
        ", ".join(suggestions[:5]) if suggestions else "use a vision-capable multimodal model"
    )
    return (
        f"judge model '{model_name}' rejected image input; "
        f"suggested vision models: {suggestion_text}; "
        f"raw_error={raw_error}"
    )


def _looks_like_truncated_json(raw_text: str) -> bool:
    trimmed = raw_text.strip()
    if not trimmed.startswith("{"):
        return False
    if trimmed.count("{") > trimmed.count("}"):
        return True
    return trimmed.endswith((",", ":", "["))


def _extract_json_block(raw_text: str) -> dict[str, Any]:
    candidate_texts: list[str] = []
    trimmed = raw_text.strip()
    if trimmed:
        candidate_texts.append(trimmed)

    for match in re.finditer(r"```json\s*([\s\S]*?)```", raw_text, flags=re.IGNORECASE):
        payload = match.group(1).strip()
        if payload:
            candidate_texts.append(payload)

    for match in re.finditer(r"```\s*([\s\S]*?)```", raw_text):
        payload = match.group(1).strip()
        if payload:
            candidate_texts.append(payload)

    object_candidates: list[str] = []
    for start in [idx for idx, ch in enumerate(raw_text) if ch == "{"]:
        depth = 0
        for end in range(start, len(raw_text)):
            ch = raw_text[end]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    snippet = raw_text[start : end + 1].strip()
                    if snippet:
                        object_candidates.append(snippet)
                    break
            if depth < 0:
                break

    candidate_texts.extend(object_candidates)

    seen: set[str] = set()
    for candidate in candidate_texts:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload

    diagnostic_suffix = " (likely truncated JSON)" if _looks_like_truncated_json(raw_text) else ""
    raise ValueError(f"model did not return valid JSON{diagnostic_suffix}: {raw_text[:200]}")


def _get_block_field(block: Any, key: str) -> Any:
    value = getattr(block, key, None)
    if value is None and isinstance(block, dict):
        value = block.get(key)
    return value


def _collect_present_fields(block: Any, keys: tuple[str, ...]) -> list[str]:
    present: list[str] = []
    for key in keys:
        if _get_block_field(block, key) is not None:
            present.append(key)
    return present


def _collect_text_fragments(value: Any) -> list[str]:
    if isinstance(value, str):
        trimmed = value.strip()
        return [trimmed] if trimmed else []

    if isinstance(value, list):
        fragments: list[str] = []
        for item in value:
            fragments.extend(_collect_text_fragments(item))
        return fragments

    if isinstance(value, dict):
        fragments: list[str] = []
        for key in (
            "text",
            "content",
            "value",
            "thinking",
            "reasoning",
            "output_text",
            "message",
            "delta",
            "completion",
            "response",
            "result",
            "output",
            "outputs",
            "answer",
            "body",
            "data",
            "parts",
        ):
            nested = value.get(key)
            if nested is not None:
                fragments.extend(_collect_text_fragments(nested))
        return fragments

    return []


def _extract_text_from_message_content(message: Any) -> str:
    text_parts: list[str] = []
    fallback_parts: list[str] = []
    diagnostics: list[str] = []
    top_level_fields = _collect_present_fields(
        message,
        (
            "content",
            "choices",
            "text",
            "output_text",
            "completion",
            "response",
            "result",
            "output",
            "outputs",
            "message",
            "delta",
            "data",
        ),
    )
    if top_level_fields:
        diagnostics.append("message_fields=" + ",".join(top_level_fields))

    content = _get_block_field(message, "content")
    if isinstance(content, list):
        block_types: list[str] = []
        for block in content:
            block_type = getattr(block, "type", None)
            if block_type is None and isinstance(block, dict):
                block_type = block.get("type")
            block_types.append(str(block_type) if block_type else type(block).__name__)

            text_parts.extend(_collect_text_fragments(_get_block_field(block, "text")))
            for key in ("thinking", "reasoning", "output_text", "content", "value"):
                fallback_parts.extend(_collect_text_fragments(_get_block_field(block, key)))
        diagnostics.append("content_list=" + ",".join(block_types))
    elif content is not None:
        fallback_parts.extend(_collect_text_fragments(content))
        diagnostics.append(f"content_type={type(content).__name__}")

    # OpenAI-compatible gateways often return choices[].message.content.
    choices = _get_block_field(message, "choices")
    if isinstance(choices, list):
        diagnostics.append(f"choices={len(choices)}")
        for idx, choice in enumerate(choices, start=1):
            choice_fields = _collect_present_fields(
                choice,
                ("text", "content", "message", "delta", "output_text", "completion", "response", "result"),
            )
            if choice_fields:
                diagnostics.append(f"choice_{idx}_fields=" + ",".join(choice_fields))
            for key in ("text", "content"):
                text_parts.extend(_collect_text_fragments(_get_block_field(choice, key)))
            for key in ("message", "delta"):
                fallback_parts.extend(_collect_text_fragments(_get_block_field(choice, key)))
    elif choices is not None:
        fallback_parts.extend(_collect_text_fragments(choices))
        diagnostics.append(f"choices_type={type(choices).__name__}")

    # Additional common fallback keys for proxy-compatible payloads.
    for key in (
        "text",
        "output_text",
        "completion",
        "response",
        "result",
        "output",
        "outputs",
        "message",
        "delta",
        "data",
        "answer",
        "body",
    ):
        fallback_parts.extend(_collect_text_fragments(_get_block_field(message, key)))

    if text_parts:
        return "\n".join(text_parts)
    if fallback_parts:
        return "\n".join(fallback_parts)

    if content is None and choices is None:
        raise ValueError("model content is invalid")
    raise ValueError("model returned no usable text block, diagnostics=" + ",".join(diagnostics))


def _normalize_dimensions(
    raw_dimensions: list[dict[str, Any]],
    rubric_dimensions: list[RubricDimension],
) -> list[DimensionScore]:
    by_key: dict[str, dict[str, Any]] = {}
    for item in raw_dimensions:
        key = str(item.get("key", "")).strip()
        if key:
            by_key[key] = item
    normalized: list[DimensionScore] = []

    for dim in rubric_dimensions:
        raw = by_key.get(dim.key, {})
        score = int(raw.get("score", 0))
        score = max(0, min(dim.maxScore, score))

        issues = raw.get("issues", [])
        if not isinstance(issues, list):
            issues = []

        normalized.append(
            DimensionScore(
                key=dim.key,
                name=dim.name,
                score=score,
                maxScore=dim.maxScore,
                weight=dim.weight,
                issues=[str(item) for item in issues if str(item).strip()][:2],
                reason=str(raw.get("reason", "")),
            )
        )

    return normalized


def _compute_total_score(dimensions: list[DimensionScore]) -> int:
    if len(dimensions) == 0:
        return 0

    denominator = sum(item.maxScore * item.weight for item in dimensions)
    numerator = sum(item.score * item.weight for item in dimensions)

    if denominator <= 0:
        denominator = sum(item.maxScore for item in dimensions)
        numerator = sum(item.score for item in dimensions)

    if denominator <= 0:
        return 0

    weighted = (numerator / denominator) * 100
    return int(round(max(0, min(100, weighted))))


def build_user_prompt(request: EvalRequest) -> str:
    return f"请评估此电商图片。\n商品名称：{request.product_name}\n拍摄场景：{request.context}"


def build_response_from_raw_text(request: EvalRequest, raw_text: str) -> EvalResponse:
    raw_json = _extract_json_block(raw_text)

    raw_dimensions = raw_json.get("dimensions", [])
    if not isinstance(raw_dimensions, list):
        raw_dimensions = []

    normalized_dimensions = _normalize_dimensions(
        [item for item in raw_dimensions if isinstance(item, dict)],
        request.rubric.dimensions,
    )

    total_score = _compute_total_score(normalized_dimensions)

    defect = DefectAnalysis(
        dimensions=normalized_dimensions,
        overall_recommendation=str(raw_json.get("overall_recommendation", "")),
        summary=str(raw_json.get("summary", "")) if raw_json.get("summary") is not None else None,
    )

    return EvalResponse(
        request_id=request.request_id,
        total_score=total_score,
        pass_threshold=request.pass_threshold,
        passed=total_score >= request.pass_threshold,
        defect_analysis=defect,
    )


class AnthropicJudgeBackend:
    backend_name = "custom_anthropic"
    use_custom_model = True

    def __init__(self, *, api_key: str, model_name: str, base_url: str | None = None) -> None:
        import anthropic

        self.model_name = model_name
        self._cached_fallback_model: str | None = None
        self.client = anthropic.Anthropic(
            api_key=api_key,
            **({"base_url": base_url} if base_url else {}),
        )

    def _build_message_request(self, request: EvalRequest, model_name: str) -> dict[str, Any]:
        image_path = ensure_image_exists(request.image_path)
        image_data = base64.standard_b64encode(image_path.read_bytes()).decode()
        suffix = image_path.suffix.lower()
        media_type_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        media_type = media_type_map.get(suffix, "image/png")

        prompt = build_judge_system_prompt(request.rubric.model_dump())
        return {
            "model": model_name,
            "max_tokens": DEFAULT_ANTHROPIC_MAX_TOKENS,
            "temperature": 0,
            "system": prompt,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": build_user_prompt(request),
                        },
                    ],
                }
            ],
        }

    def _infer_with_model(self, request: EvalRequest, model_name: str) -> str:
        message = self.client.messages.create(**self._build_message_request(request, model_name))
        return _extract_text_from_message_content(message)

    def _list_available_model_ids(self) -> list[str]:
        try:
            raw_models = self.client.models.list(limit=100)
        except Exception:  # noqa: BLE001
            return []

        items: list[Any]
        if isinstance(raw_models, list):
            items = raw_models
        else:
            data = getattr(raw_models, "data", None)
            if isinstance(data, list):
                items = data
            else:
                try:
                    items = list(raw_models)
                except Exception:  # noqa: BLE001
                    return []

        model_ids: list[str] = []
        seen: set[str] = set()
        for item in items:
            model_id = _extract_model_id(item)
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            model_ids.append(model_id)

        return model_ids

    def _resolve_fallback_model(self, current_model: str) -> tuple[str | None, list[str]]:
        explicit = os.environ.get("JUDGE_VISION_FALLBACK_MODEL", "").strip()
        if explicit and explicit != current_model:
            return explicit, []

        if self._cached_fallback_model and self._cached_fallback_model != current_model:
            return self._cached_fallback_model, []

        available_model_ids = self._list_available_model_ids()
        picked = _pick_vision_fallback_model(
            current_model=current_model,
            available_model_ids=available_model_ids,
        )
        if picked and picked != current_model:
            self._cached_fallback_model = picked
            return picked, available_model_ids

        return None, available_model_ids

    def infer(self, request: EvalRequest) -> str:
        current_model = self.model_name
        try:
            return self._infer_with_model(request, current_model)
        except Exception as exc:  # noqa: BLE001
            raw_error = str(exc)
            if not _is_image_capability_error(raw_error):
                raise

            fallback_model, available_model_ids = self._resolve_fallback_model(current_model)
            if fallback_model:
                sys.stderr.write(
                    "[VLMEval] judge_model_incompatible "
                    f"model={current_model} fallback_model={fallback_model}\n"
                )
                try:
                    fallback_result = self._infer_with_model(request, fallback_model)
                    self.model_name = fallback_model
                    sys.stderr.write(f"[VLMEval] judge_model_switched active_model={fallback_model}\n")
                    return fallback_result
                except Exception as retry_exc:  # noqa: BLE001
                    raise RuntimeError(
                        _build_model_capability_error_message(
                            model_name=current_model,
                            fallback_model=fallback_model,
                            model_list_preview=available_model_ids[:10],
                            raw_error=str(retry_exc),
                        )
                    ) from retry_exc

            raise RuntimeError(
                _build_model_capability_error_message(
                    model_name=current_model,
                    fallback_model=None,
                    model_list_preview=available_model_ids[:10],
                    raw_error=raw_error,
                )
            ) from exc


class VLMEvalKitJudgeBackend:
    backend_name = "vlmevalkit"

    def __init__(
        self,
        *,
        model_name: str,
        use_custom_model: bool,
        judge_api_key: str | None,
        judge_base_url: str | None,
    ) -> None:
        from vlmeval_adapter import AnthropicVLMEvalJudge, VLMEvalOnlineJudgeDataset

        self.model_name = model_name
        self.dataset = VLMEvalOnlineJudgeDataset()
        self.use_custom_model = use_custom_model

        if use_custom_model:
            if not judge_api_key:
                raise RuntimeError(
                    "JUDGE_API_KEY is required for vlmevalkit backend when custom model adapter is enabled"
                )
            self.model = AnthropicVLMEvalJudge(
                api_key=judge_api_key,
                model_id=model_name,
                base_url=judge_base_url,
            )
            return

        try:
            from vlmeval.config import supported_VLM

            factory = supported_VLM.get(model_name)
            if factory is None:
                raise KeyError(model_name)
            _apply_registry_env_overrides(
                model_name=model_name,
                judge_api_key=judge_api_key,
                judge_base_url=judge_base_url,
            )
            factory_kwargs = _build_registry_model_kwargs(
                factory,
                judge_api_key=judge_api_key,
                judge_base_url=judge_base_url,
            )
            self.model = factory(**factory_kwargs) if factory_kwargs else factory()
        except Exception as exc:  # noqa: BLE001
            if not judge_api_key:
                raise RuntimeError(
                    "VLMEVAL_USE_CUSTOM_MODEL=false failed to resolve a registry model and no JUDGE_API_KEY is available for fallback"
                ) from exc
            sys.stderr.write(
                f"[VLMEval] registry_model_unavailable model={model_name} fallback=custom reason={exc}\n"
            )
            self.model = AnthropicVLMEvalJudge(
                api_key=judge_api_key,
                model_id=model_name,
                base_url=judge_base_url,
            )
            self.use_custom_model = True

    def infer(self, request: EvalRequest) -> str:
        ensure_image_exists(request.image_path)
        message = self.dataset.build_message(
            image_path=request.image_path,
            product_name=request.product_name,
            context=request.context,
            system_prompt=build_judge_system_prompt(request.rubric.model_dump()),
        )
        output = self.model.generate(message, dataset=self.dataset.NAME)
        if not isinstance(output, str):
            raise ValueError("vlmeval model did not return text output")
        return output


def create_backend() -> JudgeBackend:
    eval_backend = os.environ.get("EVAL_BACKEND", DEFAULT_EVAL_BACKEND).strip() or DEFAULT_EVAL_BACKEND
    judge_api_key = get_preferred_env_value("JUDGE_API_KEY", "ANTHROPIC_API_KEY")
    judge_base_url = get_preferred_env_value("JUDGE_BASE_URL", "ANTHROPIC_BASE_URL")
    judge_model = get_preferred_env_value(
        "JUDGE_MODEL",
        "ANTHROPIC_MODEL",
        DEFAULT_ANTHROPIC_MODEL,
    )

    if eval_backend == "custom_anthropic":
        if not judge_api_key:
            sys.stderr.write("[VLMEval] missing_required_env key=JUDGE_API_KEY fallback=ANTHROPIC_API_KEY\n")
            raise RuntimeError(
                "JUDGE_API_KEY is required for custom_anthropic backend (or fallback ANTHROPIC_API_KEY)"
            )
        return AnthropicJudgeBackend(
            api_key=judge_api_key,
            model_name=judge_model,
            base_url=judge_base_url,
        )

    if eval_backend == "vlmevalkit":
        use_custom_model = parse_boolean_env(os.environ.get("VLMEVAL_USE_CUSTOM_MODEL"), True)
        model_name = os.environ.get("VLMEVAL_MODEL_ID", "").strip() or judge_model
        return VLMEvalKitJudgeBackend(
            model_name=model_name,
            use_custom_model=use_custom_model,
            judge_api_key=judge_api_key,
            judge_base_url=judge_base_url,
        )

    raise RuntimeError(f"unsupported EVAL_BACKEND: {eval_backend}")


def evaluate_image(request: EvalRequest, backend: JudgeBackend) -> EvalResponse:
    raw_text = backend.infer(request)
    return build_response_from_raw_text(request, raw_text)


def main() -> None:
    configure_stdio_utf8()

    parser = argparse.ArgumentParser(description="VLMEval JSON Lines evaluation service")
    parser.add_argument("--workdir", required=True, help="working directory path")
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    load_env_file(Path(__file__).resolve().parent / ".env")

    backend = create_backend()
    base_url = get_preferred_env_value("JUDGE_BASE_URL", "ANTHROPIC_BASE_URL")
    if base_url:
        sys.stderr.write(f"[VLMEval] using_custom_base_url value={base_url}\n")
    sys.stderr.write(f"[VLMEval] backend={backend.backend_name}\n")
    sys.stderr.write(f"[VLMEval] model={backend.model_name}\n")
    sys.stderr.write(f"[VLMEval] use_custom_model={backend.use_custom_model}\n")
    sys.stderr.write("[VLMEval] service_started status=ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = "unknown"
        try:
            raw_data = json.loads(line)
            request_id = raw_data.get("request_id", "unknown")
            request = EvalRequest.model_validate(raw_data)
            response = evaluate_image(request, backend)
            sys.stdout.write(response.model_dump_json() + "\n")
        except ValidationError as exc:
            error_resp = {"request_id": request_id, "error": str(exc)}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        except json.JSONDecodeError as exc:
            error_resp = {"request_id": request_id, "error": f"JSON parse failed: {exc}"}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[VLMEval] processing_error error={exc}\n")
            error_resp = {"request_id": request_id, "error": str(exc)}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        finally:
            sys.stdout.flush()


if __name__ == "__main__":
    main()

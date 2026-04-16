"""VLMEvalKit JSON Lines 服务进程

通过 stdin 接收评估请求（JSON Lines），调用 Anthropic 模型作为 judge，
通过 stdout 返回评分结果。模型名称可通过 ANTHROPIC_MODEL 配置。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any

import anthropic
from pydantic import BaseModel, Field, ValidationError

from judge_prompt import build_judge_system_prompt


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


def configure_stdio_utf8() -> None:
    """Force UTF-8 stdio for cross-platform child-process logging stability."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_env_file(env_path: Path) -> None:
    """从 .env 读取配置并注入环境变量（不覆盖已有系统变量）。"""
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


def _extract_json_block(raw_text: str) -> dict[str, Any]:
    start = raw_text.find("{")
    end = raw_text.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError(f"模型未返回有效 JSON: {raw_text[:200]}")
    return json.loads(raw_text[start:end])


def _extract_text_from_message_content(message: Any) -> str:
    content = getattr(message, "content", None)
    if not isinstance(content, list):
        raise ValueError("model content is invalid")

    text_parts: list[str] = []
    block_types: list[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type is None and isinstance(block, dict):
            block_type = block.get("type")
        block_types.append(str(block_type) if block_type else type(block).__name__)

        text_value = getattr(block, "text", None)
        if text_value is None and isinstance(block, dict):
            text_value = block.get("text")
        if isinstance(text_value, str):
            trimmed = text_value.strip()
            if trimmed:
                text_parts.append(trimmed)

    if not text_parts:
        raise ValueError("model returned no text block, block_types=" + ",".join(block_types))

    return "\n".join(text_parts)


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
                issues=[str(item) for item in issues if str(item).strip()],
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


def evaluate_image(
    request: EvalRequest,
    client: anthropic.Anthropic,
    model_name: str,
) -> EvalResponse:
    image_path = Path(request.image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"图片不存在: {image_path}")

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

    message = client.messages.create(
        model=model_name,
        max_tokens=1024,
        temperature=0,
        system=prompt,
        messages=[
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
                        "text": (
                            "请评估此电商图片。"
                            f"商品名称：{request.product_name}，"
                            f"拍摄场景：{request.context}"
                        ),
                    },
                ],
            }
        ],
    )

    raw_text = _extract_text_from_message_content(message)
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


def main() -> None:
    configure_stdio_utf8()

    parser = argparse.ArgumentParser(description="VLMEvalKit JSON Lines 评估服务")
    parser.add_argument("--workdir", required=True, help="工作目录路径")
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    load_env_file(Path(__file__).resolve().parent / ".env")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.stderr.write("[VLMEval] missing_required_env key=ANTHROPIC_API_KEY\n")
        sys.exit(1)
    model_name = os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")

    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    if base_url:
        sys.stderr.write(f"[VLMEval] using_custom_base_url value={base_url}\n")
        client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
    else:
        client = anthropic.Anthropic(api_key=api_key)

    sys.stderr.write(f"[VLMEval] model={model_name}\n")
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
            response = evaluate_image(request, client, model_name)
            sys.stdout.write(response.model_dump_json() + "\n")
        except ValidationError as e:
            error_resp = {"request_id": request_id, "error": str(e)}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        except json.JSONDecodeError as e:
            error_resp = {"request_id": request_id, "error": f"JSON 解析失败: {e}"}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[VLMEval] processing_error error={e}\n")
            error_resp = {"request_id": request_id, "error": str(e)}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        finally:
            sys.stdout.flush()


if __name__ == "__main__":
    main()

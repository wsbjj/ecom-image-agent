"""VLMEvalKit JSON Lines 服务进程

通过 stdin 接收评估请求（JSON Lines），调用 Anthropic 模型作为 judge，
通过 stdout 返回评分结果。模型名称可通过 ANTHROPIC_MODEL 配置。
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError
import anthropic

from judge_prompt import JUDGE_SYSTEM_PROMPT


class EvalRequest(BaseModel):
    request_id: str
    image_path: str
    product_name: str
    context: str


class DimensionScore(BaseModel):
    score: int = Field(ge=0, le=30)
    issues: list[str]


class DefectAnalysis(BaseModel):
    edge_distortion: DimensionScore
    perspective_lighting: DimensionScore
    hallucination: DimensionScore
    overall_recommendation: str


class EvalResponse(BaseModel):
    request_id: str
    total_score: int
    defect_analysis: DefectAnalysis


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

    message = client.messages.create(
        model=model_name,
        max_tokens=1024,
        temperature=0,
        system=JUDGE_SYSTEM_PROMPT,
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
                            f"请评估此电商图片。"
                            f"商品名称：{request.product_name}，"
                            f"拍摄场景：{request.context}"
                        ),
                    },
                ],
            }
        ],
    )

    raw_text = message.content[0].text.strip()
    start = raw_text.find("{")
    end = raw_text.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError(f"模型未返回有效 JSON: {raw_text[:200]}")

    raw_json: dict[str, Any] = json.loads(raw_text[start:end])

    overall_score: int = raw_json.get("overall_score", 5)
    defect = DefectAnalysis(
        edge_distortion=DimensionScore(**raw_json["edge_distortion"]),
        perspective_lighting=DimensionScore(**raw_json["perspective_lighting"]),
        hallucination=DimensionScore(**raw_json["hallucination"]),
        overall_recommendation=raw_json.get("overall_recommendation", ""),
    )
    total = (
        defect.edge_distortion.score
        + defect.perspective_lighting.score
        + defect.hallucination.score
        + overall_score
    )

    return EvalResponse(
        request_id=request.request_id,
        total_score=min(total, 100),
        defect_analysis=defect,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="VLMEvalKit JSON Lines 评估服务")
    parser.add_argument("--workdir", required=True, help="工作目录路径")
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    # 支持从脚本同目录 .env 读取配置，便于本地直接运行
    load_env_file(Path(__file__).resolve().parent / ".env")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.stderr.write("[VLMEval] ANTHROPIC_API_KEY 未设置\n")
        sys.exit(1)
    model_name = os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")

    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    if base_url:
        sys.stderr.write(f"[VLMEval] 使用自定义 ANTHROPIC_BASE_URL: {base_url}\n")
        client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
    else:
        client = anthropic.Anthropic(api_key=api_key)
    sys.stderr.write(f"[VLMEval] 使用模型: {model_name}\n")
    sys.stderr.write("[VLMEval] 服务启动，等待请求...\n")
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
            sys.stderr.write(f"[VLMEval] 处理错误: {e}\n")
            error_resp = {"request_id": request_id, "error": str(e)}
            sys.stdout.write(json.dumps(error_resp, ensure_ascii=False) + "\n")
        finally:
            sys.stdout.flush()


if __name__ == "__main__":
    main()

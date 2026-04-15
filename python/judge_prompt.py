"""动态评分 Prompt 模板，由 vlmeval_server.py 使用"""

from __future__ import annotations

from typing import Any


def build_judge_system_prompt(rubric: dict[str, Any]) -> str:
    dimensions = rubric.get("dimensions", [])
    if not isinstance(dimensions, list) or len(dimensions) == 0:
        raise ValueError("rubric.dimensions 不能为空")

    dimension_lines: list[str] = []
    schema_lines: list[str] = []

    for idx, item in enumerate(dimensions, start=1):
        key = str(item.get("key", "")).strip()
        name = str(item.get("name", key or f"dim_{idx}")).strip()
        max_score = int(item.get("maxScore", 10))
        weight = float(item.get("weight", 0))
        description = str(item.get("description", "")).strip()
        if not key:
            raise ValueError("rubric dimension key 不能为空")

        dimension_lines.append(
            f"{idx}. **{name}**（key={key}, 0-{max_score}分, 权重={weight:.3f}）：{description}"
        )

        schema_lines.append(
            "{"
            f'"key": "{key}", '
            f'"name": "{name}", '
            '"score": <int>, '
            f'"maxScore": {max_score}, '
            f'"weight": {weight:.3f}, '
            '"issues": [<string>], '
            '"reason": "<string>"'
            "}"
        )

    notes = str(rubric.get("scoringNotes", "")).strip()
    notes_block = f"\n补充规则：{notes}\n" if notes else "\n"

    return (
        "你是一位专业的电商图片质量评审官。"
        "请严格按 rubric 逐项打分并返回 JSON。"
        "\n\n## 评分维度\n"
        + "\n".join(dimension_lines)
        + notes_block
        + "\n## 输出格式（严格 JSON，不得有任何额外文字）\n"
        + "{\n"
        + '  "dimensions": ['
        + ", ".join(schema_lines)
        + "],\n"
        + '  "overall_recommendation": "<string>",\n'
        + '  "summary": "<string>"\n'
        + "}\n"
    ).strip()

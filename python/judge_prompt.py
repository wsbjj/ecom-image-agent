"""Dynamic judge prompt template used by vlmeval_server.py."""

from __future__ import annotations

from typing import Any

MAX_ISSUES_PER_DIMENSION = 2


def build_judge_system_prompt(rubric: dict[str, Any]) -> str:
    dimensions = rubric.get("dimensions", [])
    if not isinstance(dimensions, list) or len(dimensions) == 0:
        raise ValueError("rubric.dimensions must not be empty")

    dimension_lines: list[str] = []
    schema_lines: list[str] = []

    for idx, item in enumerate(dimensions, start=1):
        key = str(item.get("key", "")).strip()
        name = str(item.get("name", key or f"dim_{idx}")).strip()
        max_score = int(item.get("maxScore", 10))
        weight = float(item.get("weight", 0))
        description = str(item.get("description", "")).strip()
        if not key:
            raise ValueError("rubric dimension key must not be empty")

        dimension_lines.append(
            f"{idx}. {name} (key={key}, score=0-{max_score}, weight={weight:.3f}): {description}"
        )

        schema_lines.append(
            "{"
            f'"key": "{key}", '
            f'"name": "{name}", '
            '"score": <int>, '
            f'"maxScore": {max_score}, '
            f'"weight": {weight:.3f}, '
            f'"issues": ["<short string>", "... up to {MAX_ISSUES_PER_DIMENSION} items"], '
            '"reason": "<short string>"'
            "}"
        )

    notes = str(rubric.get("scoringNotes", "")).strip()
    notes_block = f"\nExtra rubric notes:\n{notes}\n" if notes else "\n"

    return (
        "You are a strict e-commerce image quality judge.\n"
        "Return ONLY one valid JSON object.\n"
        "Do not output markdown, code fences, commentary, or any extra text.\n"
        "Keep every string short, concrete, and directly grounded in the image.\n"
        f"For each dimension, include at most {MAX_ISSUES_PER_DIMENSION} short issues.\n"
        "Keep each reason short. Keep summary optional and short.\n"
        'Use "" for optional strings when there is nothing useful to add.\n'
        "Do not repeat the rubric descriptions in the output.\n"
        "\nDimensions:\n"
        + "\n".join(dimension_lines)
        + notes_block
        + "\nRequired JSON schema:\n"
        + "{\n"
        + '  "dimensions": ['
        + ", ".join(schema_lines)
        + "],\n"
        + '  "overall_recommendation": "<short actionable string>",\n'
        + '  "summary": "<optional short summary>"\n'
        + "}\n"
    ).strip()

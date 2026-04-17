from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from vlmeval.vlm.base import BaseModel


def _get_block_field(block: Any, key: str) -> Any:
    value = getattr(block, key, None)
    if value is None and isinstance(block, dict):
        value = block.get(key)
    return value


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

    content = _get_block_field(message, "content")
    if isinstance(content, list):
        for block in content:
            text_parts.extend(_collect_text_fragments(_get_block_field(block, "text")))
            for key in ("thinking", "reasoning", "output_text", "content", "value"):
                fallback_parts.extend(_collect_text_fragments(_get_block_field(block, key)))
        diagnostics.append(f"content_blocks={len(content)}")
    elif content is not None:
        fallback_parts.extend(_collect_text_fragments(content))
        diagnostics.append(f"content_type={type(content).__name__}")

    choices = _get_block_field(message, "choices")
    if isinstance(choices, list):
        diagnostics.append(f"choices={len(choices)}")
        for choice in choices:
            for key in ("text", "content"):
                text_parts.extend(_collect_text_fragments(_get_block_field(choice, key)))
            for key in ("message", "delta"):
                fallback_parts.extend(_collect_text_fragments(_get_block_field(choice, key)))
    elif choices is not None:
        fallback_parts.extend(_collect_text_fragments(choices))
        diagnostics.append(f"choices_type={type(choices).__name__}")

    for key in (
        "text",
        "output_text",
        "completion",
        "response",
        "result",
        "output",
        "outputs",
        "answer",
        "body",
        "data",
    ):
        fallback_parts.extend(_collect_text_fragments(_get_block_field(message, key)))

    if text_parts:
        return "\n".join(text_parts)
    if fallback_parts:
        return "\n".join(fallback_parts)

    if content is None and choices is None:
        raise ValueError("model content is invalid")
    raise ValueError("model returned no usable text block, diagnostics=" + ",".join(diagnostics))


def _image_path_to_anthropic_block(image_path: str) -> dict[str, Any]:
    image = Path(image_path)
    if not image.exists():
        raise FileNotFoundError(f"image not found: {image}")

    suffix = image.suffix.lower()
    media_type_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    media_type = media_type_map.get(suffix, "image/png")
    image_data = base64.standard_b64encode(image.read_bytes()).decode()
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": image_data,
        },
    }


class VLMEvalOnlineJudgeDataset:
    NAME = "ecom_online_judge"

    def build_message(
        self,
        *,
        image_path: str,
        product_name: str,
        context: str,
        system_prompt: str,
    ) -> list[dict[str, Any]]:
        return [
            {
                "type": "text",
                "value": system_prompt,
                "role": "system",
            },
            {
                "type": "image",
                "value": image_path,
            },
            {
                "type": "text",
                "value": f"请评估此电商图片。\n商品名称：{product_name}\n拍摄场景：{context}",
                "role": "user",
            },
        ]


class AnthropicVLMEvalJudge(BaseModel):
    INSTALL_REQ = False
    INTERLEAVE = True

    def __init__(
        self,
        *,
        api_key: str,
        model_id: str,
        base_url: str | None = None,
        max_tokens: int = 2048,
        temperature: float = 0,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        import anthropic

        self.model_id = model_id
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.client = anthropic.Anthropic(
            api_key=api_key,
            **({"base_url": base_url} if base_url else {}),
        )

    def use_custom_prompt(self, dataset: str | None = None) -> bool:
        return True

    def build_prompt(self, line: Any, dataset: str | None = None) -> Any:
        return line

    def generate_inner(self, message: list[dict[str, Any]], dataset: str | None = None) -> str:
        system_segments: list[str] = []
        user_content: list[dict[str, Any]] = []

        for item in message:
            item_type = item.get("type")
            value = item.get("value")
            role = item.get("role", "user")

            if item_type == "text":
                text = str(value)
                if role == "system":
                    system_segments.append(text)
                else:
                    user_content.append({"type": "text", "text": text})
                continue

            if item_type == "image":
                user_content.append(_image_path_to_anthropic_block(str(value)))
                continue

            raise ValueError(f"unsupported message type: {item_type}")

        if not user_content:
            raise ValueError("empty vlmeval judge message")

        request: dict[str, Any] = {
            "model": self.model_id,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": [
                {
                    "role": "user",
                    "content": user_content,
                }
            ],
        }
        if system_segments:
            request["system"] = "\n\n".join(system_segments)

        response = self.client.messages.create(**request)
        return _extract_text_from_message_content(response)

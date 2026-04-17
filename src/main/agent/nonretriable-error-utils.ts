export interface ParsedModelCapabilityFailure {
  raw: string
  statusCode: number | null
  requestId: string | null
  provider: string
  tool: string | null
  hint: string
}

const STATUS_PATTERNS = [
  /\bstatus(?:\s+code)?\s*(?:=|:)?\s*(\d{3})\b/i,
  /\bwith status code\s*(\d{3})\b/i,
  /\bhttp\s*(\d{3})\b/i,
  /\bcode\s*(?:=|:)?\s*(\d{3})\b/i,
]

const REQUEST_ID_PATTERNS = [
  /\brequest id:\s*([a-z0-9-]+)/i,
  /\brequest_id=([a-z0-9-]+)/i,
  /\bx-request-id[:=]\s*([a-z0-9-]+)/i,
]

const MODEL_CAPABILITY_KEYWORDS = [
  'invalid content type',
  'image_url is only supported by certain models',
  'does not support image input',
  'does not support images',
  'this model does not support images',
  'vision is not supported',
  'multimodal input is not supported',
  'rejected image input',
  'suggested vision models',
]

function normalizeRawError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function detectStatusCode(raw: string): number | null {
  for (const pattern of STATUS_PATTERNS) {
    const match = raw.match(pattern)
    if (!match?.[1]) continue
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }
  return null
}

function detectRequestId(raw: string): string | null {
  for (const pattern of REQUEST_ID_PATTERNS) {
    const match = raw.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function resolveProvider(raw: string, providerHint?: string): string {
  const normalizedHint = providerHint?.trim().toLowerCase()
  if (normalizedHint) {
    return normalizedHint
  }

  const lower = raw.toLowerCase()
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'anthropic'
  }
  if (lower.includes('codex') || lower.includes('openai')) {
    return 'codex'
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    return 'gemini'
  }
  if (lower.includes('seedream') || lower.includes('visual api')) {
    return 'seedream'
  }
  return 'unknown'
}

function hasModelCapabilityKeyword(raw: string): boolean {
  const lower = raw.toLowerCase()
  return MODEL_CAPABILITY_KEYWORDS.some((keyword) => lower.includes(keyword))
}

function resolveHint(provider: string, tool?: string | null): string {
  if (tool === 'evaluate_image' || provider === 'anthropic') {
    return '检查 JUDGE_MODEL 是否为支持图像输入的多模态模型，并确认 JUDGE_BASE_URL 指向兼容视觉输入的 Anthropic-compatible 端点；若未配置 JUDGE_*，当前会回退到 ANTHROPIC_*。'
  }
  if (provider === 'codex') {
    return '检查当前模型与 Base URL 是否支持图片输入，或是否兼容当前 SDK 的多模态消息格式。'
  }
  return '检查当前模型、接口与 SDK 消息格式是否支持图片输入。'
}

export function parseModelCapabilityFailure(
  error: unknown,
  options?: {
    providerHint?: string
    tool?: string | null
  },
): ParsedModelCapabilityFailure | null {
  const raw = normalizeRawError(error).trim()
  if (!raw) return null
  if (!hasModelCapabilityKeyword(raw)) return null

  const provider = resolveProvider(raw, options?.providerHint)
  return {
    raw,
    statusCode: detectStatusCode(raw),
    requestId: detectRequestId(raw),
    provider,
    tool: options?.tool ?? null,
    hint: resolveHint(provider, options?.tool ?? null),
  }
}

export function formatModelCapabilityFailureDetail(parsed: ParsedModelCapabilityFailure): string {
  const segments = [
    `tool=${parsed.tool ?? 'unknown'}`,
    `status=${parsed.statusCode ?? 'unknown'}`,
    `provider=${parsed.provider}`,
    `request_id=${parsed.requestId ?? 'unknown'}`,
    `hint=${parsed.hint}`,
  ]
  return segments.join(', ')
}

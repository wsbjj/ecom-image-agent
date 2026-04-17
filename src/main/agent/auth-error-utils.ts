export interface ParsedAuthFailure {
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
  /\berror:\s*(\d{3})\b/i,
  /\bcode\s*(?:=|:)?\s*(\d{3})\b/i,
]

const REQUEST_ID_PATTERNS = [
  /\brequest id:\s*([a-z0-9-]+)/i,
  /\brequest_id=([a-z0-9-]+)/i,
  /\bx-request-id[:=]\s*([a-z0-9-]+)/i,
]

const AUTH_KEYWORDS = [
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid_api_key',
  'invalidaccesskeyid',
  'signaturedoesnotmatch',
  'authfailure',
  'authentication failed',
  'authorization failed',
  'access denied',
  'permission denied',
  'insufficient permissions',
  'not available in your coding plan',
  'not enabled for your account',
  'account is not authorized',
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

function normalizeProviderHint(providerHint?: string): string | null {
  const normalizedHint = providerHint?.trim().toLowerCase()
  if (!normalizedHint) return null
  if (normalizedHint.includes('seedream')) return 'seedream'
  if (normalizedHint.includes('gemini') || normalizedHint.includes('google')) return 'gemini'
  if (normalizedHint.includes('anthropic') || normalizedHint.includes('claude')) return 'anthropic'
  if (normalizedHint.includes('codex') || normalizedHint.includes('openai')) return 'codex'
  return normalizedHint
}

function resolveProvider(raw: string, providerHint?: string): string {
  const lower = raw.toLowerCase()
  if (
    lower.includes('seedream') ||
    lower.includes('volces') ||
    lower.includes('ark.cn-beijing') ||
    lower.includes('visual api')
  ) {
    return 'seedream'
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    return 'gemini'
  }
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'anthropic'
  }
  if (lower.includes('codex') || lower.includes('openai')) {
    return 'codex'
  }

  const normalizedHint = normalizeProviderHint(providerHint)
  if (normalizedHint) {
    return normalizedHint
  }
  return 'unknown'
}

function resolveHint(provider: string, tool?: string | null, raw?: string): string {
  const lower = raw?.toLowerCase() ?? ''
  if (provider === 'seedream') {
    return '检查 Seedream API Key、Base URL、Endpoint；若使用 visual_official 模式，也请同时检查 AK/SK/ReqKey 与 IAM 权限。'
  }
  if (provider === 'gemini') {
    return '检查 Google API Key、Base URL 与模型配置是否可用。'
  }
  if (provider === 'anthropic') {
    if (lower.includes('not available in your coding plan')) {
      return '当前模型不在你的 Anthropic/Coding plan 可用范围内，请改用可用模型（建议先获取模型列表后选择）。'
    }
    if (tool === 'evaluate_image') {
      return '检查 JUDGE_API_KEY、JUDGE_BASE_URL、JUDGE_MODEL 配置；若未配置 JUDGE_*，当前会回退到 ANTHROPIC_*。'
    }
    return '检查 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL 配置。'
  }
  if (provider === 'codex') {
    return '检查 CODEX_API_KEY、CODEX_BASE_URL、CODEX_MODEL 配置与权限。'
  }
  return '检查当前 provider 的 API Key、Base URL、Model/Endpoint 与权限配置。'
}

function hasAuthKeyword(raw: string): boolean {
  const lower = raw.toLowerCase()
  return AUTH_KEYWORDS.some((keyword) => lower.includes(keyword))
}

export function parseAuthFailure(
  error: unknown,
  options?: {
    providerHint?: string
    tool?: string | null
  },
): ParsedAuthFailure | null {
  const raw = normalizeRawError(error).trim()
  if (!raw) return null

  const statusCode = detectStatusCode(raw)
  const authByStatus = statusCode === 401 || statusCode === 403
  const authByKeyword = hasAuthKeyword(raw)

  if (!authByStatus && !authByKeyword) {
    return null
  }

  const provider = resolveProvider(raw, options?.providerHint)
  return {
    raw,
    statusCode,
    requestId: detectRequestId(raw),
    provider,
    tool: options?.tool ?? null,
    hint: resolveHint(provider, options?.tool ?? null, raw),
  }
}

export function formatAuthFailureDetail(parsed: ParsedAuthFailure): string {
  const segments = [
    `tool=${parsed.tool ?? 'unknown'}`,
    `status=${parsed.statusCode ?? 'unknown'}`,
    `provider=${parsed.provider}`,
    `request_id=${parsed.requestId ?? 'unknown'}`,
    `hint=${parsed.hint}`,
  ]
  return segments.join(', ')
}

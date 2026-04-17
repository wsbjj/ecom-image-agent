import { useEffect, useState, useCallback } from 'react'
import { useConfigStore } from '../store/config.store'
import type { ImageProviderName, EvaluationBackendName } from '../../shared/types'

const DEFAULT_AGENT_MAX_RETRIES = 3
const MIN_AGENT_MAX_RETRIES = 0
const MAX_AGENT_MAX_RETRIES = 10
const DEFAULT_AGENT_SCORE_THRESHOLD = 85
const MIN_AGENT_SCORE_THRESHOLD = 0
const MAX_AGENT_SCORE_THRESHOLD = 100
const DEFAULT_AGENT_ENGINE: 'claude_sdk' | 'codex_sdk' | 'legacy' = 'claude_sdk'
const DEFAULT_CODEX_MODEL = 'gpt-5.4'
const DEFAULT_CONTEXT_RETENTION_RATIO = 0.3
const MIN_CONTEXT_RETENTION_RATIO = 0.1
const MAX_CONTEXT_RETENTION_RATIO = 0.9
const DEFAULT_CONTEXT_COMPRESSION_SOFT = 70
const DEFAULT_CONTEXT_COMPRESSION_HARD = 85
const DEFAULT_CONTEXT_COMPRESSION_CRITICAL = 92
const DEFAULT_EVAL_BACKEND: EvaluationBackendName = 'custom_anthropic'
const DEFAULT_VLMEVAL_USE_CUSTOM_MODEL = true

type ModelOption = {
  id: string
  displayName: string
}

function isLikelyNonClaudeModel(rawValue: string): boolean {
  const value = rawValue.trim().toLowerCase()
  if (!value) return false
  if (value.includes('claude')) return false
  return [
    'glm',
    'qwen',
    'gemini',
    'gpt',
    'grok',
    'doubao',
    'seed',
    'moonshot',
    'kimi',
    'ernie',
    'minimax',
    'yi',
  ].some((keyword) => value.includes(keyword))
}

function normalizeAgentMaxRetries(rawValue: string | null): string {
  if (!rawValue) return String(DEFAULT_AGENT_MAX_RETRIES)
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return String(DEFAULT_AGENT_MAX_RETRIES)
  const clamped = Math.min(MAX_AGENT_MAX_RETRIES, Math.max(MIN_AGENT_MAX_RETRIES, parsed))
  return String(clamped)
}

function parseAgentMaxRetriesInput(rawValue: string): number | null {
  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (parsed < MIN_AGENT_MAX_RETRIES || parsed > MAX_AGENT_MAX_RETRIES) return null
  return parsed
}

function normalizeAgentScoreThreshold(rawValue: string | null): string {
  if (!rawValue) return String(DEFAULT_AGENT_SCORE_THRESHOLD)
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return String(DEFAULT_AGENT_SCORE_THRESHOLD)
  const clamped = Math.min(MAX_AGENT_SCORE_THRESHOLD, Math.max(MIN_AGENT_SCORE_THRESHOLD, parsed))
  return String(clamped)
}

function parseAgentScoreThresholdInput(rawValue: string): number | null {
  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (parsed < MIN_AGENT_SCORE_THRESHOLD || parsed > MAX_AGENT_SCORE_THRESHOLD) return null
  return parsed
}

function normalizeContextRetentionRatio(rawValue: string | null): string {
  if (!rawValue) return String(DEFAULT_CONTEXT_RETENTION_RATIO)
  const parsed = Number.parseFloat(rawValue.trim())
  if (!Number.isFinite(parsed)) return String(DEFAULT_CONTEXT_RETENTION_RATIO)
  const clamped = Math.min(MAX_CONTEXT_RETENTION_RATIO, Math.max(MIN_CONTEXT_RETENTION_RATIO, parsed))
  return clamped.toFixed(2)
}

function parseContextRetentionRatioInput(rawValue: string): number | null {
  const trimmed = rawValue.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) return null
  if (parsed < MIN_CONTEXT_RETENTION_RATIO || parsed > MAX_CONTEXT_RETENTION_RATIO) return null
  return parsed
}

function normalizeContextCompressionThreshold(rawValue: string | null, fallback: number): string {
  if (!rawValue) return String(fallback)
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return String(fallback)
  const clamped = Math.min(99, Math.max(1, parsed))
  return String(clamped)
}

function parseContextCompressionThresholdInput(rawValue: string): number | null {
  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (parsed < 1 || parsed > 99) return null
  return parsed
}

function normalizeBooleanConfig(rawValue: string | null, fallback: boolean): boolean {
  if (!rawValue) return fallback
  const normalized = rawValue.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function normalizeEvaluationBackend(rawValue: string | null): EvaluationBackendName {
  return rawValue?.trim() === 'vlmevalkit' ? 'vlmevalkit' : DEFAULT_EVAL_BACKEND
}

export function Settings() {
  const {
    hasAnthropicKey,
    hasGoogleKey,
    hasSeedreamKey,
    activeProvider,
    isChecking,
    checkKeys,
    saveKey,
    setActiveProvider,
  } = useConfigStore()

  const [anthropicInput, setAnthropicInput] = useState('')
  const [judgeInput, setJudgeInput] = useState('')
  const [googleInput, setGoogleInput] = useState('')
  const [seedreamInput, setSeedreamInput] = useState('')
  const [seedreamEndpointId, setSeedreamEndpointId] = useState('')
  const [seedreamBaseUrl, setSeedreamBaseUrl] = useState('')
  const [seedreamCallMode, setSeedreamCallMode] = useState<'visual_official' | 'openai_compat'>('openai_compat')
  const [seedreamVisualAccessKey, setSeedreamVisualAccessKey] = useState('')
  const [seedreamVisualSecretKey, setSeedreamVisualSecretKey] = useState('')
  const [seedreamVisualReqKey, setSeedreamVisualReqKey] = useState('high_aes_general_v30l_zt2i')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('')
  const [anthropicModel, setAnthropicModel] = useState('')
  const [judgeBaseUrl, setJudgeBaseUrl] = useState('')
  const [judgeModel, setJudgeModel] = useState('')
  const [codexInput, setCodexInput] = useState('')
  const [codexBaseUrl, setCodexBaseUrl] = useState('')
  const [codexModel, setCodexModel] = useState(DEFAULT_CODEX_MODEL)
  const [googleBaseUrl, setGoogleBaseUrl] = useState('')
  const [googleImageModel, setGoogleImageModel] = useState('')
  const [anthropicCustomEnabled, setAnthropicCustomEnabled] = useState(false)
  const [codexCustomEnabled, setCodexCustomEnabled] = useState(false)
  const [googleCustomEnabled, setGoogleCustomEnabled] = useState(false)
  const [seedreamCustomEnabled, setSeedreamCustomEnabled] = useState(false)
  const [userDataPath, setUserDataPath] = useState<string>('%APPDATA%/ecom-image-agent')
  const [agentMaxRetriesInput, setAgentMaxRetriesInput] = useState(
    String(DEFAULT_AGENT_MAX_RETRIES),
  )
  const [agentScoreThresholdInput, setAgentScoreThresholdInput] = useState(
    String(DEFAULT_AGENT_SCORE_THRESHOLD),
  )
  const [agentEngine, setAgentEngine] = useState<'claude_sdk' | 'codex_sdk' | 'legacy'>(
    DEFAULT_AGENT_ENGINE,
  )
  const [contextRetentionRatioInput, setContextRetentionRatioInput] = useState(
    String(DEFAULT_CONTEXT_RETENTION_RATIO),
  )
  const [contextCompressionSoftInput, setContextCompressionSoftInput] = useState(
    String(DEFAULT_CONTEXT_COMPRESSION_SOFT),
  )
  const [contextCompressionHardInput, setContextCompressionHardInput] = useState(
    String(DEFAULT_CONTEXT_COMPRESSION_HARD),
  )
  const [contextCompressionCriticalInput, setContextCompressionCriticalInput] = useState(
    String(DEFAULT_CONTEXT_COMPRESSION_CRITICAL),
  )
  const [evalTemplateDefaultIdInput, setEvalTemplateDefaultIdInput] = useState('')
  const [evalBackend, setEvalBackend] = useState<EvaluationBackendName>(DEFAULT_EVAL_BACKEND)
  const [vlmevalModelId, setVlmevalModelId] = useState('')
  const [vlmevalUseCustomModel, setVlmevalUseCustomModel] = useState(
    DEFAULT_VLMEVAL_USE_CUSTOM_MODEL,
  )
  const [saving, setSaving] = useState(false)
  const [testingAnthropic, setTestingAnthropic] = useState(false)
  const [fetchingAnthropicModels, setFetchingAnthropicModels] = useState(false)
  const [fetchingJudgeModels, setFetchingJudgeModels] = useState(false)
  const [testingCodex, setTestingCodex] = useState(false)
  const [testingImageProvider, setTestingImageProvider] = useState<ImageProviderName | null>(null)
  const [anthropicModelOptions, setAnthropicModelOptions] = useState<ModelOption[]>([])
  const [judgeModelOptions, setJudgeModelOptions] = useState<ModelOption[]>([])
  const [anthropicTestMessage, setAnthropicTestMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [anthropicModelListMessage, setAnthropicModelListMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [judgeModelListMessage, setJudgeModelListMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [codexTestMessage, setCodexTestMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [imageProviderTestMessage, setImageProviderTestMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [message, setMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)

  const loadSavedConfigs = useCallback(async () => {
    try {
      const [
        anthropicKeyResult,
        judgeKeyResult,
        googleKeyResult,
        seedreamKeyResult,
        seedreamEndpointResult,
        seedreamBaseUrlResult,
        anthropicBaseUrlResult,
        anthropicModelResult,
        judgeBaseUrlResult,
        judgeModelResult,
        codexKeyResult,
        codexBaseUrlResult,
        codexModelResult,
        googleBaseUrlResult,
        googleImageModelResult,
        seedreamCallModeResult,
        seedreamVisualAccessKeyResult,
        seedreamVisualSecretKeyResult,
        seedreamVisualReqKeyResult,
        agentMaxRetriesResult,
        agentScoreThresholdResult,
        agentEngineResult,
        contextRetentionRatioResult,
        contextCompressionSoftResult,
        contextCompressionHardResult,
        contextCompressionCriticalResult,
        evalTemplateDefaultIdResult,
        evalBackendResult,
        vlmevalModelIdResult,
        vlmevalUseCustomModelResult,
      ] = await Promise.all([
        window.api.getConfigValue('ANTHROPIC_API_KEY'),
        window.api.getConfigValue('JUDGE_API_KEY'),
        window.api.getConfigValue('GOOGLE_API_KEY'),
        window.api.getConfigValue('APIKEY_SEEDREAM'),
        window.api.getConfigValue('SEEDREAM_ENDPOINT_ID'),
        window.api.getConfigValue('SEEDREAM_BASE_URL'),
        window.api.getConfigValue('ANTHROPIC_BASE_URL'),
        window.api.getConfigValue('ANTHROPIC_MODEL'),
        window.api.getConfigValue('JUDGE_BASE_URL'),
        window.api.getConfigValue('JUDGE_MODEL'),
        window.api.getConfigValue('CODEX_API_KEY'),
        window.api.getConfigValue('CODEX_BASE_URL'),
        window.api.getConfigValue('CODEX_MODEL'),
        window.api.getConfigValue('GOOGLE_BASE_URL'),
        window.api.getConfigValue('GOOGLE_IMAGE_MODEL'),
        window.api.getConfigValue('SEEDREAM_CALL_MODE'),
        window.api.getConfigValue('SEEDREAM_VISUAL_ACCESS_KEY'),
        window.api.getConfigValue('SEEDREAM_VISUAL_SECRET_KEY'),
        window.api.getConfigValue('SEEDREAM_VISUAL_REQ_KEY'),
        window.api.getConfigValue('AGENT_MAX_RETRIES'),
        window.api.getConfigValue('AGENT_SCORE_THRESHOLD'),
        window.api.getConfigValue('AGENT_ENGINE'),
        window.api.getConfigValue('CONTEXT_RETENTION_RATIO'),
        window.api.getConfigValue('CONTEXT_COMPRESSION_SOFT'),
        window.api.getConfigValue('CONTEXT_COMPRESSION_HARD'),
        window.api.getConfigValue('CONTEXT_COMPRESSION_CRITICAL'),
        window.api.getConfigValue('EVAL_TEMPLATE_DEFAULT_ID'),
        window.api.getConfigValue('EVAL_BACKEND'),
        window.api.getConfigValue('VLMEVAL_MODEL_ID'),
        window.api.getConfigValue('VLMEVAL_USE_CUSTOM_MODEL'),
      ])

      const nextAnthropicKey = anthropicKeyResult.value ?? ''
      const nextJudgeKey = judgeKeyResult.value ?? ''
      const nextGoogleKey = googleKeyResult.value ?? ''
      const nextSeedreamKey = seedreamKeyResult.value ?? ''
      const nextSeedreamEndpointId = seedreamEndpointResult.value ?? ''
      const nextSeedreamBaseUrl = seedreamBaseUrlResult.value ?? ''
      const nextAnthropicBaseUrl = anthropicBaseUrlResult.value ?? ''
      const nextAnthropicModel = anthropicModelResult.value ?? ''
      const nextJudgeBaseUrl = judgeBaseUrlResult.value ?? ''
      const nextJudgeModel = judgeModelResult.value ?? ''
      const nextCodexKey = codexKeyResult.value ?? ''
      const nextCodexBaseUrl = codexBaseUrlResult.value ?? ''
      const nextCodexModel = codexModelResult.value ?? DEFAULT_CODEX_MODEL
      const nextGoogleBaseUrl = googleBaseUrlResult.value ?? ''
      const nextGoogleImageModel = googleImageModelResult.value ?? ''
      const nextSeedreamCallMode =
        (seedreamCallModeResult.value as 'visual_official' | 'openai_compat' | null) ??
        'openai_compat'
      const nextSeedreamVisualAccessKey = seedreamVisualAccessKeyResult.value ?? ''
      const nextSeedreamVisualSecretKey = seedreamVisualSecretKeyResult.value ?? ''
      const nextSeedreamVisualReqKey =
        seedreamVisualReqKeyResult.value ?? 'high_aes_general_v30l_zt2i'
      const nextAgentMaxRetries = normalizeAgentMaxRetries(agentMaxRetriesResult.value)
      const nextAgentScoreThreshold = normalizeAgentScoreThreshold(agentScoreThresholdResult.value)
      const nextAgentEngine =
        (agentEngineResult.value as 'claude_sdk' | 'codex_sdk' | 'legacy' | null) ??
        DEFAULT_AGENT_ENGINE
      const nextContextRetentionRatio = normalizeContextRetentionRatio(
        contextRetentionRatioResult.value,
      )
      const nextContextCompressionSoft = normalizeContextCompressionThreshold(
        contextCompressionSoftResult.value,
        DEFAULT_CONTEXT_COMPRESSION_SOFT,
      )
      const nextContextCompressionHard = normalizeContextCompressionThreshold(
        contextCompressionHardResult.value,
        DEFAULT_CONTEXT_COMPRESSION_HARD,
      )
      const nextContextCompressionCritical = normalizeContextCompressionThreshold(
        contextCompressionCriticalResult.value,
        DEFAULT_CONTEXT_COMPRESSION_CRITICAL,
      )
      const nextEvalTemplateDefaultId = evalTemplateDefaultIdResult.value ?? ''
      const nextEvalBackend = normalizeEvaluationBackend(evalBackendResult.value)
      const nextVlmevalModelId = vlmevalModelIdResult.value ?? ''
      const nextVlmevalUseCustomModel = normalizeBooleanConfig(
        vlmevalUseCustomModelResult.value,
        DEFAULT_VLMEVAL_USE_CUSTOM_MODEL,
      )

      setAnthropicInput(nextAnthropicKey)
      setJudgeInput(nextJudgeKey)
      setGoogleInput(nextGoogleKey)
      setSeedreamInput(nextSeedreamKey)
      setSeedreamEndpointId(nextSeedreamEndpointId)
      setSeedreamBaseUrl(nextSeedreamBaseUrl)
      setAnthropicBaseUrl(nextAnthropicBaseUrl)
      setAnthropicModel(nextAnthropicModel)
      setJudgeBaseUrl(nextJudgeBaseUrl)
      setJudgeModel(nextJudgeModel)
      setCodexInput(nextCodexKey)
      setCodexBaseUrl(nextCodexBaseUrl)
      setCodexModel(nextCodexModel)
      setGoogleBaseUrl(nextGoogleBaseUrl)
      setGoogleImageModel(nextGoogleImageModel)
      setSeedreamCallMode(nextSeedreamCallMode)
      setSeedreamVisualAccessKey(nextSeedreamVisualAccessKey)
      setSeedreamVisualSecretKey(nextSeedreamVisualSecretKey)
      setSeedreamVisualReqKey(nextSeedreamVisualReqKey)
      setAgentMaxRetriesInput(nextAgentMaxRetries)
      setAgentScoreThresholdInput(nextAgentScoreThreshold)
      setAgentEngine(nextAgentEngine)
      setContextRetentionRatioInput(nextContextRetentionRatio)
      setContextCompressionSoftInput(nextContextCompressionSoft)
      setContextCompressionHardInput(nextContextCompressionHard)
      setContextCompressionCriticalInput(nextContextCompressionCritical)
      setEvalTemplateDefaultIdInput(nextEvalTemplateDefaultId)
      setEvalBackend(nextEvalBackend)
      setVlmevalModelId(nextVlmevalModelId)
      setVlmevalUseCustomModel(nextVlmevalUseCustomModel)
      setAnthropicCustomEnabled(Boolean(nextAnthropicBaseUrl || nextAnthropicModel))
      setCodexCustomEnabled(Boolean((codexBaseUrlResult.value ?? '') || (codexModelResult.value ?? '')))
      setGoogleCustomEnabled(Boolean(nextGoogleBaseUrl || nextGoogleImageModel))
      setSeedreamCustomEnabled(Boolean(nextSeedreamBaseUrl || nextSeedreamEndpointId))
    } catch (error) {
      console.error('[Settings] loadSavedConfigs failed:', error)
    }
  }, [])

  useEffect(() => {
    void checkKeys()
    void loadSavedConfigs()
  }, [checkKeys, loadSavedConfigs])

  useEffect(() => {
    window.api
      .getUserDataPath()
      .then((result) => {
        setUserDataPath(result.path)
      })
      .catch((error) => {
        console.error('[Settings] getUserDataPath failed:', error)
      })
  }, [])

  useEffect(() => {
    setAnthropicModelOptions([])
    setAnthropicModelListMessage(null)
  }, [anthropicBaseUrl, anthropicInput])

  useEffect(() => {
    setJudgeModelOptions([])
    setJudgeModelListMessage(null)
  }, [judgeBaseUrl, judgeInput])

  const handleSave = useCallback(
    async (key: string, value: string, label: string) => {
      const trimmedValue = value.trim()
      if (!trimmedValue) return
      setSaving(true)
      setMessage(null)
      const ok = await saveKey(key, trimmedValue)
      setSaving(false)
      if (ok) {
        setMessage({ type: 'success', text: `${label} 已保存` })
        if (key === 'ANTHROPIC_API_KEY') setAnthropicInput(trimmedValue)
        if (key === 'JUDGE_API_KEY') setJudgeInput(trimmedValue)
        if (key === 'CODEX_API_KEY') setCodexInput(trimmedValue)
        if (key === 'GOOGLE_API_KEY') setGoogleInput(trimmedValue)
        if (key === 'APIKEY_SEEDREAM') setSeedreamInput(trimmedValue)
      } else {
        setMessage({ type: 'error', text: `${label} 保存失败` })
      }
    },
    [saveKey],
  )

  const handleSaveAgentMaxRetries = useCallback(async () => {
    const parsed = parseAgentMaxRetriesInput(agentMaxRetriesInput)
    if (parsed === null) {
      setMessage({
        type: 'error',
        text: `重试轮次必须是 ${MIN_AGENT_MAX_RETRIES}~${MAX_AGENT_MAX_RETRIES} 的整数`,
      })
      return
    }
    setAgentMaxRetriesInput(String(parsed))
    await handleSave('AGENT_MAX_RETRIES', String(parsed), 'Agent 重试轮次')
  }, [agentMaxRetriesInput, handleSave])

  const handleSaveAgentScoreThreshold = useCallback(async () => {
    const parsed = parseAgentScoreThresholdInput(agentScoreThresholdInput)
    if (parsed === null) {
      setMessage({
        type: 'error',
        text: `评分阈值必须是 ${MIN_AGENT_SCORE_THRESHOLD}~${MAX_AGENT_SCORE_THRESHOLD} 的整数`,
      })
      return
    }
    setAgentScoreThresholdInput(String(parsed))
    await handleSave('AGENT_SCORE_THRESHOLD', String(parsed), 'Agent 评分阈值')
  }, [agentScoreThresholdInput, handleSave])

  const handleSaveAgentEngine = useCallback(async () => {
    await handleSave('AGENT_ENGINE', agentEngine, 'Agent 引擎')
  }, [agentEngine, handleSave])

  const handleSaveContextRetentionRatio = useCallback(async () => {
    const parsed = parseContextRetentionRatioInput(contextRetentionRatioInput)
    if (parsed === null) {
      setMessage({
        type: 'error',
        text: `上下文保留比例必须在 ${MIN_CONTEXT_RETENTION_RATIO}~${MAX_CONTEXT_RETENTION_RATIO}`,
      })
      return
    }
    const normalized = parsed.toFixed(2)
    setContextRetentionRatioInput(normalized)
    await handleSave('CONTEXT_RETENTION_RATIO', normalized, '上下文保留比例')
  }, [contextRetentionRatioInput, handleSave])

  const handleSaveContextCompressionThresholds = useCallback(async () => {
    const soft = parseContextCompressionThresholdInput(contextCompressionSoftInput)
    const hard = parseContextCompressionThresholdInput(contextCompressionHardInput)
    const critical = parseContextCompressionThresholdInput(contextCompressionCriticalInput)
    if (soft === null || hard === null || critical === null) {
      setMessage({
        type: 'error',
        text: '压缩阈值必须是 1~99 的整数',
      })
      return
    }
    if (!(soft < hard && hard < critical)) {
      setMessage({
        type: 'error',
        text: '阈值需满足 soft < hard < critical',
      })
      return
    }

    setContextCompressionSoftInput(String(soft))
    setContextCompressionHardInput(String(hard))
    setContextCompressionCriticalInput(String(critical))
    setSaving(true)
    setMessage(null)
    try {
      const results = await Promise.all([
        saveKey('CONTEXT_COMPRESSION_SOFT', String(soft)),
        saveKey('CONTEXT_COMPRESSION_HARD', String(hard)),
        saveKey('CONTEXT_COMPRESSION_CRITICAL', String(critical)),
      ])
      if (results.every(Boolean)) {
        setMessage({ type: 'success', text: '上下文压缩阈值 已保存' })
      } else {
        setMessage({ type: 'error', text: '上下文压缩阈值 保存失败' })
      }
    } finally {
      setSaving(false)
    }
  }, [
    contextCompressionSoftInput,
    contextCompressionHardInput,
    contextCompressionCriticalInput,
    saveKey,
  ])

  const handleSaveEvalTemplateDefaultId = useCallback(async () => {
    const trimmed = evalTemplateDefaultIdInput.trim()
    if (!trimmed) {
      setMessage({
        type: 'error',
        text: '默认评估模板 ID 不能为空（可在模板页查看）',
      })
      return
    }
    if (!/^\\d+$/.test(trimmed)) {
      setMessage({
        type: 'error',
        text: '默认评估模板 ID 必须是正整数',
      })
      return
    }
    await handleSave('EVAL_TEMPLATE_DEFAULT_ID', trimmed, '默认评估模板 ID')
  }, [evalTemplateDefaultIdInput, handleSave])

  const handleSaveCustom = useCallback(
    async (
      values: Array<{ key: string; value: string }>,
      label: string,
      onSuccess?: () => void,
    ) => {
      setSaving(true)
      setMessage(null)
      try {
        const results = await Promise.all(
          values.map(({ key, value }) => saveKey(key, value.trim())),
        )
        const ok = results.every(Boolean)
        if (ok) {
          setMessage({ type: 'success', text: `${label} 已保存` })
          onSuccess?.()
        } else {
          setMessage({ type: 'error', text: `${label} 保存失败` })
        }
      } finally {
        setSaving(false)
      }
    },
    [saveKey],
  )

  const handleSaveEvalBackend = useCallback(async () => {
    await handleSave('EVAL_BACKEND', evalBackend, '视觉评估后端')
  }, [evalBackend, handleSave])

  const handleSaveVLMEvalConfig = useCallback(async () => {
    const trimmedModelId = vlmevalModelId.trim()
    setVlmevalModelId(trimmedModelId)
    await handleSaveCustom(
      [
        { key: 'VLMEVAL_MODEL_ID', value: trimmedModelId },
        { key: 'VLMEVAL_USE_CUSTOM_MODEL', value: String(vlmevalUseCustomModel) },
      ],
      'VLMEvalKit 配置',
    )
  }, [handleSaveCustom, vlmevalModelId, vlmevalUseCustomModel])

  const handleSaveJudgeConfig = useCallback(async () => {
    const trimmedApiKey = judgeInput.trim()
    const trimmedBaseUrl = judgeBaseUrl.trim()
    const trimmedModel = judgeModel.trim()
    setJudgeInput(trimmedApiKey)
    setJudgeBaseUrl(trimmedBaseUrl)
    setJudgeModel(trimmedModel)
    await handleSaveCustom(
      [
        { key: 'JUDGE_API_KEY', value: trimmedApiKey },
        { key: 'JUDGE_BASE_URL', value: trimmedBaseUrl },
        { key: 'JUDGE_MODEL', value: trimmedModel },
      ],
      'Judge 配置',
    )
  }, [handleSaveCustom, judgeBaseUrl, judgeInput, judgeModel])

  const showAgentModelWarning =
    agentEngine === 'claude_sdk' && isLikelyNonClaudeModel(anthropicModel)

  const handleProviderChange = useCallback(
    async (provider: ImageProviderName) => {
      setSaving(true)
      setMessage(null)
      const ok = await setActiveProvider(provider)
      setSaving(false)
      if (ok) {
        setMessage({ type: 'success', text: `已切换到 ${provider === 'gemini' ? 'Google Gemini' : '即梦 Seedream'}` })
      } else {
        setMessage({ type: 'error', text: '切换服务商失败' })
      }
    },
    [setActiveProvider],
  )

  const providerKeyStatus = (provider: ImageProviderName): boolean => {
    if (provider === 'gemini') return hasGoogleKey
    if (provider === 'seedream') return hasSeedreamKey
    return false
  }

  const handleTestAnthropicConnection = useCallback(async () => {
    if (!anthropicInput.trim()) {
      const nextMessage = { type: 'error' as const, text: '请先输入 Anthropic API Key 再测试连接' }
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
      return
    }

    setTestingAnthropic(true)
    setAnthropicTestMessage(null)
    setMessage(null)
    try {
      const result = await window.api.testAnthropicConnection({
        apiKey: anthropicInput,
        baseUrl: anthropicBaseUrl,
        model: anthropicModel,
      })
      const nextMessage = {
        type: result.success ? 'success' : 'error',
        text: result.success
          ? `Anthropic 连接测试成功（模型: ${anthropicModel.trim() || 'claude-sonnet-4-20250514'}）`
          : `Anthropic 连接测试失败：${result.message}`,
      } as const
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const nextMessage = { type: 'error' as const, text: `Anthropic 连接测试失败：${text}` }
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
    } finally {
      setTestingAnthropic(false)
    }
  }, [anthropicInput, anthropicBaseUrl, anthropicModel])

  const handleFetchAnthropicModels = useCallback(async () => {
    if (!anthropicInput.trim()) {
      const nextMessage = { type: 'error' as const, text: '请先输入 Anthropic API Key 再获取模型列表' }
      setAnthropicModelListMessage(nextMessage)
      setMessage(nextMessage)
      return
    }

    setFetchingAnthropicModels(true)
    setAnthropicModelOptions([])
    setAnthropicModelListMessage(null)
    setMessage(null)
    try {
      const result = await window.api.fetchAnthropicModels({
        apiKey: anthropicInput,
        baseUrl: anthropicBaseUrl,
      })
      const nextMessage = {
        type: result.success ? 'success' : 'error',
        text: result.success
          ? `${result.message}，请从下拉框选择或继续手动填写模型`
          : `获取模型列表失败：${result.message}`,
      } as const

      if (result.success) {
        setAnthropicModelOptions(result.models)
        if (!anthropicModel.trim() && result.models[0]?.id) {
          setAnthropicModel(result.models[0].id)
        }
      }

      setAnthropicModelListMessage(nextMessage)
      setMessage(nextMessage)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const nextMessage = { type: 'error' as const, text: `获取模型列表失败：${text}` }
      setAnthropicModelListMessage(nextMessage)
      setMessage(nextMessage)
    } finally {
      setFetchingAnthropicModels(false)
    }
  }, [anthropicBaseUrl, anthropicInput, anthropicModel])

  const handleFetchJudgeModels = useCallback(async () => {
    const effectiveApiKey = judgeInput.trim() || anthropicInput.trim()
    const effectiveBaseUrl = judgeBaseUrl.trim() || anthropicBaseUrl.trim()

    if (!effectiveApiKey) {
      const nextMessage = {
        type: 'error' as const,
        text: '请先输入 Judge API Key；若未单独配置，也可先保留 Agent Anthropic Key 作为回退。',
      }
      setJudgeModelListMessage(nextMessage)
      setMessage(nextMessage)
      return
    }

    setFetchingJudgeModels(true)
    setJudgeModelOptions([])
    setJudgeModelListMessage(null)
    setMessage(null)
    try {
      const result = await window.api.fetchJudgeModels({
        apiKey: effectiveApiKey,
        baseUrl: effectiveBaseUrl || undefined,
      })
      const nextMessage = {
        type: result.success ? 'success' : 'error',
        text: result.success
          ? `${result.message}，请从下拉框选择或继续手动填写模型`
          : `获取 Judge 模型列表失败：${result.message}`,
      } as const

      if (result.success) {
        setJudgeModelOptions(result.models)
        if (!judgeModel.trim() && result.models[0]?.id) {
          setJudgeModel(result.models[0].id)
        }
      }

      setJudgeModelListMessage(nextMessage)
      setMessage(nextMessage)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const nextMessage = { type: 'error' as const, text: `获取 Judge 模型列表失败：${text}` }
      setJudgeModelListMessage(nextMessage)
      setMessage(nextMessage)
    } finally {
      setFetchingJudgeModels(false)
    }
  }, [anthropicBaseUrl, anthropicInput, judgeBaseUrl, judgeInput, judgeModel])

  const buildCodexTroubleshootingHint = useCallback((raw: string): string => {
    const commonHint =
      '建议：检查代理网关可用性、确认模型可用；如在使用自定义 Base URL，可先清空该项并用官方地址重试。'
    if (/status\s*502|bad gateway|upstream request failed/i.test(raw)) {
      return `${raw} ${commonHint}`
    }
    return `${raw} 建议：确认 API Key/Base URL/模型配置后重试。`
  }, [])

  const handleTestCodexConnection = useCallback(async () => {
    if (!codexInput.trim()) {
      const nextMessage = { type: 'error' as const, text: '请先输入 Codex API Key 后再测试。' }
      setCodexTestMessage(nextMessage)
      setMessage(nextMessage)
      return
    }

    setTestingCodex(true)
    setCodexTestMessage(null)
    setMessage(null)
    try {
      const result = await window.api.testCodexConnection({
        apiKey: codexInput,
        baseUrl: codexBaseUrl,
        model: codexModel,
      })
      const nextMessage = {
        type: result.success ? 'success' : 'error',
        text: result.success
          ? `Codex 连接测试成功（模型：${codexModel.trim() || DEFAULT_CODEX_MODEL}）`
          : `Codex 连接测试失败：${buildCodexTroubleshootingHint(result.message)}`,
      } as const
      setCodexTestMessage(nextMessage)
      setMessage(nextMessage)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const nextMessage = {
        type: 'error' as const,
        text: `Codex 连接测试失败：${buildCodexTroubleshootingHint(text)}`,
      }
      setCodexTestMessage(nextMessage)
      setMessage(nextMessage)
    } finally {
      setTestingCodex(false)
    }
  }, [buildCodexTroubleshootingHint, codexInput, codexBaseUrl, codexModel])

  const handleTestImageProviderConnection = useCallback(
    async (provider: ImageProviderName) => {
      if (typeof window.api.testImageProviderConnection !== 'function') {
        const nextMessage = {
          type: 'error' as const,
          text: '当前应用未加载最新测试接口，请重启桌面应用后重试',
        }
        setImageProviderTestMessage(nextMessage)
        setMessage(nextMessage)
        return
      }

      setTestingImageProvider(provider)
      setImageProviderTestMessage(null)
      setMessage(null)
      try {
        const result = await window.api.testImageProviderConnection({
          provider,
          apiKey: provider === 'gemini' ? googleInput : seedreamInput,
          baseUrl: provider === 'gemini' ? googleBaseUrl : seedreamBaseUrl,
          model: provider === 'gemini' ? googleImageModel : undefined,
          endpointId: provider === 'seedream' ? seedreamEndpointId : undefined,
          callMode: provider === 'seedream' ? seedreamCallMode : undefined,
          accessKeyId: provider === 'seedream' ? seedreamVisualAccessKey : undefined,
          secretAccessKey: provider === 'seedream' ? seedreamVisualSecretKey : undefined,
          reqKey: provider === 'seedream' ? seedreamVisualReqKey : undefined,
        })
        const elapsed = result.durationMs ? `，耗时 ${result.durationMs}ms` : ''
        const nextMessage = {
          type: result.success ? 'success' : 'error',
          text: result.success
            ? `${result.message}${elapsed}`
            : `${provider === 'gemini' ? 'Google Gemini' : 'Seedream'} 图像测试失败：${result.message}${elapsed}`,
        } as const
        setImageProviderTestMessage(nextMessage)
        setMessage(nextMessage)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        const nextMessage = {
          type: 'error' as const,
          text: `${provider === 'gemini' ? 'Google Gemini' : 'Seedream'} 图像测试失败：${text}`,
        }
        setImageProviderTestMessage(nextMessage)
        setMessage(nextMessage)
      } finally {
        setTestingImageProvider(null)
      }
    },
    [
      googleBaseUrl,
      googleImageModel,
      googleInput,
      seedreamBaseUrl,
      seedreamCallMode,
      seedreamEndpointId,
      seedreamInput,
      seedreamVisualAccessKey,
      seedreamVisualReqKey,
      seedreamVisualSecretKey,
    ],
  )

  return (
    <div className="flex-1 p-6 space-y-8 overflow-y-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-100">设置</h1>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
              : 'bg-red-500/10 text-red-400 border border-red-500/30'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Image Provider Selection */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">图像生成服务</h2>
        <p className="text-sm text-gray-400">
          选择用于生成电商精品图的 AI 服务商。切换后新任务将使用所选服务商。
        </p>

        <div className="space-y-3">
          {/* Gemini */}
          <div
            className={`bg-gray-800/50 border rounded-xl p-4 space-y-3 cursor-pointer transition-colors ${
              activeProvider === 'gemini'
                ? 'border-blue-500/50'
                : 'border-gray-700/50 hover:border-gray-600/50'
            }`}
            onClick={() => handleProviderChange('gemini')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  activeProvider === 'gemini' ? 'border-blue-500' : 'border-gray-600'
                }`}>
                  {activeProvider === 'gemini' && (
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200">Google Gemini</h3>
                  <p className="text-xs text-gray-500 mt-0.5">gemini-2.0-flash-preview-image-generation</p>
                </div>
              </div>
              {isChecking ? (
                <span className="text-xs text-gray-500">检查中...</span>
              ) : hasGoogleKey ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                  已配置
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                  未配置
                </span>
              )}
            </div>

            {activeProvider === 'gemini' && (
              <div className="space-y-3 pt-2 border-t border-gray-700/50" onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={googleInput}
                    onChange={(e) => setGoogleInput(e.target.value)}
                    placeholder="AIza..."
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <button
                    onClick={() => handleSave('GOOGLE_API_KEY', googleInput, 'Google Key')}
                    disabled={!googleInput.trim() || saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => handleTestImageProviderConnection('gemini')}
                    disabled={testingImageProvider !== null || saving}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    {testingImageProvider === 'gemini' ? '测试中...' : '测试连接'}
                  </button>
                </div>

                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={googleCustomEnabled}
                    onChange={(e) => setGoogleCustomEnabled(e.target.checked)}
                  />
                  自定义配置
                </label>

                {googleCustomEnabled && (
                  <>
                    <input
                      value={googleBaseUrl}
                      onChange={(e) => setGoogleBaseUrl(e.target.value)}
                      placeholder="自定义 Base URL（可留空回退官方）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <input
                      value={googleImageModel}
                      onChange={(e) => setGoogleImageModel(e.target.value)}
                      placeholder="图像模型（如 gemini-2.0-flash-preview-image-generation）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <div className="flex justify-end">
                      <button
                        onClick={() =>
                          handleSaveCustom(
                            [
                              { key: 'GOOGLE_BASE_URL', value: googleBaseUrl },
                              { key: 'GOOGLE_IMAGE_MODEL', value: googleImageModel },
                            ],
                            'Google 自定义配置',
                          )
                        }
                        disabled={saving}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                      >
                        保存自定义配置
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Seedream */}
          <div
            className={`bg-gray-800/50 border rounded-xl p-4 space-y-3 cursor-pointer transition-colors ${
              activeProvider === 'seedream'
                ? 'border-blue-500/50'
                : 'border-gray-700/50 hover:border-gray-600/50'
            }`}
            onClick={() => handleProviderChange('seedream')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  activeProvider === 'seedream' ? 'border-blue-500' : 'border-gray-600'
                }`}>
                  {activeProvider === 'seedream' && (
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200">字节即梦 Seedream 3.0</h3>
                  <p className="text-xs text-gray-500 mt-0.5">火山方舟 doubao-seedream-3-0-t2i</p>
                </div>
              </div>
              {isChecking ? (
                <span className="text-xs text-gray-500">检查中...</span>
              ) : hasSeedreamKey ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                  已配置
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                  未配置
                </span>
              )}
            </div>

            {activeProvider === 'seedream' && (
              <div className="space-y-3 pt-2 border-t border-gray-700/50" onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={seedreamInput}
                    onChange={(e) => setSeedreamInput(e.target.value)}
                    placeholder="火山方舟 API Key"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <button
                    onClick={() => handleSave('APIKEY_SEEDREAM', seedreamInput, 'Seedream Key')}
                    disabled={!seedreamInput.trim() || saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => handleTestImageProviderConnection('seedream')}
                    disabled={testingImageProvider !== null || saving}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    {testingImageProvider === 'seedream' ? '测试中...' : '测试连接'}
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={seedreamCustomEnabled}
                    onChange={(e) => setSeedreamCustomEnabled(e.target.checked)}
                  />
                  使用自定义 Seedream API 配置
                </label>

                {seedreamCustomEnabled && (
                  <>
                    <label className="text-xs text-gray-400">调用模式</label>
                    <select
                      value={seedreamCallMode}
                      onChange={(e) => setSeedreamCallMode(e.target.value as 'visual_official' | 'openai_compat')}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="visual_official">官方 Visual 接口（推荐）</option>
                      <option value="openai_compat">OpenAI 兼容接口</option>
                    </select>
                    <input
                      value={seedreamBaseUrl}
                      onChange={(e) => setSeedreamBaseUrl(e.target.value)}
                      placeholder="自定义 Base URL（可留空回退官方）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <input
                      value={seedreamEndpointId}
                      onChange={(e) => setSeedreamEndpointId(e.target.value)}
                      placeholder="模型 Endpoint ID（可选，留空使用默认）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    {seedreamCallMode === 'visual_official' && (
                      <>
                        <input
                          value={seedreamVisualAccessKey}
                          onChange={(e) => setSeedreamVisualAccessKey(e.target.value)}
                          placeholder="Visual AccessKey ID（AK）"
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                        />
                        <input
                          type="password"
                          value={seedreamVisualSecretKey}
                          onChange={(e) => setSeedreamVisualSecretKey(e.target.value)}
                          placeholder="Visual SecretAccessKey（SK）"
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                        />
                        <input
                          value={seedreamVisualReqKey}
                          onChange={(e) => setSeedreamVisualReqKey(e.target.value)}
                          placeholder="Visual req_key（默认 high_aes_general_v30l_zt2i）"
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                        />
                      </>
                    )}
                  </>
                )}

                {(seedreamEndpointId.trim() ||
                  seedreamBaseUrl.trim() ||
                  seedreamCallMode === 'visual_official' ||
                  seedreamCallMode === 'openai_compat') && (
                  <div className="flex justify-end">
                    <button
                      onClick={() =>
                        handleSaveCustom(
                          [
                            { key: 'SEEDREAM_BASE_URL', value: seedreamBaseUrl },
                            { key: 'SEEDREAM_ENDPOINT_ID', value: seedreamEndpointId },
                            { key: 'SEEDREAM_CALL_MODE', value: seedreamCallMode },
                            { key: 'SEEDREAM_VISUAL_ACCESS_KEY', value: seedreamVisualAccessKey },
                            { key: 'SEEDREAM_VISUAL_SECRET_KEY', value: seedreamVisualSecretKey },
                            { key: 'SEEDREAM_VISUAL_REQ_KEY', value: seedreamVisualReqKey },
                          ],
                          'Seedream 自定义配置',
                        )
                      }
                      disabled={saving}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                    >
                      保存自定义配置
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {imageProviderTestMessage && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              imageProviderTestMessage.type === 'success'
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'bg-red-500/10 text-red-400 border border-red-500/30'
            }`}
          >
            {imageProviderTestMessage.text}
          </div>
        )}

        {!providerKeyStatus(activeProvider) && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            当前选择的服务商尚未配置 API Key，请在上方输入并保存。
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">API 密钥</h2>
        <p className="text-sm text-gray-400">
          密钥通过 Electron safeStorage 加密存储在本地数据库中，不会写入任何文件。
        </p>

        {/* Anthropic */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200">
                Agent 编排（Claude SDK / Anthropic-compatible）
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                仅用于 Claude SDK 编排、Anthropic draft fallback 和评估模板 AI 草稿，不用于 `evaluate_image` Judge。
              </p>
            </div>
            {isChecking ? (
              <span className="text-xs text-gray-500">检查中...</span>
            ) : hasAnthropicKey ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                已配置
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                未配置
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={anthropicInput}
              onChange={(e) => setAnthropicInput(e.target.value)}
              placeholder="sk-ant-..."
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={() =>
                handleSave('ANTHROPIC_API_KEY', anthropicInput, 'Anthropic Key')
              }
              disabled={!anthropicInput.trim() || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
            <button
              onClick={handleTestAnthropicConnection}
              disabled={testingAnthropic || saving}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              {testingAnthropic ? '测试中...' : '测试连接'}
            </button>
          </div>
          {anthropicTestMessage && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                anthropicTestMessage.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-red-500/10 text-red-400 border border-red-500/30'
              }`}
            >
              {anthropicTestMessage.text}
            </div>
          )}

          <div className="pt-2 border-t border-gray-700/50 space-y-3">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={anthropicCustomEnabled}
                onChange={(e) => setAnthropicCustomEnabled(e.target.checked)}
              />
              使用自定义 Anthropic API 配置
            </label>

            {anthropicCustomEnabled && (
              <>
                <div className="flex gap-2">
                  <input
                    value={anthropicBaseUrl}
                    onChange={(e) => setAnthropicBaseUrl(e.target.value)}
                    placeholder="自定义 Base URL（可留空回退官方）"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <button
                    type="button"
                    data-testid="settings-anthropic-fetch-models-button"
                    onClick={handleFetchAnthropicModels}
                    disabled={fetchingAnthropicModels || saving}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors whitespace-nowrap"
                  >
                    {fetchingAnthropicModels ? '获取中...' : '获取模型列表'}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={anthropicModel}
                    onChange={(e) => setAnthropicModel(e.target.value)}
                    placeholder="自定义模型（如 claude-sonnet-4-20250514）"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <select
                    data-testid="settings-anthropic-model-select"
                    value={
                      anthropicModelOptions.some((option) => option.id === anthropicModel)
                        ? anthropicModel
                        : ''
                    }
                    onChange={(e) => setAnthropicModel(e.target.value)}
                    disabled={anthropicModelOptions.length === 0 || fetchingAnthropicModels}
                    className="w-72 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">
                      {anthropicModelOptions.length > 0 ? '从已获取列表中选择模型' : '先获取模型列表'}
                    </option>
                    {anthropicModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.displayName} ({option.id})
                      </option>
                    ))}
                  </select>
                </div>
                {anthropicModelListMessage && (
                  <div
                    className={`rounded-lg px-3 py-2 text-xs ${
                      anthropicModelListMessage.type === 'success'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        : 'bg-red-500/10 text-red-400 border border-red-500/30'
                    }`}
                  >
                    {anthropicModelListMessage.text}
                  </div>
                )}
                <div className="flex justify-end">
                  <button
                    onClick={() =>
                      handleSaveCustom(
                        [
                          { key: 'ANTHROPIC_BASE_URL', value: anthropicBaseUrl },
                          { key: 'ANTHROPIC_MODEL', value: anthropicModel },
                        ],
                        'Anthropic 自定义配置',
                      )
                    }
                    disabled={saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存自定义配置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {showAgentModelWarning && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            当前 `AGENT_ENGINE=claude_sdk`，但 Agent 模型看起来不是 Claude 系列。像 GLM、Qwen、Gemini 这类多模态 Judge 模型更建议填写到下方“视觉评测 Judge”区域，避免影响 Claude SDK 编排。
          </div>
        )}

        {/* Codex */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200">Codex API 密钥</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                用于 `codex_sdk` 的 Agent 编排，视觉评审仍使用 Anthropic。
              </p>
            </div>
            {codexInput.trim() ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                已配置
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                未配置
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={codexInput}
              onChange={(e) => setCodexInput(e.target.value)}
              placeholder="请输入 codex-api-key"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={() =>
                handleSave('CODEX_API_KEY', codexInput, 'Codex 密钥')
              }
              disabled={!codexInput.trim() || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
            <button
              onClick={handleTestCodexConnection}
              disabled={testingCodex || saving}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              {testingCodex ? '测试中...' : '测试连接'}
            </button>
          </div>
          {codexTestMessage && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                codexTestMessage.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-red-500/10 text-red-400 border border-red-500/30'
              }`}
            >
              {codexTestMessage.text}
            </div>
          )}

          <div className="pt-2 border-t border-gray-700/50 space-y-3">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={codexCustomEnabled}
                onChange={(e) => setCodexCustomEnabled(e.target.checked)}
              />
              使用自定义 Codex API 配置
            </label>

            {codexCustomEnabled && (
              <>
                <input
                  value={codexBaseUrl}
                  onChange={(e) => setCodexBaseUrl(e.target.value)}
                  placeholder="自定义 Base URL（可选）"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                />
                <input
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  placeholder={DEFAULT_CODEX_MODEL}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                />
                <div className="flex justify-end">
                  <button
                    onClick={() =>
                      handleSaveCustom(
                        [
                          { key: 'CODEX_BASE_URL', value: codexBaseUrl },
                          { key: 'CODEX_MODEL', value: codexModel },
                        ],
                        'Codex 自定义配置',
                      )
                    }
                    disabled={saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存自定义配置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">视觉评估</h2>
        <p className="text-sm text-gray-400">
          配置在线图片评测后端。默认使用当前自定义 judge；切换到 VLMEvalKit 后，可复用其多模态评测抽象能力。
        </p>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">评测后端</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              `custom_anthropic` 更贴近现有线上逻辑，`vlmevalkit` 适合做统一多模态评测适配层。
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <select
              data-testid="settings-eval-backend-select"
              value={evalBackend}
              onChange={(e) => setEvalBackend(e.target.value as EvaluationBackendName)}
              className="w-56 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="custom_anthropic">custom_anthropic</option>
              <option value="vlmevalkit">vlmevalkit</option>
            </select>
            <button
              onClick={handleSaveEvalBackend}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存后端
            </button>
          </div>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">视觉评测 Judge（Anthropic-compatible）</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              仅用于 `evaluate_image`。若留空，运行时会自动回退到 Agent 侧 `ANTHROPIC_*` 配置。
            </p>
          </div>
          <div className="flex gap-2">
            <input
              data-testid="settings-judge-api-key-input"
              type="text"
              value={judgeInput}
              onChange={(e) => setJudgeInput(e.target.value)}
              placeholder="Judge API Key（可留空走回退）"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={() => handleSave('JUDGE_API_KEY', judgeInput, 'Judge API Key')}
              disabled={!judgeInput.trim() || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
          <div className="flex gap-2">
            <input
              data-testid="settings-judge-base-url-input"
              value={judgeBaseUrl}
              onChange={(e) => setJudgeBaseUrl(e.target.value)}
              placeholder="Judge Base URL（如 https://cloud.infini-ai.com/maas/coding）"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              type="button"
              data-testid="settings-judge-fetch-models-button"
              onClick={handleFetchJudgeModels}
              disabled={fetchingJudgeModels || saving}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors whitespace-nowrap"
            >
              {fetchingJudgeModels ? '获取中...' : '获取模型列表'}
            </button>
          </div>
          <div className="flex gap-2">
            <input
              data-testid="settings-judge-model-input"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              placeholder="Judge 模型（如 glm-4v-plus-0111）"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <select
              data-testid="settings-judge-model-select"
              value={judgeModelOptions.some((option) => option.id === judgeModel) ? judgeModel : ''}
              onChange={(e) => setJudgeModel(e.target.value)}
              disabled={judgeModelOptions.length === 0 || fetchingJudgeModels}
              className="w-72 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">
                {judgeModelOptions.length > 0 ? '从已获取列表中选择 Judge 模型' : '先获取模型列表'}
              </option>
              {judgeModelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName} ({option.id})
                </option>
              ))}
            </select>
          </div>
          {judgeModelListMessage && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                judgeModelListMessage.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-red-500/10 text-red-400 border border-red-500/30'
              }`}
            >
              {judgeModelListMessage.text}
            </div>
          )}
          <div className="rounded-lg border border-gray-700/50 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
            推荐把 `glm-4v-plus-0111`、`qwen-vl-max` 这类视觉 Judge 模型配置在这里，而不是填到 Agent Anthropic 模型里。
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleSaveJudgeConfig}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存 Judge 配置
            </button>
          </div>
        </div>

        {evalBackend === 'vlmevalkit' && (
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
            <div>
              <h3 className="text-sm font-medium text-gray-200">VLMEvalKit 配置</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                首版用于在线单图评测。关闭自定义 model adapter 后，需确保所填模型是 VLMEvalKit 已注册且支持视觉输入的模型。
              </p>
            </div>
            <input
              data-testid="settings-vlmeval-model-id-input"
              value={vlmevalModelId}
              onChange={(e) => setVlmevalModelId(e.target.value)}
              placeholder="如 claude-sonnet-4-20250514 或 qwen2.5-vl-72b-instruct"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                data-testid="settings-vlmeval-use-custom-model-checkbox"
                type="checkbox"
                checked={vlmevalUseCustomModel}
                onChange={(e) => setVlmevalUseCustomModel(e.target.checked)}
              />
              优先使用项目内置自定义 model adapter
            </label>
            <div className="rounded-lg border border-gray-700/50 bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
              使用内置 adapter 时，会优先复用当前 Judge 配置；若 Judge 未单独配置，再回退到 `ANTHROPIC_*`。关闭后将尝试按 `VLMEVAL_MODEL_ID` 直接走 VLMEvalKit 模型注册表。
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleSaveVLMEvalConfig}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
              >
                保存 VLMEvalKit 配置
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">Agent 循环</h2>
        <p className="text-sm text-gray-400">
          配置质量评估未达标时的自动重试策略。
        </p>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">最大重试轮次</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              不包含首轮生成。比如设置为 3，则最多会尝试 4 轮（首轮 + 3 次重试）。
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              min={MIN_AGENT_MAX_RETRIES}
              max={MAX_AGENT_MAX_RETRIES}
              step={1}
              value={agentMaxRetriesInput}
              onChange={(e) => setAgentMaxRetriesInput(e.target.value)}
              placeholder={String(DEFAULT_AGENT_MAX_RETRIES)}
              className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={handleSaveAgentMaxRetries}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
          <p className="text-xs text-gray-500">
            允许范围：{MIN_AGENT_MAX_RETRIES}~{MAX_AGENT_MAX_RETRIES}，默认 {DEFAULT_AGENT_MAX_RETRIES}。
          </p>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">通过阈值分数</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              每轮评估分数达到该阈值后任务判定成功，不再重试。
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              min={MIN_AGENT_SCORE_THRESHOLD}
              max={MAX_AGENT_SCORE_THRESHOLD}
              step={1}
              value={agentScoreThresholdInput}
              onChange={(e) => setAgentScoreThresholdInput(e.target.value)}
              placeholder={String(DEFAULT_AGENT_SCORE_THRESHOLD)}
              className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={handleSaveAgentScoreThreshold}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
          <p className="text-xs text-gray-500">
            允许范围：{MIN_AGENT_SCORE_THRESHOLD}~{MAX_AGENT_SCORE_THRESHOLD}，默认 {DEFAULT_AGENT_SCORE_THRESHOLD}。
          </p>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">Agent 引擎</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              默认使用 Claude SDK，也可切换 Codex SDK；legacy 仅作为回退引擎。
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <select
              value={agentEngine}
              onChange={(e) => setAgentEngine(e.target.value as 'claude_sdk' | 'codex_sdk' | 'legacy')}
              className="w-56 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="claude_sdk">claude_sdk（推荐）</option>
              <option value="codex_sdk">codex_sdk</option>
              <option value="legacy">legacy（回退）</option>
            </select>
            <button
              onClick={handleSaveAgentEngine}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">上下文保留比例</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              多轮记忆共享策略：最近轮次保留全文，其余轮次结构化摘要。默认 0.30。
            </p>
          </div>
          <div className="flex gap-2">
            <input
              value={contextRetentionRatioInput}
              onChange={(e) => setContextRetentionRatioInput(e.target.value)}
              placeholder={String(DEFAULT_CONTEXT_RETENTION_RATIO)}
              className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={handleSaveContextRetentionRatio}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
          <p className="text-xs text-gray-500">
            允许范围：{MIN_CONTEXT_RETENTION_RATIO}~{MAX_CONTEXT_RETENTION_RATIO}（建议 0.30）。
          </p>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">上下文压缩阈值（soft/hard/critical）</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              当上下文占用率达到阈值时触发分级压缩，需满足 soft &lt; hard &lt; critical。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input
              value={contextCompressionSoftInput}
              onChange={(e) => setContextCompressionSoftInput(e.target.value)}
              placeholder={String(DEFAULT_CONTEXT_COMPRESSION_SOFT)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <input
              value={contextCompressionHardInput}
              onChange={(e) => setContextCompressionHardInput(e.target.value)}
              placeholder={String(DEFAULT_CONTEXT_COMPRESSION_HARD)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <input
              value={contextCompressionCriticalInput}
              onChange={(e) => setContextCompressionCriticalInput(e.target.value)}
              placeholder={String(DEFAULT_CONTEXT_COMPRESSION_CRITICAL)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleSaveContextCompressionThresholds}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存阈值
            </button>
          </div>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-gray-200">默认评估模板 ID</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              任务未手动选择时使用该评估模板。可在「模板 - 评估模板」页查看 ID。
            </p>
          </div>
          <div className="flex gap-2">
            <input
              value={evalTemplateDefaultIdInput}
              onChange={(e) => setEvalTemplateDefaultIdInput(e.target.value)}
              placeholder="如 1"
              className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={handleSaveEvalTemplateDefaultId}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">关于</h2>
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 text-sm text-gray-400 space-y-1">
          <div>EcomAgent v1.0.0</div>
          <div>Electron + React 19 + Claude/Codex SDK</div>
          <div>
            数据存储位置:{' '}
            <span className="font-mono text-gray-500">{userDataPath}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

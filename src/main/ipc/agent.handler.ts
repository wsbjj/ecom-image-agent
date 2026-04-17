import { app, ipcMain, BrowserWindow, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  TaskInput,
  ImageProviderName,
  AgentEngineName,
  EvalRubric,
  EvaluationBackendName,
} from '../../shared/types'
import type { ImageProvider } from '../agent/providers/base'
import { GeminiProvider } from '../agent/providers/gemini.provider'
import { SeedreamProvider } from '../agent/providers/seedream.provider'
import { SeedreamVisualProvider } from '../agent/providers/seedream-visual.provider'
import { VLMEvalBridge, normalizeRubricForJudge } from '../agent/vlmeval-bridge'
import {
  insertTask,
  getConfigValue,
  getEvaluationTemplateById,
  ensureDefaultEvaluationTemplate,
  buildDefaultEvalRubric,
  updateTaskFailed,
} from '../db/queries'
import { v4 as uuidv4 } from 'uuid'
import { createAgentEngine } from '../agent/engines'
import { formatAuthFailureDetail, parseAuthFailure } from '../agent/auth-error-utils'

const controllers = new Map<string, AbortController>()
const vlmBridge = new VLMEvalBridge()
let vlmStarted = false
let vlmStartSignature: string | null = null

const DEFAULT_AGENT_MAX_RETRIES = 3
const MIN_AGENT_MAX_RETRIES = 0
const MAX_AGENT_MAX_RETRIES = 10
const DEFAULT_AGENT_SCORE_THRESHOLD = 85
const MIN_AGENT_SCORE_THRESHOLD = 0
const MAX_AGENT_SCORE_THRESHOLD = 100

const DEFAULT_RETENTION_RATIO = 0.3
const DEFAULT_COMPRESSION_SOFT = 70
const DEFAULT_COMPRESSION_HARD = 85
const DEFAULT_COMPRESSION_CRITICAL = 92
const DEFAULT_PROVIDER_PREFLIGHT_ENABLED = false
const DEFAULT_EVAL_BACKEND: EvaluationBackendName = 'custom_anthropic'
const DEFAULT_VLMEVAL_USE_CUSTOM_MODEL = true

function fingerprintConfigValue(value: string | undefined): string | null {
  if (!value) return null
  return Buffer.from(value, 'utf8').toString('base64')
}

function parseAgentMaxRetries(rawValue: string | undefined): number {
  if (!rawValue) return DEFAULT_AGENT_MAX_RETRIES
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return DEFAULT_AGENT_MAX_RETRIES
  return Math.min(MAX_AGENT_MAX_RETRIES, Math.max(MIN_AGENT_MAX_RETRIES, parsed))
}

function parseAgentScoreThreshold(rawValue: string | undefined): number {
  if (!rawValue) return DEFAULT_AGENT_SCORE_THRESHOLD
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return DEFAULT_AGENT_SCORE_THRESHOLD
  return Math.min(MAX_AGENT_SCORE_THRESHOLD, Math.max(MIN_AGENT_SCORE_THRESHOLD, parsed))
}

function parseEngineName(rawValue: string | undefined): AgentEngineName {
  if (!rawValue) return 'claude_sdk'
  const normalized = rawValue.trim()
  if (normalized === 'legacy') return 'legacy'
  if (normalized === 'codex_sdk') return 'codex_sdk'
  return 'claude_sdk'
}

function parseRatio(rawValue: string | undefined): number {
  if (!rawValue) return DEFAULT_RETENTION_RATIO
  const parsed = Number.parseFloat(rawValue.trim())
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_RATIO
  return Math.min(0.9, Math.max(0.1, parsed))
}

function parseCompressionThreshold(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback
  const parsed = Number.parseInt(rawValue.trim(), 10)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(99, Math.max(1, parsed))
}

function parseProviderPreflightEnabled(rawValue: string | undefined): boolean {
  if (!rawValue) return DEFAULT_PROVIDER_PREFLIGHT_ENABLED
  const normalized = rawValue.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseBooleanFlag(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) return fallback
  const normalized = rawValue.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseEvaluationBackend(rawValue: string | undefined): EvaluationBackendName {
  if (!rawValue) return DEFAULT_EVAL_BACKEND
  return rawValue.trim() === 'vlmevalkit' ? 'vlmevalkit' : DEFAULT_EVAL_BACKEND
}

function resolvePythonPath(): string {
  const appPath = app.getAppPath()
  const venvPython =
    process.platform === 'win32'
      ? path.join(appPath, 'python', '.venv', 'Scripts', 'python.exe')
      : path.join(appPath, 'python', '.venv', 'bin', 'python')

  if (fs.existsSync(venvPython)) {
    return venvPython
  }

  return process.platform === 'win32' ? 'python' : 'python3'
}

async function getDecryptedKey(key: string): Promise<string> {
  const encrypted = await getConfigValue(key)
  if (!encrypted) {
    throw new Error(`配置项 ${key} 未设置，请先在 Settings 页面配置`)
  }
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

async function getOptionalDecryptedValue(key: string): Promise<string | undefined> {
  const encrypted = await getConfigValue(key)
  if (!encrypted) return undefined
  const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim()
  return value.length > 0 ? value : undefined
}

async function getPreferredJudgeValue(
  judgeKey: string,
  legacyAnthropicKey: string,
): Promise<string | undefined> {
  return (
    (await getOptionalDecryptedValue(judgeKey)) ??
    (await getOptionalDecryptedValue(legacyAnthropicKey))
  )
}

async function getPreferredJudgeApiKey(): Promise<string | undefined> {
  return getPreferredJudgeValue('JUDGE_API_KEY', 'ANTHROPIC_API_KEY')
}

async function createImageProvider(): Promise<ImageProvider> {
  const providerName = (await getOptionalDecryptedValue('IMAGE_PROVIDER') ?? 'gemini') as ImageProviderName

  switch (providerName) {
    case 'seedream': {
      const callMode = (await getOptionalDecryptedValue('SEEDREAM_CALL_MODE')) ?? 'openai_compat'
      const apiKey = await getOptionalDecryptedValue('APIKEY_SEEDREAM')
      const baseUrl = await getOptionalDecryptedValue('SEEDREAM_BASE_URL')
      const endpointId = await getOptionalDecryptedValue('SEEDREAM_ENDPOINT_ID')
      const fallbackProvider = apiKey
        ? new SeedreamProvider({ apiKey, baseUrl, endpointId })
        : undefined
      if (callMode === 'visual_official') {
        const accessKeyId = await getOptionalDecryptedValue('SEEDREAM_VISUAL_ACCESS_KEY')
        const secretAccessKey = await getOptionalDecryptedValue('SEEDREAM_VISUAL_SECRET_KEY')
        const reqKey = await getOptionalDecryptedValue('SEEDREAM_VISUAL_REQ_KEY')
        return new SeedreamVisualProvider({
          accessKeyId,
          secretAccessKey,
          reqKey,
          fallbackProvider,
        })
      }
      if (!fallbackProvider) {
        throw new Error('配置项 APIKEY_SEEDREAM 未设置，请先在 Settings 页面配置')
      }
      return fallbackProvider
    }
    case 'gemini':
    default: {
      const apiKey = await getDecryptedKey('GOOGLE_API_KEY')
      const baseUrl = await getOptionalDecryptedValue('GOOGLE_BASE_URL')
      const imageModel = await getOptionalDecryptedValue('GOOGLE_IMAGE_MODEL')
      return new GeminiProvider({ apiKey, baseUrl, imageModel })
    }
  }
}

async function runProviderPreflight(provider: ImageProvider): Promise<{ success: boolean; message: string }> {
  try {
    const generated = await provider.generate({
      prompt: 'Generate a plain white square image for provider preflight check.',
      productImagePaths: [],
      aspectRatio: '1:1',
    })
    if (generated.imagePath) {
      await fsPromises.unlink(generated.imagePath).catch(() => {
        // Ignore cleanup errors for debug preflight artifacts.
      })
    }
    const mode = generated.debugInfo?.providerMode ?? 'default'
    return {
      success: true,
      message: `Provider preflight succeeded. provider=${provider.name}, mode=${mode}`,
    }
  } catch (error: unknown) {
    const parsedAuth = parseAuthFailure(error, {
      providerHint: provider.name,
      tool: 'generate_image',
    })
    if (parsedAuth) {
      return {
        success: false,
        message: `Provider preflight failed with auth/permission error. ${formatAuthFailureDetail(parsedAuth)}`,
      }
    }
    const rawError = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: `Provider preflight failed. provider=${provider.name}, error=${rawError}`,
    }
  }
}

async function resolveEvaluationTemplate(input: TaskInput): Promise<{
  template: {
    id: number
    name: string
    version: number
    default_threshold: number
    rubric_json: string
    created_at: string
  }
  rubric: EvalRubric
}> {
  const defaultTemplate = await ensureDefaultEvaluationTemplate()
  const configuredTemplateIdRaw = await getOptionalDecryptedValue('EVAL_TEMPLATE_DEFAULT_ID')
  const configuredTemplateId = configuredTemplateIdRaw
    ? Number.parseInt(configuredTemplateIdRaw, 10)
    : Number.NaN

  const preferredId =
    typeof input.evaluationTemplateId === 'number' && input.evaluationTemplateId > 0
      ? input.evaluationTemplateId
      : Number.isInteger(configuredTemplateId)
        ? configuredTemplateId
        : defaultTemplate.id

  const target = (await getEvaluationTemplateById(preferredId)) ?? defaultTemplate

  let parsedRubric: EvalRubric
  try {
    parsedRubric = JSON.parse(target.rubric_json) as EvalRubric
  } catch {
    parsedRubric = buildDefaultEvalRubric()
  }

  return {
    template: target,
    rubric: normalizeRubricForJudge(parsedRubric),
  }
}

async function resolveVLMEvalStartConfig(): Promise<{
  options: {
    judgeApiKey?: string
    judgeBaseUrl?: string
    judgeModel?: string
    evalBackend: EvaluationBackendName
    vlmevalModelId?: string
    vlmevalUseCustomModel: boolean
  }
  signature: string
}> {
  const evalBackend = parseEvaluationBackend(await getOptionalDecryptedValue('EVAL_BACKEND'))
  const judgeApiKey = await getPreferredJudgeApiKey()
  const judgeBaseUrl = await getPreferredJudgeValue('JUDGE_BASE_URL', 'ANTHROPIC_BASE_URL')
  const judgeModel = await getPreferredJudgeValue('JUDGE_MODEL', 'ANTHROPIC_MODEL')
  const vlmevalUseCustomModel = parseBooleanFlag(
    await getOptionalDecryptedValue('VLMEVAL_USE_CUSTOM_MODEL'),
    DEFAULT_VLMEVAL_USE_CUSTOM_MODEL,
  )
  const vlmevalModelId =
    await getOptionalDecryptedValue('VLMEVAL_MODEL_ID') ||
    judgeModel ||
    'claude-sonnet-4-20250514'
  if ((evalBackend === 'custom_anthropic' || vlmevalUseCustomModel) && !judgeApiKey) {
    throw new Error(
      '视觉评测 Judge 缺少可用的 API Key，请先配置 JUDGE_API_KEY；若沿用旧配置，也可保留 ANTHROPIC_API_KEY 作为回退。',
    )
  }

  const options = {
    judgeApiKey,
    judgeBaseUrl,
    judgeModel,
    evalBackend,
    vlmevalModelId,
    vlmevalUseCustomModel,
  }

  return {
    options,
    signature: JSON.stringify({
      evalBackend,
      judgeApiKeyFingerprint: fingerprintConfigValue(judgeApiKey),
      judgeBaseUrl: judgeBaseUrl ?? null,
      judgeModel: judgeModel ?? null,
      vlmevalModelId: vlmevalModelId ?? null,
      vlmevalUseCustomModel,
    }),
  }
}

export function registerAgentHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.TASK_START, async (_event, input: TaskInput): Promise<{ taskId: string }> => {
    const engineName = parseEngineName(await getOptionalDecryptedValue('AGENT_ENGINE'))
    const codexApiKey = await getOptionalDecryptedValue('CODEX_API_KEY')
    const codexBaseUrl = await getOptionalDecryptedValue('CODEX_BASE_URL')
    const codexModel = await getOptionalDecryptedValue('CODEX_MODEL')
    if (engineName === 'codex_sdk' && !codexApiKey) {
      throw new Error('配置项 CODEX_API_KEY 未设置，请先在 Settings 页面配置')
    }

    const pythonPath = resolvePythonPath()
    const vlmevalStartConfig = await resolveVLMEvalStartConfig()
    if (!vlmStarted) {
      await vlmBridge.start(pythonPath, vlmevalStartConfig.options)
      vlmStarted = true
      vlmStartSignature = vlmevalStartConfig.signature
    } else if (vlmStartSignature !== vlmevalStartConfig.signature) {
      if (controllers.size > 0) {
        throw new Error('视觉评估配置已变更，请等待当前任务完成后再启动新任务。')
      }
      await vlmBridge.stop()
      await vlmBridge.start(pythonPath, vlmevalStartConfig.options)
      vlmStarted = true
      vlmStartSignature = vlmevalStartConfig.signature
    }

    const taskId = uuidv4()
    await insertTask({
      taskId,
      skuId: input.skuId,
      productName: input.productName,
      productImages: JSON.stringify(input.productImages),
      referenceImages: input.referenceImages ? JSON.stringify(input.referenceImages) : null,
    })

    const controller = new AbortController()
    controllers.set(taskId, controller)

    const provider = await createImageProvider()
    const anthropicKey = await getDecryptedKey('ANTHROPIC_API_KEY')
    const anthropicBaseUrl = await getOptionalDecryptedValue('ANTHROPIC_BASE_URL')
    const anthropicModel = await getOptionalDecryptedValue('ANTHROPIC_MODEL')

    const maxRetries = parseAgentMaxRetries(await getOptionalDecryptedValue('AGENT_MAX_RETRIES'))
    const providerPreflightEnabled = parseProviderPreflightEnabled(
      await getOptionalDecryptedValue('AGENT_DEBUG_PROVIDER_PREFLIGHT'),
    )
    const scoreThresholdFromConfig = parseAgentScoreThreshold(
      await getOptionalDecryptedValue('AGENT_SCORE_THRESHOLD'),
    )

    const retentionRatio = parseRatio(await getOptionalDecryptedValue('CONTEXT_RETENTION_RATIO'))
    const compressionSoft = parseCompressionThreshold(
      await getOptionalDecryptedValue('CONTEXT_COMPRESSION_SOFT'),
      DEFAULT_COMPRESSION_SOFT,
    )
    const compressionHard = parseCompressionThreshold(
      await getOptionalDecryptedValue('CONTEXT_COMPRESSION_HARD'),
      DEFAULT_COMPRESSION_HARD,
    )
    const compressionCritical = parseCompressionThreshold(
      await getOptionalDecryptedValue('CONTEXT_COMPRESSION_CRITICAL'),
      DEFAULT_COMPRESSION_CRITICAL,
    )

    const evalTemplate = await resolveEvaluationTemplate(input)

    const thresholdOverride =
      typeof input.scoreThresholdOverride === 'number' && Number.isInteger(input.scoreThresholdOverride)
        ? Math.min(100, Math.max(0, input.scoreThresholdOverride))
        : null

    const scoreThreshold =
      thresholdOverride ??
      scoreThresholdFromConfig ??
      Math.max(0, Math.min(100, evalTemplate.template.default_threshold))

    if (providerPreflightEnabled) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, {
          taskId,
          phase: 'observe',
          message: `Provider preflight start. provider=${provider.name}`,
          retryCount: 0,
          roundIndex: 0,
          timestamp: Date.now(),
        })
      }

      const preflightResult = await runProviderPreflight(provider)
      if (!preflightResult.success) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, {
            taskId,
            phase: 'failed',
            message: preflightResult.message,
            retryCount: 0,
            roundIndex: 0,
            timestamp: Date.now(),
          })
        }
        await updateTaskFailed({ taskId, retryCount: 0, costUsd: 0 })
        controller.abort()
        controllers.delete(taskId)
        return { taskId }
      }

      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, {
          taskId,
          phase: 'observe',
          message: preflightResult.message,
          retryCount: 0,
          roundIndex: 0,
          timestamp: Date.now(),
        })
      }
    }

    const engine = createAgentEngine(engineName)

    engine
      .run(
        { ...input, taskId, evaluationTemplateId: evalTemplate.template.id },
        win,
        vlmBridge,
        controller.signal,
        {
          provider,
          providerPreflightEnabled,
          anthropicApiKey: anthropicKey,
          anthropicBaseUrl,
          anthropicModel,
          codexApiKey,
          codexBaseUrl,
          codexModel,
          maxRetries,
          scoreThreshold,
          evaluationTemplate: evalTemplate.template,
          evaluationRubric: evalTemplate.rubric,
          retentionRatio,
          compressionThresholdSoft: compressionSoft,
          compressionThresholdHard: compressionHard,
          compressionThresholdCritical: compressionCritical,
        },
      )
      .catch((err: unknown) => {
        console.error('[AgentRunner]', err)
      })
      .finally(() => {
        controllers.delete(taskId)
      })

    return { taskId }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_STOP, async (_event, taskId: string): Promise<{ success: boolean }> => {
    const ctrl = controllers.get(taskId)
    if (ctrl) {
      ctrl.abort()
      controllers.delete(taskId)
    }
    return { success: true }
  })
}

export function cleanupAgentHandlers(): void {
  for (const [, ctrl] of controllers) {
    ctrl.abort()
  }
  controllers.clear()
  vlmStarted = false
  vlmStartSignature = null
  vlmBridge.stop().catch(console.error)
}

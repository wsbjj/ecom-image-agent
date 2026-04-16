import { app, ipcMain, BrowserWindow, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { TaskInput, ImageProviderName, AgentEngineName, EvalRubric } from '../../shared/types'
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
} from '../db/queries'
import { v4 as uuidv4 } from 'uuid'
import { createAgentEngine } from '../agent/engines'

const controllers = new Map<string, AbortController>()
const vlmBridge = new VLMEvalBridge()
let vlmStarted = false

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

export function registerAgentHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.TASK_START, async (_event, input: TaskInput): Promise<{ taskId: string }> => {
    const engineName = parseEngineName(await getOptionalDecryptedValue('AGENT_ENGINE'))
    const codexApiKey = await getOptionalDecryptedValue('CODEX_API_KEY')
    const codexBaseUrl = await getOptionalDecryptedValue('CODEX_BASE_URL')
    const codexModel = await getOptionalDecryptedValue('CODEX_MODEL')
    if (engineName === 'codex_sdk' && !codexApiKey) {
      throw new Error('配置项 CODEX_API_KEY 未设置，请先在 Settings 页面配置')
    }

    if (!vlmStarted) {
      const pythonPath = resolvePythonPath()
      const anthropicKey = await getDecryptedKey('ANTHROPIC_API_KEY')
      const anthropicBaseUrl = await getOptionalDecryptedValue('ANTHROPIC_BASE_URL')
      const anthropicModel = await getOptionalDecryptedValue('ANTHROPIC_MODEL')
      await vlmBridge.start(pythonPath, anthropicKey, {
        anthropicBaseUrl,
        anthropicModel,
      })
      vlmStarted = true
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

    const engine = createAgentEngine(engineName)

    engine
      .run(
        { ...input, taskId, evaluationTemplateId: evalTemplate.template.id },
        win,
        vlmBridge,
        controller.signal,
        {
          provider,
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
  vlmBridge.stop().catch(console.error)
}

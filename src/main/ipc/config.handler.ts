import { app, ipcMain, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { parseEvalRubricMarkdown, formatEvalRubricMarkdown } from '../../shared/eval-rubric-markdown'
import { SeedreamProvider } from '../agent/providers/seedream.provider'
import { SeedreamVisualProvider } from '../agent/providers/seedream-visual.provider'
import {
  setConfigValue,
  getConfigValue,
  insertTemplate,
  listTemplates,
  deleteTemplate,
  insertEvaluationTemplate,
  listEvaluationTemplates,
  deleteEvaluationTemplate,
  ensureDefaultEvaluationTemplate,
} from '../db/queries'
import type {
  TemplateInput,
  TemplateRecord,
  ImageProviderName,
  EvaluationTemplateInput,
  EvaluationTemplateRecord,
  EvalTemplateDraftRequest,
  EvalTemplateDraftResponse,
} from '../../shared/types'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_CODEX_MODEL = 'gpt-5.4'
const DEFAULT_EVAL_TEMPLATE_THRESHOLD = 85
const DEFAULT_AI_EVAL_TEMPLATE_NAME = 'AI评估模板'
const MAX_DRAFT_RETRY_ATTEMPTS = 2

type CodexCtor = typeof import('@openai/codex-sdk').Codex
let codexCtorPromise: Promise<CodexCtor> | null = null

async function getCodexCtor(): Promise<CodexCtor> {
  if (!codexCtorPromise) {
    codexCtorPromise = import('@openai/codex-sdk').then((mod) => mod.Codex)
  }
  return codexCtorPromise
}

async function getOptionalDecryptedValue(key: string): Promise<string | undefined> {
  const val = await getConfigValue(key)
  if (!val) return undefined
  const text = safeStorage.decryptString(Buffer.from(val, 'base64')).trim()
  return text.length > 0 ? text : undefined
}

function parseCodexErrorDiagnostics(rawMessage: string): {
  statusCode: number | null
  requestId: string | null
  url: string | null
} {
  const statusMatch =
    rawMessage.match(/\bstatus\s+(\d{3})\b/i) ??
    rawMessage.match(/\bstatus=(\d{3})\b/i) ??
    rawMessage.match(/\bhttp\s+(\d{3})\b/i)
  const requestIdMatch =
    rawMessage.match(/\brequest id:\s*([a-z0-9-]+)/i) ??
    rawMessage.match(/\brequest_id=([a-z0-9-]+)/i)
  const urlMatch = rawMessage.match(/\burl:\s*([^,\s]+)/i) ?? rawMessage.match(/\burl=([^,\s]+)/i)

  return {
    statusCode: statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : null,
    requestId: requestIdMatch?.[1] ?? null,
    url: urlMatch?.[1] ?? null,
  }
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function extractAnthropicText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const textBlocks = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text?.trim() ?? '')
    .filter((text) => text.length > 0)
  return textBlocks.join('\n').trim()
}

function parseJsonFromModelOutput(rawText: string): unknown {
  const trimmed = rawText.trim()
  if (!trimmed) {
    throw new Error('模型返回为空')
  }

  const candidates: string[] = [trimmed]
  const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (jsonFenceMatch?.[1]) {
    candidates.push(jsonFenceMatch[1].trim())
  }
  const genericFenceMatch = trimmed.match(/```\s*([\s\S]*?)```/)
  if (genericFenceMatch?.[1]) {
    candidates.push(genericFenceMatch[1].trim())
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim())
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter((candidate) => candidate.length > 0)))
  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('模型返回不是有效 JSON')
}

function normalizeThreshold(rawValue: unknown): number {
  const parsed =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number.parseInt(rawValue.trim(), 10)
        : Number.NaN

  if (!Number.isInteger(parsed)) return DEFAULT_EVAL_TEMPLATE_THRESHOLD
  return Math.min(100, Math.max(0, parsed))
}

function normalizeEvalTemplateDraft(rawText: string): EvalTemplateDraftResponse {
  const parsed = parseJsonFromModelOutput(rawText)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型返回缺少对象结构')
  }

  const payload = parsed as Partial<Record<'name' | 'defaultThreshold' | 'rubricMarkdown', unknown>>
  const name =
    typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim()
      : DEFAULT_AI_EVAL_TEMPLATE_NAME
  const defaultThreshold = normalizeThreshold(payload.defaultThreshold)

  if (typeof payload.rubricMarkdown !== 'string' || payload.rubricMarkdown.trim().length === 0) {
    throw new Error('模型返回缺少 rubricMarkdown')
  }

  const rubric = parseEvalRubricMarkdown(payload.rubricMarkdown)
  const rubricMarkdown = formatEvalRubricMarkdown(rubric)

  return {
    name,
    defaultThreshold,
    rubricMarkdown,
  }
}

function buildDraftPrompt(requirements: string): string {
  return [
    '你是电商图片质量评估模板设计助手。',
    '请基于用户需求输出严格 JSON，不要输出任何解释文字。',
    'JSON 字段必须是：name, defaultThreshold, rubricMarkdown。',
    'rubricMarkdown 必须严格符合以下 Markdown 模板约束：',
    '1) 必须包含标题 "## 评分维度" 和 "## 评分说明"。',
    '2) 评分维度表头必须完全是：| key | 名称 | 满分 | 权重 | 描述 |',
    '3) 至少 3 个维度，最多 6 个维度；key 需唯一且仅字母数字下划线中划线。',
    '4) 满分为正整数，权重为>=0 的数字。',
    '5) 评分说明必须给出可执行判分指引。',
    '',
    `用户需求：${requirements}`,
  ].join('\n')
}

function buildDraftRepairPrompt(
  requirements: string,
  previousOutput: string,
  validationError: string,
): string {
  return [
    '你上一次输出不符合要求，请仅输出修复后的严格 JSON。',
    '禁止输出解释、禁止 Markdown 代码块。',
    `校验错误：${validationError}`,
    `用户需求：${requirements}`,
    '',
    '你上一次输出如下：',
    previousOutput,
  ].join('\n')
}

export function registerConfigHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SET,
    async (_event, key: string, rawValue: string): Promise<{ success: boolean }> => {
      const encrypted = safeStorage.encryptString(rawValue).toString('base64')
      await setConfigValue(key, encrypted)
      return { success: true }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_GET,
    async (_event, key: string): Promise<{ exists: boolean }> => {
      const val = await getConfigValue(key)
      return { exists: val !== undefined }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_GET_VALUE,
    async (_event, key: string): Promise<{ value: string | null }> => {
      const val = await getConfigValue(key)
      if (!val) return { value: null }
      return { value: safeStorage.decryptString(Buffer.from(val, 'base64')) }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_TEST_ANTHROPIC,
    async (
      _event,
      params: { apiKey?: string; baseUrl?: string; model?: string },
    ): Promise<{ success: boolean; message: string }> => {
      const apiKey = params.apiKey?.trim() || (await getOptionalDecryptedValue('ANTHROPIC_API_KEY'))
      const baseUrl = params.baseUrl?.trim() || (await getOptionalDecryptedValue('ANTHROPIC_BASE_URL'))
      const model =
        params.model?.trim() ||
        (await getOptionalDecryptedValue('ANTHROPIC_MODEL')) ||
        DEFAULT_ANTHROPIC_MODEL

      if (!apiKey) {
        return { success: false, message: '请先输入 Anthropic API Key' }
      }

      try {
        const anthropic = new Anthropic({
          apiKey,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        })

        await anthropic.messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        })

        return { success: true, message: '连接测试成功' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message }
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_TEST_CODEX,
    async (
      _event,
      params: { apiKey?: string; baseUrl?: string; model?: string },
    ): Promise<{ success: boolean; message: string }> => {
      const apiKey = params.apiKey?.trim() || (await getOptionalDecryptedValue('CODEX_API_KEY'))
      const baseUrl = params.baseUrl?.trim() || (await getOptionalDecryptedValue('CODEX_BASE_URL'))
      const model =
        params.model?.trim() ||
        (await getOptionalDecryptedValue('CODEX_MODEL')) ||
        DEFAULT_CODEX_MODEL

      if (!apiKey) {
        return { success: false, message: 'Please provide Codex API Key first.' }
      }

      try {
        const Codex = await getCodexCtor()
        const codex = new Codex({
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
        })
        const thread = codex.startThread({
          model,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        })
        await thread.run('ping')
        return { success: true, message: `Codex connection test succeeded (model: ${model})` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const diagnostics = parseCodexErrorDiagnostics(message)
        const diagText = [
          diagnostics.statusCode !== null ? `status=${diagnostics.statusCode}` : null,
          diagnostics.requestId ? `request_id=${diagnostics.requestId}` : null,
          diagnostics.url ? `url=${diagnostics.url}` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(', ')
        const hint =
          'Hint: check proxy gateway/model availability, or clear Codex Base URL and retry with official endpoint.'
        const formattedMessage = diagText.length > 0 ? `${message}; ${diagText}. ${hint}` : `${message}. ${hint}`
        return { success: false, message: formattedMessage }
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_TEST_IMAGE_PROVIDER,
    async (
      _event,
      params: {
        provider: ImageProviderName
        apiKey?: string
        baseUrl?: string
        model?: string
        endpointId?: string
        callMode?: 'visual_official' | 'openai_compat'
        accessKeyId?: string
        secretAccessKey?: string
        reqKey?: string
      },
    ): Promise<{ success: boolean; message: string; durationMs?: number }> => {
      const startedAt = Date.now()
      try {
        if (params.provider === 'gemini') {
          const apiKey = params.apiKey?.trim() || (await getOptionalDecryptedValue('GOOGLE_API_KEY'))
          const baseUrl = params.baseUrl?.trim() || (await getOptionalDecryptedValue('GOOGLE_BASE_URL'))
          const model =
            params.model?.trim() ||
            (await getOptionalDecryptedValue('GOOGLE_IMAGE_MODEL')) ||
            'gemini-2.0-flash-preview-image-generation'

          if (!apiKey) {
            return { success: false, message: '请先输入 Google API Key' }
          }

          const genAI = new GoogleGenerativeAI(apiKey)
          const imageModel = genAI.getGenerativeModel(
            { model },
            baseUrl ? { baseUrl } : undefined,
          )
          const result = await imageModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'Generate a plain white square image for API connectivity test.' }] }],
            generationConfig: {
              responseMimeType: 'image/png',
            },
          })
          const hasImage = Boolean(
            result.response.candidates?.[0]?.content.parts.some((part) =>
              part.inlineData?.mimeType?.startsWith('image/'),
            ),
          )
          if (!hasImage) {
            throw new Error('Gemini 未返回图片数据')
          }

          return {
            success: true,
            message: `Google Gemini 图像测试成功（模型: ${model}）`,
            durationMs: Date.now() - startedAt,
          }
        }

        const apiKey = params.apiKey?.trim() || (await getOptionalDecryptedValue('APIKEY_SEEDREAM'))
        const baseUrl =
          params.baseUrl?.trim() ||
          (await getOptionalDecryptedValue('SEEDREAM_BASE_URL')) ||
          'https://ark.cn-beijing.volces.com/api/v3'
        const endpointId =
          params.endpointId?.trim() ||
          params.model?.trim() ||
          (await getOptionalDecryptedValue('SEEDREAM_ENDPOINT_ID')) ||
          'doubao-seedream-3-0-t2i-250415'
        const callMode =
          params.callMode ||
          ((await getOptionalDecryptedValue('SEEDREAM_CALL_MODE')) as
            | 'visual_official'
            | 'openai_compat'
            | undefined) ||
          'openai_compat'
        const accessKeyId =
          params.accessKeyId?.trim() ||
          (await getOptionalDecryptedValue('SEEDREAM_VISUAL_ACCESS_KEY'))
        const secretAccessKey =
          params.secretAccessKey?.trim() ||
          (await getOptionalDecryptedValue('SEEDREAM_VISUAL_SECRET_KEY'))
        const reqKey =
          params.reqKey?.trim() ||
          (await getOptionalDecryptedValue('SEEDREAM_VISUAL_REQ_KEY')) ||
          'high_aes_general_v30l_zt2i'

        if (!apiKey) {
          return { success: false, message: '请先输入 Seedream API Key' }
        }

        if (callMode === 'visual_official') {
          if (!accessKeyId || !secretAccessKey) {
            return { success: false, message: '官方 Visual 模式需要填写 AccessKey/SecretKey' }
          }

          // 测试连接必须严格命中用户选择的协议；Visual 模式下禁止自动回退 openai_compat。
          const provider = new SeedreamVisualProvider({
            accessKeyId,
            secretAccessKey,
            reqKey,
          })
          const generated = await provider.generate({
            prompt: 'A plain white background image for API connectivity test.',
            productImagePaths: [],
            aspectRatio: '1:1',
          })
          const mode = generated.debugInfo?.providerMode ?? 'visual_official'
          if (mode !== 'visual_official') {
            return {
              success: false,
              message: `Seedream Visual 测试失败：当前实际走的是 ${mode}，请检查调用模式配置`,
              durationMs: Date.now() - startedAt,
            }
          }

          return {
            success: true,
            message: `Seedream 图像测试成功（模型: ${endpointId}，模式: visual_official）`,
            durationMs: Date.now() - startedAt,
          }
        }

        const provider = new SeedreamProvider({
          apiKey,
          baseUrl,
          endpointId,
        })
        const generated = await provider.generate({
          prompt: 'A plain white background image for API connectivity test.',
          productImagePaths: [],
          aspectRatio: '1:1',
        })

        return {
          success: true,
          message: `Seedream 图像测试成功（模型: ${endpointId}，模式: ${generated.debugInfo?.providerMode ?? 'openai_compat'})`,
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message, durationMs: Date.now() - startedAt }
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.APP_USER_DATA_PATH,
    async (): Promise<{ path: string }> => {
      return { path: app.getPath('userData') }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_AS_DATA_URL,
    async (_event, filePath: string): Promise<{ dataUrl: string | null }> => {
      try {
        const normalizedPath = filePath.trim()
        if (!normalizedPath) return { dataUrl: null }

        const buffer = await fs.readFile(normalizedPath)
        const mimeType = guessMimeType(normalizedPath)
        return { dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` }
      } catch {
        return { dataUrl: null }
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_SAVE,
    async (_event, template: TemplateInput): Promise<{ success: boolean }> => {
      await insertTemplate(template)
      return { success: true }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_LIST,
    async (): Promise<TemplateRecord[]> => {
      return listTemplates()
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_DELETE,
    async (_event, id: number): Promise<{ success: boolean }> => {
      await deleteTemplate(id)
      return { success: true }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EVAL_TEMPLATE_SAVE,
    async (_event, template: EvaluationTemplateInput): Promise<{ success: boolean }> => {
      const rubric = parseEvalRubricMarkdown(template.rubricMarkdown)
      await insertEvaluationTemplate({
        name: template.name,
        version: template.version,
        defaultThreshold: template.defaultThreshold,
        rubric,
      })
      return { success: true }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EVAL_TEMPLATE_LIST,
    async (): Promise<EvaluationTemplateRecord[]> => {
      return listEvaluationTemplates()
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EVAL_TEMPLATE_DELETE,
    async (_event, id: number): Promise<{ success: boolean }> => {
      await deleteEvaluationTemplate(id)
      return { success: true }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_DRAFT,
    async (_event, payload: EvalTemplateDraftRequest): Promise<EvalTemplateDraftResponse> => {
      const requirements = payload.requirements?.trim() ?? ''
      if (!requirements) {
        throw new Error('请先输入业务需求')
      }

      const apiKey = await getOptionalDecryptedValue('ANTHROPIC_API_KEY')
      if (!apiKey) {
        throw new Error('未检测到 Anthropic API Key，请先在设置页配置后再生成')
      }

      const baseUrl = await getOptionalDecryptedValue('ANTHROPIC_BASE_URL')
      const model = (await getOptionalDecryptedValue('ANTHROPIC_MODEL')) || DEFAULT_ANTHROPIC_MODEL
      const anthropic = new Anthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      })

      let previousOutput = ''
      let lastErrorMessage = '未知错误'

      for (let attempt = 0; attempt < MAX_DRAFT_RETRY_ATTEMPTS; attempt += 1) {
        const prompt =
          attempt === 0
            ? buildDraftPrompt(requirements)
            : buildDraftRepairPrompt(requirements, previousOutput, lastErrorMessage)

        const response = await anthropic.messages.create({
          model,
          max_tokens: 2200,
          messages: [{ role: 'user', content: prompt }],
        })

        const outputText = extractAnthropicText(
          response.content as ReadonlyArray<{ type: string; text?: string }>,
        )
        if (!outputText) {
          lastErrorMessage = '模型未返回文本结果'
          continue
        }

        previousOutput = outputText
        try {
          return normalizeEvalTemplateDraft(outputText)
        } catch (error: unknown) {
          lastErrorMessage = error instanceof Error ? error.message : String(error)
        }
      }

      throw new Error(`AI 生成模板失败：${lastErrorMessage}`)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_STANDARD,
    async (): Promise<EvaluationTemplateRecord> => {
      return ensureDefaultEvaluationTemplate()
    },
  )
}

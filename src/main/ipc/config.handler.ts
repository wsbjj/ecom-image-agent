import { app, ipcMain, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { SeedreamProvider } from '../agent/providers/seedream.provider'
import { SeedreamVisualProvider } from '../agent/providers/seedream-visual.provider'
import {
  setConfigValue,
  getConfigValue,
  insertTemplate,
  listTemplates,
  deleteTemplate,
} from '../db/queries'
import type { TemplateInput, TemplateRecord, ImageProviderName } from '../../shared/types'

async function getOptionalDecryptedValue(key: string): Promise<string | undefined> {
  const val = await getConfigValue(key)
  if (!val) return undefined
  const text = safeStorage.decryptString(Buffer.from(val, 'base64')).trim()
  return text.length > 0 ? text : undefined
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
        'claude-sonnet-4-20250514'

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
}

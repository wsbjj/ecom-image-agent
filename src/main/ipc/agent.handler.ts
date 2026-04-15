import { app, ipcMain, BrowserWindow, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { runAgentLoop } from '../agent/runner'
import type { TaskInput, ImageProviderName } from '../../shared/types'
import type { ImageProvider } from '../agent/providers/base'
import { GeminiProvider } from '../agent/providers/gemini.provider'
import { SeedreamProvider } from '../agent/providers/seedream.provider'
import { SeedreamVisualProvider } from '../agent/providers/seedream-visual.provider'
import { VLMEvalBridge } from '../agent/vlmeval-bridge'
import { insertTask, getConfigValue } from '../db/queries'
import { v4 as uuidv4 } from 'uuid'

const controllers = new Map<string, AbortController>()
const vlmBridge = new VLMEvalBridge()
let vlmStarted = false

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

export function registerAgentHandlers(win: BrowserWindow): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_START,
    async (_event, input: TaskInput): Promise<{ taskId: string }> => {
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

      runAgentLoop(
        { ...input, taskId },
        win,
        vlmBridge,
        controller.signal,
        {
          provider,
          anthropicApiKey: anthropicKey,
          anthropicBaseUrl,
          anthropicModel,
        },
      )
        .catch((err: unknown) => {
          console.error('[AgentRunner]', err)
        })
        .finally(() => {
          controllers.delete(taskId)
        })

      return { taskId }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.TASK_STOP,
    async (_event, taskId: string): Promise<{ success: boolean }> => {
      const ctrl = controllers.get(taskId)
      if (ctrl) {
        ctrl.abort()
        controllers.delete(taskId)
      }
      return { success: true }
    },
  )
}

export function cleanupAgentHandlers(): void {
  for (const [, ctrl] of controllers) {
    ctrl.abort()
  }
  controllers.clear()
  vlmBridge.stop().catch(console.error)
}

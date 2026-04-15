import { ipcMain, BrowserWindow, safeStorage } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { runAgentLoop } from '../agent/runner'
import type { TaskInput } from '../../shared/types'
import { VLMEvalBridge } from '../agent/vlmeval-bridge'
import { insertTask, getConfigValue } from '../db/queries'
import { v4 as uuidv4 } from 'uuid'

const controllers = new Map<string, AbortController>()
const vlmBridge = new VLMEvalBridge()
let vlmStarted = false

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

export function registerAgentHandlers(win: BrowserWindow): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_START,
    async (_event, input: TaskInput): Promise<{ taskId: string }> => {
      if (!vlmStarted) {
        const pythonPath = process.platform === 'win32' ? 'python' : 'python3'
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
      })

      const controller = new AbortController()
      controllers.set(taskId, controller)

      const googleKey = await getDecryptedKey('GOOGLE_API_KEY')
      const anthropicKey = await getDecryptedKey('ANTHROPIC_API_KEY')
      const anthropicBaseUrl = await getOptionalDecryptedValue('ANTHROPIC_BASE_URL')
      const anthropicModel = await getOptionalDecryptedValue('ANTHROPIC_MODEL')
      const googleBaseUrl = await getOptionalDecryptedValue('GOOGLE_BASE_URL')
      const googleImageModel = await getOptionalDecryptedValue('GOOGLE_IMAGE_MODEL')

      runAgentLoop(
        { ...input, taskId },
        win,
        vlmBridge,
        controller.signal,
        {
          googleApiKey: googleKey,
          googleBaseUrl,
          googleImageModel,
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

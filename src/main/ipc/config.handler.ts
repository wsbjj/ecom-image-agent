import { app, ipcMain, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  setConfigValue,
  getConfigValue,
  insertTemplate,
  listTemplates,
  deleteTemplate,
} from '../db/queries'
import type { TemplateInput, TemplateRecord } from '../../shared/types'

async function getOptionalDecryptedValue(key: string): Promise<string | undefined> {
  const val = await getConfigValue(key)
  if (!val) return undefined
  const text = safeStorage.decryptString(Buffer.from(val, 'base64')).trim()
  return text.length > 0 ? text : undefined
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
    IPC_CHANNELS.APP_USER_DATA_PATH,
    async (): Promise<{ path: string }> => {
      return { path: app.getPath('userData') }
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

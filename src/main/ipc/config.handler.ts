import { app, ipcMain, safeStorage } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  setConfigValue,
  getConfigValue,
  insertTemplate,
  listTemplates,
  deleteTemplate,
} from '../db/queries'
import type { TemplateInput, TemplateRecord } from '../../shared/types'

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

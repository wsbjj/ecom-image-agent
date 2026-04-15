import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type { TaskInput, LoopEvent, TemplateInput, TaskRecord, TemplateRecord } from '../shared/types'

const api = {
  startTask: (input: TaskInput): Promise<{ taskId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_START, input),

  stopTask: (taskId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_STOP, taskId),

  queryTasks: (): Promise<TaskRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),

  onAgentEvent: (callback: (event: LoopEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: LoopEvent): void => {
      callback(event)
    }
    ipcRenderer.on(IPC_CHANNELS.AGENT_LOOP_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_LOOP_EVENT, handler)
    }
  },

  saveConfig: (key: string, value: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),

  checkConfig: (key: string): Promise<{ exists: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),

  getConfigValue: (key: string): Promise<{ value: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_VALUE, key),

  testAnthropicConnection: (params: {
    apiKey?: string
    baseUrl?: string
    model?: string
  }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_TEST_ANTHROPIC, params),

  getUserDataPath: (): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_USER_DATA_PATH),

  saveTemplate: (template: TemplateInput): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_SAVE, template),

  listTemplates: (): Promise<TemplateRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_LIST),

  deleteTemplate: (id: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id),
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: typeof api
  }
}

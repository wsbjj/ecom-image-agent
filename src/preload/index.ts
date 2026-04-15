import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  TaskInput,
  LoopEvent,
  TemplateInput,
  TaskRecord,
  TemplateRecord,
  ImageProviderName,
  EvaluationTemplateInput,
  EvaluationTemplateRecord,
  TaskRoundArtifactRecord,
} from '../shared/types'

const api = {
  startTask: (input: TaskInput): Promise<{ taskId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_START, input),

  stopTask: (taskId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_STOP, taskId),

  queryTasks: (): Promise<TaskRecord[]> => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),

  queryTaskRoundArtifacts: (taskId: string): Promise<TaskRoundArtifactRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_ROUND_ARTIFACTS, taskId),

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

  testImageProviderConnection: (params: {
    provider: ImageProviderName
    apiKey?: string
    baseUrl?: string
    model?: string
    endpointId?: string
    callMode?: 'visual_official' | 'openai_compat'
    accessKeyId?: string
    secretAccessKey?: string
    reqKey?: string
  }): Promise<{ success: boolean; message: string; durationMs?: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_TEST_IMAGE_PROVIDER, params),

  getUserDataPath: (): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_USER_DATA_PATH),

  readImageAsDataUrl: (filePath: string): Promise<{ dataUrl: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_AS_DATA_URL, filePath),

  saveTemplate: (template: TemplateInput): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_SAVE, template),

  listTemplates: (): Promise<TemplateRecord[]> => ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_LIST),

  deleteTemplate: (id: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id),

  saveEvaluationTemplate: (
    template: EvaluationTemplateInput,
  ): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.EVAL_TEMPLATE_SAVE, template),

  listEvaluationTemplates: (): Promise<EvaluationTemplateRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.EVAL_TEMPLATE_LIST),

  deleteEvaluationTemplate: (id: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EVAL_TEMPLATE_DELETE, id),

  generateStandardEvaluationTemplate: (): Promise<EvaluationTemplateRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_STANDARD),

  resolveLocalPath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: typeof api
  }
}

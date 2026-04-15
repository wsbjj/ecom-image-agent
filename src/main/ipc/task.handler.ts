import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { listTasks, listTaskRoundArtifacts } from '../db/queries'
import type { TaskRecord, TaskRoundArtifactRecord } from '../../shared/types'

export function registerTaskHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async (): Promise<TaskRecord[]> => {
    return listTasks()
  })

  ipcMain.handle(
    IPC_CHANNELS.TASK_ROUND_ARTIFACTS,
    async (_event, taskId: string): Promise<TaskRoundArtifactRecord[]> => {
      return listTaskRoundArtifacts(taskId)
    },
  )
}

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { listTasks } from '../db/queries'
import type { TaskRecord } from '../../shared/types'

export function registerTaskHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async (): Promise<TaskRecord[]> => {
      return listTasks()
    },
  )
}

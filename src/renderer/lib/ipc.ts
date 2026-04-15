/**
 * Renderer-side IPC call wrappers.
 * All actual calls go through window.api (exposed by preload/index.ts).
 * This file provides reusable async helpers that pages/components can import.
 */
import type { TaskInput } from '../../shared/types'

export async function startTask(input: TaskInput): Promise<string> {
  const { taskId } = await window.api.startTask(input)
  return taskId
}

export async function stopTask(taskId: string): Promise<void> {
  await window.api.stopTask(taskId)
}

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { TaskRecord } from '../../shared/types'

interface TaskState {
  tasks: TaskRecord[]
  isLoading: boolean
  filter: 'all' | 'pending' | 'running' | 'success' | 'failed'
}

interface TaskActions {
  fetchTasks: () => Promise<void>
  setFilter: (filter: TaskState['filter']) => void
}

export const useTaskStore = create<TaskState & TaskActions>()(
  subscribeWithSelector((set) => ({
    tasks: [],
    isLoading: false,
    filter: 'all',

    fetchTasks: async () => {
      set({ isLoading: true })
      try {
        const tasks = await window.api.queryTasks()
        set({ tasks, isLoading: false })
      } catch (err) {
        console.error('[TaskStore] fetchTasks failed:', err)
        set({ isLoading: false })
      }
    },

    setFilter: (filter: TaskState['filter']) => set({ filter }),
  })),
)

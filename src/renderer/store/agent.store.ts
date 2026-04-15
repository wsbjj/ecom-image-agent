import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { LoopEvent } from '../../shared/types'

interface AgentState {
  activeTaskId: string | null
  currentPhase: LoopEvent['phase'] | null
  currentScore: number | null
  retryCount: number
  costUsd: number
  logLines: string[]
  isRunning: boolean
}

interface AgentActions {
  handleLoopEvent: (event: LoopEvent) => void
  startTask: (taskId: string) => void
  reset: () => void
}

const INITIAL_STATE: AgentState = {
  activeTaskId: null,
  currentPhase: null,
  currentScore: null,
  retryCount: 0,
  costUsd: 0,
  logLines: [],
  isRunning: false,
}

export const useAgentStore = create<AgentState & AgentActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL_STATE,

    handleLoopEvent: (event: LoopEvent) =>
      set((state) => {
        const timestamp = new Date(event.timestamp).toLocaleTimeString()
        const logLine = `[${timestamp}] [${event.phase.toUpperCase()}] ${event.message}`
        return {
          activeTaskId: event.taskId,
          currentPhase: event.phase,
          currentScore: event.score ?? state.currentScore,
          retryCount: event.retryCount,
          costUsd: event.costUsd ?? state.costUsd,
          logLines: [...state.logLines, logLine],
          isRunning: event.phase !== 'success' && event.phase !== 'failed',
        }
      }),

    startTask: (taskId: string) =>
      set({ ...INITIAL_STATE, activeTaskId: taskId, isRunning: true }),

    reset: () => set(INITIAL_STATE),
  })),
)

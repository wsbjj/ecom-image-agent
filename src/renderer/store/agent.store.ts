import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { LoopEvent, ContextUsageSnapshot } from '../../shared/types'

export interface RoundPreviewItem {
  roundIndex: number
  generatedImagePath: string
  previewImagePath: string
  score: number | null
  timestamp: number
}

interface AgentState {
  activeTaskId: string | null
  currentPhase: LoopEvent['phase'] | null
  currentScore: number | null
  retryCount: number
  costUsd: number
  contextUsage: ContextUsageSnapshot | null
  roundPreviews: RoundPreviewItem[]
  logLines: string[]
  isRunning: boolean
}

interface AgentActions {
  handleLoopEvent: (event: LoopEvent) => void
  startTask: (taskId: string) => void
  reset: () => void
  setRoundPreviews: (items: RoundPreviewItem[]) => void
  setContextUsage: (usage: ContextUsageSnapshot | null) => void
}

const INITIAL_STATE: AgentState = {
  activeTaskId: null,
  currentPhase: null,
  currentScore: null,
  retryCount: 0,
  costUsd: 0,
  contextUsage: null,
  roundPreviews: [],
  logLines: [],
  isRunning: false,
}

function upsertRoundPreview(
  current: RoundPreviewItem[],
  incoming: RoundPreviewItem,
): RoundPreviewItem[] {
  const next = [...current]
  const idx = next.findIndex((item) => item.roundIndex === incoming.roundIndex)
  if (idx >= 0) {
    next[idx] = {
      ...next[idx],
      ...incoming,
    }
  } else {
    next.push(incoming)
  }
  return next.sort((a, b) => a.roundIndex - b.roundIndex)
}

export const useAgentStore = create<AgentState & AgentActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL_STATE,

    handleLoopEvent: (event: LoopEvent) =>
      set((state) => {
        const timestamp = new Date(event.timestamp).toLocaleTimeString()
        const logLine = `[${timestamp}] [${event.phase.toUpperCase()}] [第 ${event.roundIndex + 1} 轮] ${event.message}`

        let roundPreviews = state.roundPreviews
        const generatedImagePath = event.generatedImagePath?.trim()
        const previewImagePath = event.previewImagePath?.trim() || generatedImagePath
        if (generatedImagePath && previewImagePath) {
          roundPreviews = upsertRoundPreview(state.roundPreviews, {
            roundIndex: event.roundIndex,
            generatedImagePath,
            previewImagePath,
            score: event.score ?? state.currentScore,
            timestamp: event.timestamp,
          })
        }

        return {
          activeTaskId: event.taskId,
          currentPhase: event.phase,
          currentScore: event.score ?? state.currentScore,
          retryCount: event.retryCount,
          costUsd: event.costUsd ?? state.costUsd,
          contextUsage: event.contextUsage ?? state.contextUsage,
          roundPreviews,
          logLines: [...state.logLines, logLine],
          isRunning: event.phase !== 'success' && event.phase !== 'failed',
        }
      }),

    setRoundPreviews: (items: RoundPreviewItem[]) =>
      set((state) => ({
        ...state,
        roundPreviews: [...items].sort((a, b) => a.roundIndex - b.roundIndex),
      })),

    setContextUsage: (usage: ContextUsageSnapshot | null) =>
      set((state) => ({
        ...state,
        contextUsage: usage,
      })),

    startTask: (taskId: string) => set({ ...INITIAL_STATE, activeTaskId: taskId, isRunning: true }),

    reset: () => set(INITIAL_STATE),
  })),
)

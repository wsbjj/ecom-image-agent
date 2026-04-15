import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTaskStore } from '../../../src/renderer/store/task.store'
import { useAgentStore } from '../../../src/renderer/store/agent.store'
import type { LoopEvent } from '../../../src/shared/types'

describe('useTaskStore', () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasks: [],
      isLoading: false,
      filter: 'all',
    })
  })

  it('should have initial state', () => {
    const state = useTaskStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.filter).toBe('all')
  })

  it('should update filter', () => {
    useTaskStore.getState().setFilter('success')
    expect(useTaskStore.getState().filter).toBe('success')
  })

  it('should fetch tasks from api', async () => {
    const mockTasks = [
      {
        id: 1,
        task_id: 'task-1',
        sku_id: 'SKU001',
        product_name: 'Test Product',
        retry_count: 0,
        total_score: null,
        defect_analysis: null,
        status: 'pending' as const,
        image_path: null,
        prompt_used: null,
        cost_usd: null,
        product_images: null,
        reference_images: null,
        created_at: '2026-04-14T10:00:00Z',
        updated_at: null,
      },
    ]
    vi.mocked(window.api.queryTasks).mockResolvedValueOnce(mockTasks)

    await useTaskStore.getState().fetchTasks()
    expect(useTaskStore.getState().tasks).toEqual(mockTasks)
    expect(useTaskStore.getState().isLoading).toBe(false)
  })
})

describe('useAgentStore', () => {
  beforeEach(() => {
    useAgentStore.getState().reset()
  })

  it('should have initial state', () => {
    const state = useAgentStore.getState()
    expect(state.activeTaskId).toBeNull()
    expect(state.currentPhase).toBeNull()
    expect(state.currentScore).toBeNull()
    expect(state.isRunning).toBe(false)
    expect(state.logLines).toEqual([])
  })

  it('should start task', () => {
    useAgentStore.getState().startTask('task-123')
    const state = useAgentStore.getState()
    expect(state.activeTaskId).toBe('task-123')
    expect(state.isRunning).toBe(true)
  })

  it('should handle loop events', () => {
    const event: LoopEvent = {
      taskId: 'task-123',
      phase: 'thought',
      message: '开始推理',
      retryCount: 0,
      roundIndex: 0,
      timestamp: Date.now(),
    }
    useAgentStore.getState().handleLoopEvent(event)
    const state = useAgentStore.getState()
    expect(state.currentPhase).toBe('thought')
    expect(state.activeTaskId).toBe('task-123')
    expect(state.isRunning).toBe(true)
    expect(state.logLines).toHaveLength(1)
  })

  it('should mark isRunning=false on success', () => {
    useAgentStore.getState().startTask('task-123')
    useAgentStore.getState().handleLoopEvent({
      taskId: 'task-123',
      phase: 'success',
      message: '任务成功',
      score: 92,
      retryCount: 1,
      roundIndex: 1,
      costUsd: 0.05,
      timestamp: Date.now(),
    })
    const state = useAgentStore.getState()
    expect(state.isRunning).toBe(false)
    expect(state.currentScore).toBe(92)
    expect(state.costUsd).toBe(0.05)
  })

  it('should mark isRunning=false on failure', () => {
    useAgentStore.getState().startTask('task-123')
    useAgentStore.getState().handleLoopEvent({
      taskId: 'task-123',
      phase: 'failed',
      message: '任务失败',
      retryCount: 3,
      roundIndex: 3,
      timestamp: Date.now(),
    })
    expect(useAgentStore.getState().isRunning).toBe(false)
  })

  it('should accumulate log lines', () => {
    const events: LoopEvent[] = [
      { taskId: 't', phase: 'thought', message: 'msg1', retryCount: 0, roundIndex: 0, timestamp: 1 },
      { taskId: 't', phase: 'act', message: 'msg2', retryCount: 0, roundIndex: 0, timestamp: 2 },
      { taskId: 't', phase: 'observe', message: 'msg3', retryCount: 0, roundIndex: 0, timestamp: 3 },
    ]
    events.forEach((e) => useAgentStore.getState().handleLoopEvent(e))
    expect(useAgentStore.getState().logLines).toHaveLength(3)
  })

  it('should reset state', () => {
    useAgentStore.getState().startTask('task-123')
    useAgentStore.getState().handleLoopEvent({
      taskId: 'task-123',
      phase: 'thought',
      message: 'test',
      retryCount: 0,
      roundIndex: 0,
      timestamp: Date.now(),
    })
    useAgentStore.getState().reset()
    const state = useAgentStore.getState()
    expect(state.activeTaskId).toBeNull()
    expect(state.logLines).toEqual([])
    expect(state.isRunning).toBe(false)
  })
})

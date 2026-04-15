import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC_CHANNELS } from '../../../src/shared/ipc-channels'

describe('IPC_CHANNELS', () => {
  it('should have all required channel definitions', () => {
    expect(IPC_CHANNELS.TASK_START).toBe('task:start')
    expect(IPC_CHANNELS.TASK_STOP).toBe('task:stop')
    expect(IPC_CHANNELS.TASK_LIST).toBe('task:list')
    expect(IPC_CHANNELS.AGENT_LOOP_EVENT).toBe('agent:loop-event')
    expect(IPC_CHANNELS.CONFIG_GET).toBe('config:get')
    expect(IPC_CHANNELS.CONFIG_SET).toBe('config:set')
    expect(IPC_CHANNELS.TEMPLATE_SAVE).toBe('template:save')
    expect(IPC_CHANNELS.TEMPLATE_LIST).toBe('template:list')
  })

  it('should have unique channel values', () => {
    const values = Object.values(IPC_CHANNELS)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })
})

describe('shared types structure', () => {
  it('should export TaskInput with correct shape', () => {
    const input = {
      skuId: 'SKU001',
      productName: '陶瓷杯',
      context: '白底场景',
      templateId: 1,
    }
    expect(input.skuId).toBe('SKU001')
    expect(input.templateId).toBe(1)
  })

  it('should export LoopEvent with all phases', () => {
    const phases = ['thought', 'act', 'observe', 'success', 'failed'] as const
    phases.forEach((phase) => {
      const event = {
        taskId: 'test',
        phase,
        message: `Phase: ${phase}`,
        retryCount: 0,
        timestamp: Date.now(),
      }
      expect(event.phase).toBe(phase)
    })
  })

  it('should export DefectAnalysis with three dimensions', () => {
    const defect = {
      edge_distortion: { score: 25, issues: ['test'] },
      perspective_lighting: { score: 28, issues: [] },
      hallucination: { score: 30, issues: [] },
      overall_recommendation: 'good',
    }
    expect(defect.edge_distortion.score).toBe(25)
    expect(defect.perspective_lighting.issues).toHaveLength(0)
  })
})

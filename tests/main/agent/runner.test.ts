import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSystemPrompt } from '../../../src/main/agent/prompt-builder'
import type { DefectAnalysis } from '../../../src/shared/types'

describe('buildSystemPrompt', () => {
  const baseInput = {
    productName: '北欧陶瓷杯',
    context: '侧逆光极简白底场景',
    retryCount: 0,
  }

  it('should return base prompt without defect section on first run', () => {
    const prompt = buildSystemPrompt(baseInput)
    expect(prompt).toContain('北欧陶瓷杯')
    expect(prompt).toContain('侧逆光极简白底场景')
    expect(prompt).toContain('generate_image')
    expect(prompt).toContain('evaluate_image')
    expect(prompt).not.toContain('上一轮缺陷分析')
  })

  it('should include defect analysis on retry', () => {
    const defects: DefectAnalysis = {
      edge_distortion: { score: 20, issues: ['边缘模糊'] },
      perspective_lighting: { score: 25, issues: ['光影方向不一致'] },
      hallucination: { score: 28, issues: [] },
      overall_recommendation: '建议增加边缘清晰度',
    }
    const prompt = buildSystemPrompt({
      ...baseInput,
      retryCount: 1,
      defectAnalysis: defects,
    })
    expect(prompt).toContain('上一轮缺陷分析')
    expect(prompt).toContain('边缘模糊')
    expect(prompt).toContain('光影方向不一致')
    expect(prompt).toContain('建议增加边缘清晰度')
    expect(prompt).toContain('得分 20/30')
  })

  it('should show "无问题" when issues array is empty', () => {
    const defects: DefectAnalysis = {
      edge_distortion: { score: 30, issues: [] },
      perspective_lighting: { score: 30, issues: [] },
      hallucination: { score: 30, issues: [] },
      overall_recommendation: '完美',
    }
    const prompt = buildSystemPrompt({
      ...baseInput,
      retryCount: 1,
      defectAnalysis: defects,
    })
    expect(prompt).toContain('无问题')
  })
})

describe('runner abort behavior', () => {
  it('should respect AbortSignal', () => {
    const controller = new AbortController()
    expect(controller.signal.aborted).toBe(false)
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
  })

  it('should track multiple controllers by taskId', () => {
    const controllers = new Map<string, AbortController>()
    const c1 = new AbortController()
    const c2 = new AbortController()
    controllers.set('task-1', c1)
    controllers.set('task-2', c2)

    controllers.get('task-1')?.abort()
    expect(c1.signal.aborted).toBe(true)
    expect(c2.signal.aborted).toBe(false)

    controllers.delete('task-1')
    expect(controllers.size).toBe(1)
  })
})

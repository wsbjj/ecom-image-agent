import { describe, expect, it } from 'vitest'
import { buildEnforcedGenerationPrompt } from '../../../src/main/agent/enforced-generation-prompt'
import type { DefectAnalysis } from '../../../src/shared/types'

describe('buildEnforcedGenerationPrompt', () => {
  it('always keeps initial product/context/user requirements', () => {
    const prompt = buildEnforcedGenerationPrompt({
      productName: 'Liquid Bottle',
      context: 'warm studio lighting',
      userPrompt: 'Keep amber glass color exactly the same',
      modelPrompt: 'add soft shadows and realistic reflections',
      roundIndex: 0,
      defectAnalysis: null,
    })

    expect(prompt).toContain('Liquid Bottle')
    expect(prompt).toContain('warm studio lighting')
    expect(prompt).toContain('Keep amber glass color exactly the same')
    expect(prompt).toContain('add soft shadows and realistic reflections')
  })

  it('injects previous round fix hints when available', () => {
    const defectAnalysis: DefectAnalysis = {
      dimensions: [
        {
          key: 'edge',
          name: 'Edge Quality',
          score: 10,
          maxScore: 20,
          issues: ['blurry label edges', 'floating bottle shadow'],
        },
      ],
      overall_recommendation: 'Increase edge sharpness and ground contact realism',
    }

    const prompt = buildEnforcedGenerationPrompt({
      productName: 'Liquid Bottle',
      context: 'warm studio lighting',
      userPrompt: 'Keep amber glass color exactly the same',
      modelPrompt: 'focus on cleaner highlights',
      roundIndex: 2,
      defectAnalysis,
    })

    expect(prompt).toContain('blurry label edges')
    expect(prompt).toContain('floating bottle shadow')
    expect(prompt).toContain('Increase edge sharpness')
  })
})

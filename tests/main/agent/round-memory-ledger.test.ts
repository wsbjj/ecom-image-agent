import { describe, it, expect } from 'vitest'
import { RoundMemoryLedger } from '../../../src/main/agent/round-memory-ledger'

function createLedger() {
  return new RoundMemoryLedger({
    retentionRatio: 0.3,
    thresholds: {
      soft: 70,
      hard: 85,
      critical: 92,
    },
  })
}

describe('RoundMemoryLedger', () => {
  it('keeps recent ceil(total * ratio) rounds in full memory', () => {
    const ledger = createLedger()

    for (let i = 0; i < 10; i += 1) {
      ledger.addEntry({
        roundIndex: i,
        promptSummary: `prompt-${i}`,
        actionSummary: `action-${i}`,
        score: 80 + i,
        keywords: [`k${i}`],
        generatedImagePath: `/tmp/${i}.png`,
        defectAnalysis: {
          dimensions: [
            {
              key: 'edge_distortion',
              name: '边缘畸变',
              score: 20,
              maxScore: 30,
              issues: ['issue'],
            },
          ],
          overall_recommendation: 'fix',
        },
      })
    }

    expect(ledger.getKeepRoundIndexes()).toEqual([7, 8, 9])
  })

  it('applies compression levels by context usage thresholds', () => {
    const ledger = createLedger()

    expect(ledger.updateCompressionByUsage(60)).toBe('none')
    expect(ledger.updateCompressionByUsage(70)).toBe('soft')
    expect(ledger.updateCompressionByUsage(85)).toBe('hard')
    expect(ledger.updateCompressionByUsage(92)).toBe('critical')
  })

  it('builds compressed history and full recent memory blocks', () => {
    const ledger = createLedger()

    for (let i = 0; i < 4; i += 1) {
      ledger.addEntry({
        roundIndex: i,
        promptSummary: `summary-${i}`,
        actionSummary: `action-${i}`,
        score: 90,
        keywords: [`kw-${i}`],
        generatedImagePath: `/tmp/${i}.png`,
        defectAnalysis: {
          dimensions: [],
          overall_recommendation: `recommend-${i}`,
        },
      })
    }

    const softBlock = ledger.buildMemoryPromptBlock()
    expect(softBlock).toContain('历史轮次结构化摘要（已压缩）')
    expect(softBlock).toContain('最近轮次记忆（保留全文）')
    expect(softBlock).toContain('recommend-0')

    ledger.updateCompressionByUsage(95)
    const criticalBlock = ledger.buildMemoryPromptBlock()
    expect(criticalBlock).toContain('关键词')
    expect(criticalBlock).not.toContain('综合建议')
  })
})

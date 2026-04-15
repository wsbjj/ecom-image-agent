import type { DefectAnalysis } from '../../shared/types'

export type CompressionLevel = 'none' | 'soft' | 'hard' | 'critical'

export interface RoundMemoryEntry {
  roundIndex: number
  promptSummary: string
  actionSummary: string
  score: number | null
  defectAnalysis?: DefectAnalysis
  keywords: string[]
  generatedImagePath: string
  contextThumbPath?: string | null
}

interface Thresholds {
  soft: number
  hard: number
  critical: number
}

interface MemoryLedgerOptions {
  retentionRatio: number
  thresholds: Thresholds
}

export class RoundMemoryLedger {
  private readonly retentionRatio: number
  private readonly thresholds: Thresholds
  private readonly entries: RoundMemoryEntry[] = []
  private compressionLevel: CompressionLevel = 'none'

  constructor(options: MemoryLedgerOptions) {
    this.retentionRatio = Math.min(0.9, Math.max(0.1, options.retentionRatio))
    this.thresholds = {
      soft: Math.min(100, Math.max(1, options.thresholds.soft)),
      hard: Math.min(100, Math.max(1, options.thresholds.hard)),
      critical: Math.min(100, Math.max(1, options.thresholds.critical)),
    }
  }

  addEntry(entry: RoundMemoryEntry): void {
    this.entries.push(entry)
  }

  getEntries(): RoundMemoryEntry[] {
    return [...this.entries]
  }

  getKeepRoundIndexes(): number[] {
    const keepCount = Math.max(1, Math.ceil(this.entries.length * this.retentionRatio))
    return this.entries.slice(-keepCount).map((entry) => entry.roundIndex)
  }

  getCompressionLevel(): CompressionLevel {
    return this.compressionLevel
  }

  updateCompressionByUsage(percentage: number): CompressionLevel {
    if (percentage >= this.thresholds.critical) {
      this.compressionLevel = 'critical'
    } else if (percentage >= this.thresholds.hard) {
      this.compressionLevel = 'hard'
    } else if (percentage >= this.thresholds.soft) {
      this.compressionLevel = 'soft'
    } else {
      this.compressionLevel = 'none'
    }
    return this.compressionLevel
  }

  buildMemoryPromptBlock(): string {
    if (this.entries.length === 0) {
      return ''
    }

    const keepSet = new Set(this.getKeepRoundIndexes())
    const oldEntries = this.entries.filter((entry) => !keepSet.has(entry.roundIndex))
    const recentEntries = this.entries.filter((entry) => keepSet.has(entry.roundIndex))

    const oldBlock = oldEntries
      .map((entry) => {
        const base = `- 第 ${entry.roundIndex + 1} 轮：score=${entry.score ?? '--'}，关键词=${entry.keywords.join('、') || '无'}，摘要=${entry.promptSummary}`
        if (this.compressionLevel === 'critical') {
          return base
        }
        if (this.compressionLevel === 'hard') {
          return `${base}，动作=${entry.actionSummary}`
        }
        return `${base}，动作=${entry.actionSummary}，建议=${entry.defectAnalysis?.overall_recommendation ?? '无'}`
      })
      .join('\n')

    const recentBlock = recentEntries
      .map((entry) => {
        const base = `### 第 ${entry.roundIndex + 1} 轮（score=${entry.score ?? '--'}）\n- prompt摘要：${entry.promptSummary}\n- 动作摘要：${entry.actionSummary}`
        if (this.compressionLevel === 'critical') {
          return `${base}\n- 关键词：${entry.keywords.join('、') || '无'}`
        }
        return `${base}\n- 关键词：${entry.keywords.join('、') || '无'}\n- 综合建议：${entry.defectAnalysis?.overall_recommendation ?? '无'}`
      })
      .join('\n\n')

    const oldSection = oldBlock
      ? `## 历史轮次结构化摘要（已压缩）\n${oldBlock}`
      : '## 历史轮次结构化摘要（已压缩）\n- 无'

    return `${oldSection}\n\n## 最近轮次记忆（保留全文）\n${recentBlock}`
  }
}

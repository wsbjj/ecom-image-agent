import type { BrowserWindow } from 'electron'
import type { TaskInput, EvalRubric, EvaluationTemplateRecord } from '../../../shared/types'
import type { ImageProvider } from '../providers/base'
import type { VLMEvalBridge } from '../vlmeval-bridge'

export interface EngineRuntimeOptions {
  provider: ImageProvider
  providerPreflightEnabled?: boolean
  anthropicApiKey: string
  anthropicBaseUrl?: string
  anthropicModel?: string
  codexApiKey?: string
  codexBaseUrl?: string
  codexModel?: string
  maxRetries: number
  scoreThreshold: number
  evaluationTemplate: EvaluationTemplateRecord
  evaluationRubric: EvalRubric
  retentionRatio: number
  compressionThresholdSoft: number
  compressionThresholdHard: number
  compressionThresholdCritical: number
}

export interface AgentEngine {
  readonly name: 'legacy' | 'claude_sdk' | 'codex_sdk'
  run(
    input: TaskInput,
    win: BrowserWindow,
    vlmBridge: VLMEvalBridge,
    signal: AbortSignal,
    options: EngineRuntimeOptions,
  ): Promise<void>
}

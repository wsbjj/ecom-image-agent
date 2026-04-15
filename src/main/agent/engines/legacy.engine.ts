import type { AgentEngine, EngineRuntimeOptions } from './types'
import type { TaskInput } from '../../../shared/types'
import type { BrowserWindow } from 'electron'
import type { VLMEvalBridge } from '../vlmeval-bridge'
import { runLegacyAgentLoop } from '../runner'

export class LegacyAgentEngine implements AgentEngine {
  readonly name = 'legacy' as const

  async run(
    input: TaskInput,
    win: BrowserWindow,
    vlmBridge: VLMEvalBridge,
    signal: AbortSignal,
    options: EngineRuntimeOptions,
  ): Promise<void> {
    await runLegacyAgentLoop(input, win, vlmBridge, signal, {
      provider: options.provider,
      anthropicApiKey: options.anthropicApiKey,
      anthropicBaseUrl: options.anthropicBaseUrl,
      anthropicModel: options.anthropicModel,
      maxRetries: options.maxRetries,
      scoreThreshold: options.scoreThreshold,
      evaluationRubric: options.evaluationRubric,
    })
  }
}

import type { AgentEngine } from './types'
import { LegacyAgentEngine } from './legacy.engine'
import { ClaudeSdkAgentEngine } from './claude-sdk.engine'
import { CodexSdkAgentEngine } from './codex-sdk.engine'
import type { AgentEngineName } from '../../../shared/types'

export function createAgentEngine(engineName: AgentEngineName): AgentEngine {
  if (engineName === 'legacy') {
    return new LegacyAgentEngine()
  }
  if (engineName === 'codex_sdk') {
    return new CodexSdkAgentEngine()
  }
  return new ClaudeSdkAgentEngine()
}

import { app, type BrowserWindow } from 'electron'
import {
  createSdkMcpServer,
  query,
  tool,
  type Query as SDKQuery,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import type { DefectAnalysis, LoopEvent, TaskInput } from '../../../shared/types'
import { buildSystemPrompt } from '../prompt-builder'
import { createMcpServer } from '../mcp-server'
import type { VLMEvalBridge } from '../vlmeval-bridge'
import {
  insertTaskRoundArtifact,
  updateTaskFailed,
  updateTaskRoundArtifactScore,
  updateTaskSuccess,
} from '../../db/queries'
import { persistRoundArtifacts, pruneRoundOriginalCache, type RoundImageArtifacts } from '../round-image-cache'
import type { AgentEngine, EngineRuntimeOptions } from './types'
import { buildEnforcedGenerationPrompt, buildFallbackDraftPrompt } from '../enforced-generation-prompt'
import { formatAuthFailureDetail, parseAuthFailure, type ParsedAuthFailure } from '../auth-error-utils'
import {
  formatModelCapabilityFailureDetail,
  parseModelCapabilityFailure,
  type ParsedModelCapabilityFailure,
} from '../nonretriable-error-utils'

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_ORIGINAL_ROUNDS = 12
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_MAX_TURNS = 8
const TRANSPORT_NOT_READY_PATTERN = /processtransport is not ready for writing/i
const EVALUATE_TIMEOUT_PATTERN = /vlmeval evaluation timeout/i

type RoundFailureType =
  | 'no_generate'
  | 'no_evaluate'
  | 'permission_denied'
  | 'max_turns'
  | 'query_error'
  | 'result_error'

interface ResultDiagnostics {
  failureTypes: RoundFailureType[]
  detail: string
}

interface RoundFailureDiagnosticsInput {
  generatedImagePath: string | null
  roundEvalScore: number | null
  queryError: string | null
  resultDiagnostics: ResultDiagnostics | null
  evaluateTimeoutInRound: boolean
  evaluateErrorMessage: string | null
}

interface ActiveRoundState {
  roundIndex: number
  retryCount: number
  generatedImagePath: string | null
  previewImagePath: string | null
  contextThumbPath: string | null
  roundEvalScore: number | null
  roundDefect: DefectAnalysis | null
  resultMessage: SDKResultMessage | null
  queryError: string | null
  evaluateTimeoutInRound: boolean
  evaluateErrorMessage: string | null
  suppressAutoEvaluateFallback: boolean
  autoEvaluateFallbackSkipReason: string | null
  ignorePostInterruptSdkFailures: boolean
  localRoundTerminationReason: string | null
}

interface CompressionThresholds {
  soft: number
  hard: number
  critical: number
}

type CompressionMode = 'none' | 'soft' | 'hard' | 'critical'
type PushEventFn = (event: LoopEvent) => void

function normalizeFailureTypes(types: Iterable<RoundFailureType>): RoundFailureType[] {
  return Array.from(new Set(types))
}

function buildRoundFailureDiagnostics(input: RoundFailureDiagnosticsInput): {
  failureTypes: RoundFailureType[]
  detail: string
} {
  const failureTypes = new Set<RoundFailureType>()
  if (!input.generatedImagePath) {
    failureTypes.add('no_generate')
  }
  if (input.generatedImagePath && input.roundEvalScore === null) {
    failureTypes.add('no_evaluate')
  }
  if (input.queryError) {
    failureTypes.add('query_error')
  }
  if (input.resultDiagnostics) {
    for (const failureType of input.resultDiagnostics.failureTypes) {
      failureTypes.add(failureType)
    }
  }

  const normalizedFailureTypes = normalizeFailureTypes(failureTypes)
  const detailParts = [
    `failure_types=${normalizedFailureTypes.join(',') || 'unknown'}`,
    `query_error=${input.queryError ?? 'none'}`,
    `evaluate_timeout_in_round=${input.evaluateTimeoutInRound ? 'yes' : 'no'}`,
    `evaluate_error=${input.evaluateErrorMessage ?? 'none'}`,
  ]
  if (input.resultDiagnostics) {
    detailParts.push(input.resultDiagnostics.detail)
  }
  return {
    failureTypes: normalizedFailureTypes,
    detail: detailParts.join(', '),
  }
}

function buildAttemptSummary(roundsAttempted: number, maxRetries: number): string {
  const maxRounds = maxRetries + 1
  return `${roundsAttempted}/${maxRounds}`
}

function createUserMessageStream(message: string): AsyncIterable<SDKUserMessage> {
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: message,
      },
      parent_tool_use_id: null,
    }
  })()
}

function normalizeIssueList(defectAnalysis?: DefectAnalysis | null, limit = 4): string[] {
  if (!defectAnalysis || !Array.isArray(defectAnalysis.dimensions)) {
    return []
  }
  return defectAnalysis.dimensions
    .flatMap((dimension) => dimension.issues.slice(0, 2))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, limit)
}

function createActiveRoundState(roundIndex: number, retryCount: number): ActiveRoundState {
  return {
    roundIndex,
    retryCount,
    generatedImagePath: null,
    previewImagePath: null,
    contextThumbPath: null,
    roundEvalScore: null,
    roundDefect: null,
    resultMessage: null,
    queryError: null,
    evaluateTimeoutInRound: false,
    evaluateErrorMessage: null,
    suppressAutoEvaluateFallback: false,
    autoEvaluateFallbackSkipReason: null,
    ignorePostInterruptSdkFailures: false,
    localRoundTerminationReason: null,
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransportNotReadyError(error: unknown): boolean {
  const raw = toErrorMessage(error).trim()
  if (!raw) return false
  return TRANSPORT_NOT_READY_PATTERN.test(raw)
}

function isEvaluateTimeoutError(error: unknown): boolean {
  const raw = toErrorMessage(error).trim()
  if (!raw) return false
  return EVALUATE_TIMEOUT_PATTERN.test(raw)
}

function normalizeImagePaths(paths: string[]): string[] {
  return paths
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function extractSdkModelId(item: unknown): string {
  if (typeof item === 'string') {
    return item.trim()
  }
  if (typeof item === 'object' && item !== null) {
    const id = (item as { id?: unknown }).id
    if (typeof id === 'string') {
      return id.trim()
    }
  }
  return ''
}

function pickCompressionMode(usagePercentage: number, thresholds: CompressionThresholds): CompressionMode {
  if (usagePercentage >= thresholds.critical) return 'critical'
  if (usagePercentage >= thresholds.hard) return 'hard'
  if (usagePercentage >= thresholds.soft) return 'soft'
  return 'none'
}

function buildRoundUserInstruction(params: {
  input: TaskInput
  roundIndex: number
  scoreThreshold: number
  defectAnalysis: DefectAnalysis | null
  productImageCount: number
  compressionMode: CompressionMode
}): string {
  const issueHints = normalizeIssueList(params.defectAnalysis)
  const recommendation = params.defectAnalysis?.overall_recommendation?.trim() ?? ''
  const issueBlock =
    params.roundIndex > 0 && issueHints.length > 0
      ? `\nFocus fixes from previous round:\n- ${issueHints.join('\n- ')}${recommendation ? `\n- Overall recommendation: ${recommendation}` : ''}`
      : ''

  const compressionHint =
    params.compressionMode === 'critical'
      ? '\nContext pressure is CRITICAL. Keep reasoning extremely concise, avoid history recap, and call tools immediately.'
      : params.compressionMode === 'hard'
        ? '\nContext pressure is HIGH. Keep response concise and avoid restating prior rounds.'
        : params.compressionMode === 'soft'
          ? '\nContext usage is rising. Keep this round concise.'
          : ''

  const productImageHint =
    params.productImageCount > 0
      ? `\nUse ${params.productImageCount} product images when calling generate_image.`
      : ''

  return (
    `Round ${params.roundIndex + 1}: generate an e-commerce image for product=${params.input.productName}, scene=${params.input.context}, sku=${params.input.skuId}.` +
    productImageHint +
    issueBlock +
    compressionHint +
    `\nTarget pass threshold is ${params.scoreThreshold}.` +
    '\nYou must call generate_image first, then call evaluate_image. Do not end at text output only.'
  )
}

function collectAuthFailureFromResult(
  message: SDKResultMessage,
  providerHint?: string,
): ParsedAuthFailure | null {
  const errors = (message as { errors?: string[] }).errors
  if (!Array.isArray(errors)) {
    return null
  }
  for (const err of errors) {
    const parsed = parseAuthFailure(err, { providerHint })
    if (parsed) {
      return parsed
    }
  }
  return null
}

function hasCodingPlanModelUnavailableError(parsed: ParsedAuthFailure): boolean {
  const raw = parsed.raw.trim().toLowerCase()
  return raw.includes('not available in your coding plan')
}

function rankAnthropicModel(modelId: string): number {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.includes('sonnet')) return 0
  if (normalized.includes('opus')) return 1
  if (normalized.includes('haiku')) return 2
  return 3
}

function pickAvailableAnthropicModel(
  currentModel: string,
  availableModelIds: string[],
  excluded: Set<string>,
): string | null {
  const current = currentModel.trim()
  const candidates = availableModelIds
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => item !== current)
    .filter((item) => !excluded.has(item))
    .sort((a, b) => rankAnthropicModel(a) - rankAnthropicModel(b))

  if (candidates.length === 0) return null
  return candidates[0]
}

function collectModelCapabilityFailureFromResult(
  message: SDKResultMessage,
  providerHint: string,
  tool: string | null,
): ParsedModelCapabilityFailure | null {
  const errors = (message as { errors?: string[] }).errors
  if (!Array.isArray(errors)) {
    return null
  }
  for (const err of errors) {
    const parsed = parseModelCapabilityFailure(err, { providerHint, tool })
    if (parsed) {
      return parsed
    }
  }
  return null
}

export class ClaudeSdkAgentEngine implements AgentEngine {
  readonly name = 'claude_sdk' as const

  async run(
    input: TaskInput,
    win: BrowserWindow,
    vlmBridge: VLMEvalBridge,
    signal: AbortSignal,
    options: EngineRuntimeOptions,
  ): Promise<void> {
    const taskId = input.taskId ?? 'unknown-task'
    const readyDir = path.join(app.getPath('userData'), 'ready_to_publish')
    const failedDir = path.join(app.getPath('userData'), 'failed')
    await fs.mkdir(readyDir, { recursive: true })
    await fs.mkdir(failedDir, { recursive: true })

    const isolatedProjectDir = path.join(app.getPath('userData'), 'claude_sdk_task_projects', taskId)
    await fs.mkdir(path.join(isolatedProjectDir, '.claude'), { recursive: true })

    const pushEvent: PushEventFn = (event) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, event)
      }
    }

    const mcpServer = await createMcpServer(vlmBridge, options.provider)
    const productImagePaths = normalizeImagePaths(input.productImages.map((img) => img.path))
    const referenceImagePaths = input.referenceImages
      ? normalizeImagePaths(input.referenceImages.map((img) => img.path))
      : undefined
    const productImageAngles = input.productImages
      .map((img) => img.angle)
      .filter((item): item is string => Boolean(item))

    const compressionThresholds: CompressionThresholds = {
      soft: options.compressionThresholdSoft,
      hard: options.compressionThresholdHard,
      critical: options.compressionThresholdCritical,
    }

    const baseSystemPrompt = buildSystemPrompt({
      productName: input.productName,
      context: input.context,
      retryCount: 0,
      scoreThreshold: options.scoreThreshold,
      productImageAngles: productImageAngles.length > 0 ? productImageAngles : undefined,
      userPrompt: input.userPrompt,
      rubricDimensions: options.evaluationRubric.dimensions,
    })

    let retryCount = 0
    let roundsAttempted = 0
    let lastDefectAnalysis: DefectAnalysis | null = null
    let lastImagePath: string | null = null
    let totalCostUsd = 0
    let terminalFailureReason: string | null = null
    let latestContextUsagePercentage = 0

    const retainedRoundIndexes: number[] = []
    let streamFailureReason: string | null = null
    let roundToolAuthFailure: ParsedAuthFailure | null = null
    let roundToolModelCapabilityFailure: ParsedModelCapabilityFailure | null = null
    let activeRoundState: ActiveRoundState | null = null
    let queryInstance: SDKQuery | null = null
    let queryPump: Promise<void> | null = null
    let querySessionId = 0
    let queryBootstrapDone = false
    let currentAnthropicModel = options.anthropicModel ?? DEFAULT_MODEL
    let availableAnthropicModels: string[] = []
    const attemptedAnthropicModels = new Set<string>([currentAnthropicModel])
    let pendingRoundResult:
      | {
          roundIndex: number
          sessionId: number
          resolve: (message: SDKResultMessage) => void
          reject: (error: Error) => void
        }
      | null = null

    const interruptCurrentQuery = (): void => {
      if (!queryInstance) return
      void queryInstance.interrupt().catch(() => {
        // Ignore interrupt errors.
      })
    }

    const mcpServerName = `ecom-mcp-${taskId}`
    const allowedTools = [`mcp__${mcpServerName}__generate_image`, `mcp__${mcpServerName}__evaluate_image`]

    const sdkMcpServer = createSdkMcpServer({
      name: mcpServerName,
      tools: [
        tool(
          'generate_image',
          'Call image generation API and return local absolute file path',
          {
            prompt: z.string(),
            style: z.string().optional(),
            aspect_ratio: z.enum(['1:1', '4:3', '16:9']).optional(),
            product_image_paths: z.array(z.string()).optional(),
            reference_image_paths: z.array(z.string()).optional(),
          },
          async (args) => {
            if (!activeRoundState) {
              return {
                content: [{ type: 'text', text: 'Error: no active round context for generate_image.' }],
                isError: true,
              }
            }

            const roundIndex = activeRoundState.roundIndex
            const retryRound = activeRoundState.retryCount
            if (activeRoundState.generatedImagePath) {
              const detail =
                'generate_image was called again after an image had already been generated in this round.'
              activeRoundState.suppressAutoEvaluateFallback = true
              activeRoundState.autoEvaluateFallbackSkipReason = detail
              activeRoundState.ignorePostInterruptSdkFailures = true
              activeRoundState.localRoundTerminationReason = detail
              pushEvent({
                taskId,
                phase: 'observe',
                message: `Repeated generate_image call detected; ending current round. ${detail}`,
                retryCount: retryRound,
                roundIndex,
                timestamp: Date.now(),
              })
              interruptCurrentQuery()
              throw new Error(detail)
            }

            const enforcedPrompt = buildEnforcedGenerationPrompt({
              productName: input.productName,
              context: input.context,
              userPrompt: input.userPrompt,
              modelPrompt: args.prompt,
              defectAnalysis: lastDefectAnalysis,
              roundIndex,
            })
            const normalizedArgs = {
              ...args,
              prompt: enforcedPrompt,
            }

            pushEvent({
              taskId,
              phase: 'act',
              message: `generate_image args=${JSON.stringify(normalizedArgs)}`,
              retryCount: retryRound,
              roundIndex,
              timestamp: Date.now(),
            })

            let result: {
              image_path: string
              prompt_used: string
            }
            try {
              result = (await mcpServer.callTool('generate_image', {
                ...normalizedArgs,
                product_image_paths: productImagePaths,
                ...(referenceImagePaths?.length ? { reference_image_paths: referenceImagePaths } : {}),
                product_name: input.productName,
                context: input.context,
                rubric: options.evaluationRubric,
                pass_threshold: options.scoreThreshold,
              })) as {
                image_path: string
                prompt_used: string
              }
            } catch (error: unknown) {
              const authFailure = parseAuthFailure(error, {
                providerHint: options.provider.name,
                tool: 'generate_image',
              })
              if (authFailure) {
                roundToolAuthFailure = authFailure
                const detail = formatAuthFailureDetail(authFailure)
                const wrappedMessage = `Tool auth/permission error detected. ${detail}`
                pushEvent({
                  taskId,
                  phase: 'observe',
                  message: `generate_image failed. ${detail}`,
                  retryCount: retryRound,
                  roundIndex,
                  timestamp: Date.now(),
                })
                interruptCurrentQuery()
                throw new Error(wrappedMessage)
              }
              const errMsg = toErrorMessage(error)
              activeRoundState.queryError = `generate_image failed: ${errMsg}`
              activeRoundState.ignorePostInterruptSdkFailures = true
              activeRoundState.localRoundTerminationReason = errMsg
              pushEvent({
                taskId,
                phase: 'observe',
                message: `generate_image failed; ending current round. error=${errMsg}`,
                retryCount: retryRound,
                roundIndex,
                timestamp: Date.now(),
              })
              interruptCurrentQuery()
              throw new Error(`generate_image failed: ${errMsg}`)
            }

            let artifacts: RoundImageArtifacts
            try {
              if (!result.image_path?.trim()) {
                throw new Error('generate_image returned an empty image_path')
              }
              artifacts = await persistRoundArtifacts({
                taskId,
                roundIndex,
                sourceImagePath: result.image_path,
              })
              activeRoundState.generatedImagePath = artifacts.generatedImagePath
              activeRoundState.previewImagePath = artifacts.previewImagePath
              activeRoundState.contextThumbPath = artifacts.contextThumbPath
              lastImagePath = artifacts.generatedImagePath

              await insertTaskRoundArtifact({
                taskId,
                roundIndex,
                generatedImagePath: artifacts.generatedImagePath,
                previewImagePath: artifacts.previewImagePath,
                contextThumbPath: artifacts.contextThumbPath,
                score: null,
              })

              if (!retainedRoundIndexes.includes(roundIndex)) {
                retainedRoundIndexes.push(roundIndex)
              }
            } catch (error: unknown) {
              const errMsg = toErrorMessage(error)
              activeRoundState.queryError = `generate_image post-processing failed: ${errMsg}`
              activeRoundState.suppressAutoEvaluateFallback = true
              activeRoundState.ignorePostInterruptSdkFailures = true
              activeRoundState.localRoundTerminationReason = errMsg
              activeRoundState.autoEvaluateFallbackSkipReason =
                `generate_image post-processing failed earlier in this round. error=${errMsg}`
              pushEvent({
                taskId,
                phase: 'observe',
                message: `generate_image post-processing failed; ending current round. error=${errMsg}`,
                retryCount: retryRound,
                roundIndex,
                timestamp: Date.now(),
              })
              interruptCurrentQuery()
              throw new Error(`generate_image post-processing failed: ${errMsg}`)
            }

            pushEvent({
              taskId,
              phase: 'observe',
              message: `round ${roundIndex + 1} image generated`,
              retryCount: retryRound,
              roundIndex,
              generatedImagePath: artifacts.generatedImagePath,
              previewImagePath: artifacts.previewImagePath ?? artifacts.generatedImagePath,
              timestamp: Date.now(),
            })

            return {
              content: [{ type: 'text', text: JSON.stringify({ ...result, image_path: artifacts.generatedImagePath }) }],
              structuredContent: { ...result, image_path: artifacts.generatedImagePath },
            }
          },
          {
            annotations: {
              title: 'Generate Product Image',
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true,
              idempotentHint: false,
            },
          },
        ),
        tool(
          'evaluate_image',
          'Evaluate generated image quality',
          {
            image_path: z.string().optional(),
            product_name: z.string().optional(),
            context: z.string().optional(),
          },
          async (args) => {
            if (!activeRoundState) {
              return {
                content: [{ type: 'text', text: 'Error: no active round context for evaluate_image.' }],
                isError: true,
              }
            }

            const roundState = activeRoundState
            const roundIndex = roundState.roundIndex
            const retryRound = roundState.retryCount
            const requestedImagePath = args.image_path?.trim() ?? ''
            const currentRoundImagePath = roundState.generatedImagePath?.trim() ?? ''
            const targetImagePath = currentRoundImagePath || requestedImagePath
            if (!targetImagePath) {
              return {
                content: [{ type: 'text', text: 'Error: no generated image to evaluate' }],
                isError: true,
              }
            }

            if (
              currentRoundImagePath &&
              requestedImagePath &&
              requestedImagePath !== currentRoundImagePath
            ) {
              pushEvent({
                taskId,
                phase: 'observe',
                message:
                  'evaluate_image ignored model-provided image_path and used current round artifact path. ' +
                  `requested=${requestedImagePath}, active=${currentRoundImagePath}`,
                retryCount: retryRound,
                roundIndex,
                timestamp: Date.now(),
              })
            }

            const evalInput = {
              image_path: targetImagePath,
              product_name: args.product_name ?? input.productName,
              context: args.context ?? input.context,
              rubric: options.evaluationRubric,
              pass_threshold: options.scoreThreshold,
            }

            pushEvent({
              taskId,
              phase: 'observe',
              message: `evaluate_image args=${JSON.stringify(evalInput)}`,
              retryCount: retryRound,
              roundIndex,
              timestamp: Date.now(),
            })

            let result: {
              total_score: number
              defect_analysis: DefectAnalysis
              passed: boolean
              pass_threshold: number
            }

            const markEvaluateFailure = (rawMessage: string): void => {
              roundState.evaluateErrorMessage = rawMessage
              roundState.suppressAutoEvaluateFallback = true
              roundState.ignorePostInterruptSdkFailures = true
              roundState.localRoundTerminationReason = rawMessage
              roundState.autoEvaluateFallbackSkipReason = isEvaluateTimeoutError(rawMessage)
                ? `evaluate timed out earlier in this round. error=${rawMessage}`
                : `evaluate_image failed earlier in this round. error=${rawMessage}`
              if (isEvaluateTimeoutError(rawMessage)) {
                roundState.evaluateTimeoutInRound = true
              }
            }

            try {
              result = (await mcpServer.callTool('evaluate_image', evalInput)) as {
                total_score: number
                defect_analysis: DefectAnalysis
                passed: boolean
                pass_threshold: number
              }
            } catch (error: unknown) {
              const authFailure = parseAuthFailure(error, {
                providerHint: 'anthropic',
                tool: 'evaluate_image',
              })
              if (authFailure) {
                roundToolAuthFailure = authFailure
                const detail = formatAuthFailureDetail(authFailure)
                const wrappedMessage = `Tool auth/permission error detected. ${detail}`
                markEvaluateFailure(detail)
                pushEvent({
                  taskId,
                  phase: 'observe',
                  message: `evaluate_image failed. ${detail}`,
                  retryCount: retryRound,
                  roundIndex,
                  timestamp: Date.now(),
                })
                interruptCurrentQuery()
                throw new Error(wrappedMessage)
              }
              const modelCapabilityFailure = parseModelCapabilityFailure(error, {
                providerHint: 'anthropic',
                tool: 'evaluate_image',
              })
              if (modelCapabilityFailure) {
                roundToolModelCapabilityFailure = modelCapabilityFailure
                const detail = formatModelCapabilityFailureDetail(modelCapabilityFailure)
                const wrappedMessage = `Tool model/input compatibility error detected. ${detail}`
                markEvaluateFailure(detail)
                pushEvent({
                  taskId,
                  phase: 'observe',
                  message: `evaluate_image failed with non-retriable model/input compatibility error. ${detail}`,
                  retryCount: retryRound,
                  roundIndex,
                  timestamp: Date.now(),
                })
                interruptCurrentQuery()
                throw new Error(wrappedMessage)
              }
              const errMsg = toErrorMessage(error)
              markEvaluateFailure(errMsg)
              pushEvent({
                taskId,
                phase: 'observe',
                message: `evaluate_image failed; ending current round. error=${errMsg}`,
                retryCount: retryRound,
                roundIndex,
                timestamp: Date.now(),
              })
              interruptCurrentQuery()
              throw new Error(`evaluate_image failed: ${errMsg}`)
            }

            roundState.roundEvalScore = result.total_score
            roundState.roundDefect = result.defect_analysis

            await updateTaskRoundArtifactScore({
              taskId,
              roundIndex,
              score: result.total_score,
            })

            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            }
          },
          {
            annotations: {
              title: 'Evaluate Product Image',
              readOnlyHint: true,
              openWorldHint: false,
              idempotentHint: true,
            },
          },
        ),
      ],
    })

    const createRoundResultPromise = (roundIndex: number, sessionId: number): Promise<SDKResultMessage> => {
      if (pendingRoundResult) {
        pendingRoundResult.reject(new Error('Round result superseded by query session rebuild.'))
        pendingRoundResult = null
      }
      const roundPromise = new Promise<SDKResultMessage>((resolve, reject) => {
        pendingRoundResult = { roundIndex, sessionId, resolve, reject }
      })
      void roundPromise.catch(() => {
        // Avoid unhandled rejection when round exits early on known query errors.
      })
      return roundPromise
    }

    const closeActiveQuerySession = async (): Promise<void> => {
      if (!queryInstance) return
      const closingQuery = queryInstance
      const closingPump = queryPump
      queryInstance = null
      queryPump = null
      try {
        closingQuery.close()
      } catch {
        // Ignore close errors.
      }
      if (closingPump) {
        try {
          await closingPump
        } catch {
          // Ignore stream close errors.
        }
      }
    }

    const startMessagePump = (q: SDKQuery, sessionId: number): void => {
      queryPump = (async () => {
        try {
          for await (const msg of q) {
            const eventRoundIndex = activeRoundState?.roundIndex ?? retryCount
            const eventRetryCount = activeRoundState?.retryCount ?? retryCount
            this.handleSdkMessage(msg, {
              pushEvent,
              taskId,
              retryCount: eventRetryCount,
              roundIndex: eventRoundIndex,
            })

            if (msg.type === 'result') {
              if (activeRoundState && sessionId === querySessionId) {
                activeRoundState.resultMessage = msg
              }
              if (pendingRoundResult && pendingRoundResult.sessionId === sessionId) {
                pendingRoundResult.resolve(msg)
                pendingRoundResult = null
              }
            }
          }

          if (pendingRoundResult && pendingRoundResult.sessionId === sessionId) {
            pendingRoundResult.reject(new Error('Claude SDK stream ended before a round result was produced.'))
            pendingRoundResult = null
          }
        } catch (error: unknown) {
          const errMsg = toErrorMessage(error)
          if (sessionId === querySessionId) {
            streamFailureReason = errMsg
            if (activeRoundState) {
              activeRoundState.queryError = streamFailureReason
            }
          }
          if (pendingRoundResult && pendingRoundResult.sessionId === sessionId) {
            pendingRoundResult.reject(new Error(errMsg))
            pendingRoundResult = null
          }
        }
      })()
    }

    const startQuerySession = (roundInstruction: string, sessionId: number): void => {
      const instance = query({
        prompt: createUserMessageStream(roundInstruction),
        options: {
          model: currentAnthropicModel,
          systemPrompt: baseSystemPrompt,
          cwd: isolatedProjectDir,
          persistSession: true,
          settingSources: ['project'],
          mcpServers: {
            [mcpServerName]: sdkMcpServer,
          },
          maxTurns: DEFAULT_MAX_TURNS,
          permissionMode: 'default',
          tools: [],
          allowedTools,
          canUseTool: async (toolName, toolInput) => {
            if (toolName.endsWith('__generate_image')) {
              if (!activeRoundState) {
                return {
                  behavior: 'deny',
                  message: 'No active round context for generate_image.',
                }
              }
              const normalizedInput =
                typeof toolInput === 'object' && toolInput !== null
                  ? { ...(toolInput as Record<string, unknown>) }
                  : {}
              const draftPrompt =
                typeof normalizedInput.prompt === 'string' ? normalizedInput.prompt : ''
              const enforcedPrompt = buildEnforcedGenerationPrompt({
                productName: input.productName,
                context: input.context,
                userPrompt: input.userPrompt,
                modelPrompt: draftPrompt,
                defectAnalysis: lastDefectAnalysis,
                roundIndex: activeRoundState.roundIndex,
              })
              return {
                behavior: 'allow',
                updatedInput: {
                  ...normalizedInput,
                  prompt: enforcedPrompt,
                },
              }
            }

            if (toolName.endsWith('__evaluate_image')) {
              return { behavior: 'allow' }
            }

            return {
              behavior: 'deny',
              message: `Tool denied: ${toolName}. Only generate_image/evaluate_image are allowed.`,
            }
          },
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: options.anthropicApiKey,
            ...(options.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: options.anthropicBaseUrl } : {}),
          },
          includeHookEvents: true,
          includePartialMessages: false,
        },
      })

      queryInstance = instance
      querySessionId = sessionId
      queryBootstrapDone = false
      streamFailureReason = null
      startMessagePump(instance, sessionId)
    }

    try {
      while (retryCount <= options.maxRetries) {
        if (signal.aborted) {
          pushEvent({
            taskId,
            phase: 'failed',
            message: 'Task aborted by user',
            retryCount,
            roundIndex: retryCount,
            timestamp: Date.now(),
          })
          await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
          return
        }

        const roundIndex = retryCount
        const isLastRound = roundIndex >= options.maxRetries
        roundsAttempted = roundIndex + 1
        roundToolAuthFailure = null
        roundToolModelCapabilityFailure = null
        const compressionMode = pickCompressionMode(latestContextUsagePercentage, compressionThresholds)
        const roundInstruction = buildRoundUserInstruction({
          input,
          roundIndex,
          scoreThreshold: options.scoreThreshold,
          defectAnalysis: lastDefectAnalysis,
          productImageCount: productImagePaths.length,
          compressionMode,
        })

        activeRoundState = createActiveRoundState(roundIndex, retryCount)
        let roundResultPromise: Promise<SDKResultMessage>
        let transportRecoveryAttempted = false

        pushEvent({
          taskId,
          phase: 'thought',
          message:
            `Round ${roundIndex + 1} started with Claude SDK stream. product=${input.productName}` +
            `, pass_threshold=${options.scoreThreshold}, max_retries=${options.maxRetries}` +
            `, model=${currentAnthropicModel}`,
          retryCount,
          roundIndex,
          timestamp: Date.now(),
        })

        const hasActiveQuerySession = querySessionId > 0 && queryInstance !== null
        if (!hasActiveQuerySession) {
          const newSessionId = querySessionId + 1
          roundResultPromise = createRoundResultPromise(roundIndex, newSessionId)
          try {
            startQuerySession(roundInstruction, newSessionId)
          } catch (error: unknown) {
            const errMsg = toErrorMessage(error)
            activeRoundState.queryError = errMsg
            const pending = pendingRoundResult as
              | {
                  sessionId: number
                  reject: (error: Error) => void
                }
              | null
            if (pending && pending.sessionId === newSessionId) {
              pending.reject(new Error(errMsg))
              pendingRoundResult = null
            }
          }
        } else {
          const activeQuery = queryInstance!
          const currentSessionId = querySessionId
          roundResultPromise = createRoundResultPromise(roundIndex, currentSessionId)
          try {
            await activeQuery.streamInput(createUserMessageStream(roundInstruction))
          } catch (error: unknown) {
            const errMsg = toErrorMessage(error)
            if (isTransportNotReadyError(errMsg) && !transportRecoveryAttempted) {
              transportRecoveryAttempted = true
              pushEvent({
                taskId,
                phase: 'observe',
                message: `Claude SDK transport unavailable, rebuilding query session. error=${errMsg}`,
                retryCount,
                roundIndex,
                timestamp: Date.now(),
              })
              try {
                await closeActiveQuerySession()
                const rebuiltSessionId = querySessionId + 1
                roundResultPromise = createRoundResultPromise(roundIndex, rebuiltSessionId)
                startQuerySession(roundInstruction, rebuiltSessionId)
                pushEvent({
                  taskId,
                  phase: 'observe',
                  message: `Claude SDK query session rebuilt. session=${rebuiltSessionId}`,
                  retryCount,
                  roundIndex,
                  timestamp: Date.now(),
                })
              } catch (rebuildError: unknown) {
                const rebuildErrMsg = toErrorMessage(rebuildError)
                activeRoundState.queryError = rebuildErrMsg
                const pending = pendingRoundResult as
                  | {
                      sessionId: number
                      reject: (error: Error) => void
                    }
                  | null
                if (pending && pending.sessionId === querySessionId + 1) {
                  pending.reject(new Error(rebuildErrMsg))
                  pendingRoundResult = null
                }
              }
            } else {
              activeRoundState.queryError = errMsg
              const pending = pendingRoundResult as
                | {
                    sessionId: number
                    reject: (error: Error) => void
                  }
                | null
              if (pending && pending.sessionId === currentSessionId) {
                pending.reject(new Error(errMsg))
                pendingRoundResult = null
              }
            }
          }
        }

        const queryForBootstrap = queryInstance as SDKQuery | null
        if (!queryBootstrapDone && querySessionId > 0 && queryForBootstrap) {
          try {
            const init = await queryForBootstrap.initializationResult()
            pushEvent({
              taskId,
              phase: 'observe',
              message: `SDK initialized. models=${init.models.length}, agents=${init.agents.length}, commands=${init.commands.length}`,
              retryCount,
              roundIndex,
              timestamp: Date.now(),
            })
            const discoveredModels = Array.from(
              new Set(
                init.models
                  .map((item) => extractSdkModelId(item))
                  .filter((item) => item.length > 0),
              ),
            )
            if (discoveredModels.length > 0) {
              availableAnthropicModels = discoveredModels
              if (!availableAnthropicModels.includes(currentAnthropicModel)) {
                const fallbackModel = pickAvailableAnthropicModel(
                  currentAnthropicModel,
                  availableAnthropicModels,
                  attemptedAnthropicModels,
                )
                if (fallbackModel) {
                  pushEvent({
                    taskId,
                    phase: 'observe',
                    message:
                      `Current Anthropic model is unavailable in runtime model list.` +
                      ` switching model from ${currentAnthropicModel} to ${fallbackModel} and retrying this round.`,
                    retryCount,
                    roundIndex,
                    timestamp: Date.now(),
                  })
                  currentAnthropicModel = fallbackModel
                  attemptedAnthropicModels.add(fallbackModel)
                  await closeActiveQuerySession()
                  pendingRoundResult = null
                  activeRoundState = null
                  continue
                }
              }
            }

            const statuses = (await queryForBootstrap.mcpServerStatus()) as Array<{
              name: string
              status: string
            }>
            const statusLine =
              statuses.length === 0 ? 'none' : statuses.map((item) => `${item.name}:${item.status}`).join(', ')
            pushEvent({
              taskId,
              phase: 'observe',
              message: `MCP status: ${statusLine}`,
              retryCount,
              roundIndex,
              timestamp: Date.now(),
            })
            const unhealthy = statuses.find(
              (item) => item.status !== 'connected' && item.status !== 'pending',
            )
            if (unhealthy) {
              throw new Error(`MCP server unhealthy: ${unhealthy.name} (${unhealthy.status})`)
            }
            queryBootstrapDone = true
          } catch (error: unknown) {
            terminalFailureReason = `sdk_bootstrap_failed: ${error instanceof Error ? error.message : String(error)}`
            pendingRoundResult = null
            break
          }
        }

        if (!activeRoundState.queryError) {
          try {
            await this.awaitRoundResult(roundResultPromise, signal, queryInstance!)
          } catch (error: unknown) {
            activeRoundState.queryError = error instanceof Error ? error.message : String(error)
          }
        }

        if (activeRoundState.resultMessage?.total_cost_usd) {
          totalCostUsd += activeRoundState.resultMessage.total_cost_usd
        }

        let contextUsage: LoopEvent['contextUsage'] | undefined
        try {
          const usage = await queryInstance!.getContextUsage()
          contextUsage = {
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            percentage: usage.percentage,
          }
        } catch {
          contextUsage = this.deriveContextUsageFromResult(
            activeRoundState.resultMessage,
            options.anthropicModel ?? DEFAULT_MODEL,
          )
        }

        if (contextUsage) {
          latestContextUsagePercentage = contextUsage.percentage
        }

        let generatedImagePath = activeRoundState.generatedImagePath
        let previewImagePath = activeRoundState.previewImagePath
        let contextThumbPath = activeRoundState.contextThumbPath
        let roundEvalScore = activeRoundState.roundEvalScore
        let roundDefect = activeRoundState.roundDefect
        let queryError = activeRoundState.queryError

        if (!queryError && streamFailureReason) {
          queryError = streamFailureReason
        }

        if (queryError) {
          pushEvent({
            taskId,
            phase: 'observe',
            message: `Claude SDK query error: ${queryError}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
        }

        const resultDiagnostics = activeRoundState.resultMessage
          ? this.collectResultDiagnostics(activeRoundState.resultMessage)
          : null
        if (resultDiagnostics) {
          const diagnosticsPrefix = activeRoundState.ignorePostInterruptSdkFailures
            ? 'Claude SDK round diagnostics (post-interrupt, ignored for failure classification)'
            : 'Claude SDK round diagnostics'
          pushEvent({
            taskId,
            phase: 'observe',
            message: `${diagnosticsPrefix}: ${resultDiagnostics.detail}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
        }

        const ignorePostInterruptSdkFailures = activeRoundState.ignorePostInterruptSdkFailures
        if (ignorePostInterruptSdkFailures && activeRoundState.localRoundTerminationReason) {
          pushEvent({
            taskId,
            phase: 'observe',
            message:
              'Ignoring SDK auth/model errors emitted after local round termination. ' +
              `reason=${activeRoundState.localRoundTerminationReason}`,
            retryCount,
            roundIndex,
            contextUsage,
            timestamp: Date.now(),
          })
        }

        const queryAuthFailure =
          ignorePostInterruptSdkFailures || !queryError
            ? null
            : parseAuthFailure(queryError, {
                tool: null,
              })
        const resultAuthFailure =
          ignorePostInterruptSdkFailures || !activeRoundState.resultMessage
            ? null
            : collectAuthFailureFromResult(activeRoundState.resultMessage)
        const queryModelCapabilityFailure =
          ignorePostInterruptSdkFailures || !queryError
            ? null
            : parseModelCapabilityFailure(queryError, {
                providerHint: 'anthropic',
                tool: 'evaluate_image',
              })
        const resultModelCapabilityFailure =
          ignorePostInterruptSdkFailures || !activeRoundState.resultMessage
            ? null
            : collectModelCapabilityFailureFromResult(
                activeRoundState.resultMessage,
                'anthropic',
                'evaluate_image',
              )
        const roundModelCapabilityFailure =
          roundToolModelCapabilityFailure ?? queryModelCapabilityFailure ?? resultModelCapabilityFailure
        const roundAuthFailure = roundToolAuthFailure ?? queryAuthFailure ?? resultAuthFailure
        if (roundModelCapabilityFailure) {
          const detail = formatModelCapabilityFailureDetail(roundModelCapabilityFailure)
          pushEvent({
            taskId,
            phase: 'observe',
            message: `Claude SDK detected non-retriable model/input compatibility error. ${detail}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
          terminalFailureReason = `model_or_capability_error: ${detail}`
          break
        }
        if (roundAuthFailure) {
          if (
            roundAuthFailure.provider === 'anthropic' &&
            hasCodingPlanModelUnavailableError(roundAuthFailure)
          ) {
            const fallbackModel = pickAvailableAnthropicModel(
              currentAnthropicModel,
              availableAnthropicModels,
              attemptedAnthropicModels,
            )
            if (fallbackModel) {
              pushEvent({
                taskId,
                phase: 'observe',
                message:
                  `Claude model is not available in coding plan.` +
                  ` switching model from ${currentAnthropicModel} to ${fallbackModel} and retrying this round.`,
                retryCount,
                roundIndex,
                contextUsage,
                costUsd: totalCostUsd,
                timestamp: Date.now(),
              })
              currentAnthropicModel = fallbackModel
              attemptedAnthropicModels.add(fallbackModel)
              await closeActiveQuerySession()
              pendingRoundResult = null
              activeRoundState = null
              continue
            }
          }
          const detail = formatAuthFailureDetail(roundAuthFailure)
          pushEvent({
            taskId,
            phase: 'observe',
            message: `Claude SDK detected non-retriable auth/permission error. ${detail}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
          terminalFailureReason = `auth_or_permission_error: ${detail}`
          break
        }

        if (generatedImagePath && roundEvalScore === null) {
          if (activeRoundState.suppressAutoEvaluateFallback) {
            const skipReason =
              activeRoundState.autoEvaluateFallbackSkipReason ??
              (activeRoundState.evaluateTimeoutInRound
                ? `evaluate timed out earlier in this round.${
                    activeRoundState.evaluateErrorMessage
                      ? ` error=${activeRoundState.evaluateErrorMessage}`
                      : ''
                  }`
                : 'current round was terminated before fallback evaluation.')
            pushEvent({
              taskId,
              phase: 'observe',
              message: `Skip evaluate_image fallback because ${skipReason}`,
              retryCount,
              roundIndex,
              contextUsage,
              timestamp: Date.now(),
            })
          } else {
            try {
              const fallback = (await mcpServer.callTool('evaluate_image', {
                image_path: generatedImagePath,
                product_name: input.productName,
                context: input.context,
                rubric: options.evaluationRubric,
                pass_threshold: options.scoreThreshold,
              })) as { total_score: number; defect_analysis: DefectAnalysis }
              roundEvalScore = fallback.total_score
              roundDefect = fallback.defect_analysis
              await updateTaskRoundArtifactScore({
                taskId,
                roundIndex,
                score: roundEvalScore,
                contextUsage: contextUsage ? JSON.stringify(contextUsage) : null,
              })
              pushEvent({
                taskId,
                phase: 'observe',
                message: 'evaluate_image fallback succeeded',
                retryCount,
                roundIndex,
                contextUsage,
                timestamp: Date.now(),
              })
            } catch (error: unknown) {
              const err = toErrorMessage(error)
              const parsedAuthFailure = parseAuthFailure(err, {
                providerHint: 'anthropic',
                tool: 'evaluate_image',
              })
              if (parsedAuthFailure) {
                const detail = formatAuthFailureDetail(parsedAuthFailure)
                pushEvent({
                  taskId,
                  phase: 'observe',
                  message: `evaluate_image fallback failed with non-retriable auth/permission error. ${detail}`,
                  retryCount,
                  roundIndex,
                  contextUsage,
                  timestamp: Date.now(),
                })
                terminalFailureReason = `auth_or_permission_error: ${detail}`
                break
              }
              if (isEvaluateTimeoutError(err)) {
                activeRoundState.evaluateTimeoutInRound = true
                activeRoundState.evaluateErrorMessage = err
              }
              pushEvent({
                taskId,
                phase: 'observe',
                message: `evaluate_image fallback failed: ${err}`,
                retryCount,
                roundIndex,
                contextUsage,
                timestamp: Date.now(),
              })
            }
          }
        }

        if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
          const roundFailure = buildRoundFailureDiagnostics({
            generatedImagePath,
            roundEvalScore,
            queryError,
            resultDiagnostics,
            evaluateTimeoutInRound: activeRoundState.evaluateTimeoutInRound,
            evaluateErrorMessage: activeRoundState.evaluateErrorMessage,
          })

          if (!isLastRound) {
            pushEvent({
              taskId,
              phase: 'observe',
              message: `Round incomplete, continue retry. ${roundFailure.detail}`,
              retryCount,
              roundIndex,
              contextUsage,
              costUsd: totalCostUsd,
              timestamp: Date.now(),
            })
            activeRoundState = null
            retryCount += 1
            continue
          }

          pushEvent({
            taskId,
            phase: 'observe',
            message: `Last round fallback start. ${roundFailure.detail}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })

          try {
            const fallbackResult = await this.executeLastRoundFallback({
              input,
              taskId,
              roundIndex,
              mcpServer,
              pushEvent,
              retryCount,
              generatedImagePath,
              previewImagePath,
              contextThumbPath,
              roundEvalScore,
              roundDefect,
              productImagePaths,
              referenceImagePaths,
              scoreThreshold: options.scoreThreshold,
              evaluationRubric: options.evaluationRubric,
              contextUsage,
              lastDefectAnalysis,
            })
            generatedImagePath = fallbackResult.generatedImagePath
            previewImagePath = fallbackResult.previewImagePath
            contextThumbPath = fallbackResult.contextThumbPath
            roundEvalScore = fallbackResult.roundEvalScore
            roundDefect = fallbackResult.roundDefect
            lastImagePath = generatedImagePath
            if (!retainedRoundIndexes.includes(roundIndex)) {
              retainedRoundIndexes.push(roundIndex)
            }
          } catch (error: unknown) {
            const err = error instanceof Error ? error.message : String(error)
            terminalFailureReason = `last_round_fallback_failed: ${err}`
            break
          }
        }

        await updateTaskRoundArtifactScore({
          taskId,
          roundIndex,
          score: roundEvalScore,
          contextUsage: contextUsage ? JSON.stringify(contextUsage) : null,
        })

        await pruneRoundOriginalCache({
          taskId,
          keepRoundIndexes: retainedRoundIndexes.slice(-DEFAULT_MAX_ORIGINAL_ROUNDS),
          maxOriginalRounds: DEFAULT_MAX_ORIGINAL_ROUNDS,
        })

        const compressionLevel = contextUsage
          ? pickCompressionMode(contextUsage.percentage, compressionThresholds)
          : 'none'
        if (compressionLevel !== 'none' && contextUsage) {
          pushEvent({
            taskId,
            phase: 'observe',
            message: `context usage ${contextUsage.percentage.toFixed(1)}%, next round prompt mode=${compressionLevel.toUpperCase()}`,
            retryCount,
            roundIndex,
            contextUsage,
            timestamp: Date.now(),
          })
        }

        pushEvent({
          taskId,
          phase: 'observe',
          message: `score result: ${roundEvalScore} / 100`,
          score: roundEvalScore,
          defectAnalysis: roundDefect,
          retryCount,
          roundIndex,
          generatedImagePath,
          previewImagePath: previewImagePath ?? generatedImagePath,
          contextUsage,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })

        if (roundEvalScore >= options.scoreThreshold) {
          const destPath = path.join(readyDir, `${taskId}_${roundIndex}.png`)
          await fs.copyFile(generatedImagePath, destPath)
          await updateTaskSuccess({
            taskId,
            totalScore: roundEvalScore,
            defectAnalysis: JSON.stringify(roundDefect),
            imagePath: destPath,
            retryCount,
            costUsd: totalCostUsd,
          })

          pushEvent({
            taskId,
            phase: 'success',
            message: `Task succeeded with score=${roundEvalScore}, total_cost=$${totalCostUsd.toFixed(4)}`,
            score: roundEvalScore,
            retryCount,
            roundIndex,
            generatedImagePath,
            previewImagePath: previewImagePath ?? generatedImagePath,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
          return
        }

        lastDefectAnalysis = roundDefect
        activeRoundState = null
        retryCount += 1
      }

      if (lastImagePath) {
        const destPath = path.join(failedDir, `${taskId}_final.png`)
        await fs.copyFile(lastImagePath, destPath)
      }
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
      const attemptSummary = buildAttemptSummary(Math.max(1, roundsAttempted), options.maxRetries)
      const reasonSuffix = terminalFailureReason ? `, reason=${terminalFailureReason}` : ''
      pushEvent({
        taskId,
        phase: 'failed',
        message: `Task failed after rounds ${attemptSummary}, total_cost=$${totalCostUsd.toFixed(4)}${reasonSuffix}`,
        retryCount,
        roundIndex: retryCount,
        costUsd: totalCostUsd,
        timestamp: Date.now(),
      })
    } finally {
      await closeActiveQuerySession()
    }
  }

  private collectResultDiagnostics(message: SDKResultMessage): ResultDiagnostics {
    const failureTypes = new Set<RoundFailureType>()
    const detailParts = [
      `result_subtype=${message.subtype}`,
      `num_turns=${message.num_turns}`,
      `terminal_reason=${message.terminal_reason ?? 'none'}`,
      `stop_reason=${(message as { stop_reason?: string }).stop_reason ?? 'none'}`,
    ]

    if (message.subtype !== 'success') {
      failureTypes.add('result_error')
      if (message.errors.length > 0) {
        detailParts.push(`errors=${message.errors.slice(0, 2).join(' | ')}`)
      }
    }

    if (message.permission_denials.length > 0) {
      const deniedTools = Array.from(
        new Set(message.permission_denials.map((item) => item.tool_name.trim()).filter((name) => name.length > 0)),
      )
      failureTypes.add('permission_denied')
      detailParts.push(`permission_denials=${deniedTools.join(', ')}`)
    } else {
      detailParts.push('permission_denials=none')
    }

    if (
      message.subtype === 'error_max_turns' ||
      message.terminal_reason === 'max_turns' ||
      (message.num_turns >= DEFAULT_MAX_TURNS &&
        !(message.subtype === 'success' && Boolean(message.deferred_tool_use)))
    ) {
      failureTypes.add('max_turns')
    }

    return {
      failureTypes: normalizeFailureTypes(failureTypes),
      detail: detailParts.join(', '),
    }
  }

  private async executeLastRoundFallback(params: {
    input: TaskInput
    taskId: string
    roundIndex: number
    mcpServer: Awaited<ReturnType<typeof createMcpServer>>
    pushEvent: PushEventFn
    retryCount: number
    generatedImagePath: string | null
    previewImagePath: string | null
    contextThumbPath: string | null
    roundEvalScore: number | null
    roundDefect: DefectAnalysis | null
    productImagePaths: string[]
    referenceImagePaths: string[] | undefined
    scoreThreshold: number
    evaluationRubric: EngineRuntimeOptions['evaluationRubric']
    contextUsage: LoopEvent['contextUsage'] | undefined
    lastDefectAnalysis: DefectAnalysis | null
  }): Promise<{
    generatedImagePath: string
    previewImagePath: string | null
    contextThumbPath: string | null
    roundEvalScore: number
    roundDefect: DefectAnalysis
  }> {
    let generatedImagePath = params.generatedImagePath
    let previewImagePath = params.previewImagePath
    let contextThumbPath = params.contextThumbPath
    let roundEvalScore = params.roundEvalScore
    let roundDefect = params.roundDefect

    if (!generatedImagePath) {
      const generated = (await params.mcpServer.callTool('generate_image', {
        prompt: buildEnforcedGenerationPrompt({
          productName: params.input.productName,
          context: params.input.context,
          userPrompt: params.input.userPrompt,
          modelPrompt: buildFallbackDraftPrompt(params.input.productName, params.input.context),
          defectAnalysis: params.lastDefectAnalysis,
          roundIndex: params.roundIndex,
        }),
        product_image_paths: params.productImagePaths,
        ...(params.referenceImagePaths?.length
          ? { reference_image_paths: params.referenceImagePaths }
          : {}),
        product_name: params.input.productName,
        context: params.input.context,
        rubric: params.evaluationRubric,
        pass_threshold: params.scoreThreshold,
      })) as { image_path: string }

      const artifacts = await persistRoundArtifacts({
        taskId: params.taskId,
        roundIndex: params.roundIndex,
        sourceImagePath: generated.image_path,
      })
      generatedImagePath = artifacts.generatedImagePath
      previewImagePath = artifacts.previewImagePath
      contextThumbPath = artifacts.contextThumbPath

      await insertTaskRoundArtifact({
        taskId: params.taskId,
        roundIndex: params.roundIndex,
        generatedImagePath,
        previewImagePath,
        contextThumbPath,
        score: null,
      })

      params.pushEvent({
        taskId: params.taskId,
        phase: 'observe',
        message: 'Last round fallback generated image',
        retryCount: params.retryCount,
        roundIndex: params.roundIndex,
        generatedImagePath,
        previewImagePath: previewImagePath ?? generatedImagePath,
        timestamp: Date.now(),
      })
    }

    if (!generatedImagePath) {
      throw new Error('fallback generate_image returned empty path')
    }

    if (roundEvalScore === null || !roundDefect) {
      const evalResult = (await params.mcpServer.callTool('evaluate_image', {
        image_path: generatedImagePath,
        product_name: params.input.productName,
        context: params.input.context,
        rubric: params.evaluationRubric,
        pass_threshold: params.scoreThreshold,
      })) as { total_score: number; defect_analysis: DefectAnalysis }
      roundEvalScore = evalResult.total_score
      roundDefect = evalResult.defect_analysis

      await updateTaskRoundArtifactScore({
        taskId: params.taskId,
        roundIndex: params.roundIndex,
        score: roundEvalScore,
        contextUsage: params.contextUsage ? JSON.stringify(params.contextUsage) : null,
      })

      params.pushEvent({
        taskId: params.taskId,
        phase: 'observe',
        message: 'Last round fallback evaluated image',
        retryCount: params.retryCount,
        roundIndex: params.roundIndex,
        timestamp: Date.now(),
      })
    }

    if (roundEvalScore === null || !roundDefect) {
      throw new Error('fallback evaluate_image returned incomplete result')
    }

    return {
      generatedImagePath,
      previewImagePath,
      contextThumbPath,
      roundEvalScore,
      roundDefect,
    }
  }

  private async awaitRoundResult(
    roundPromise: Promise<SDKResultMessage>,
    signal: AbortSignal,
    q: SDKQuery,
  ): Promise<SDKResultMessage> {
    if (signal.aborted) {
      try {
        await q.interrupt()
      } catch {
        // Ignore interrupt errors.
      }
      throw new Error('Task aborted by user')
    }

    return await new Promise<SDKResultMessage>((resolve, reject) => {
      let settled = false
      const finish = (handler: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        handler()
      }

      const onAbort = (): void => {
        finish(() => {
          void q.interrupt().catch(() => {
            // Ignore interrupt errors.
          })
          reject(new Error('Task aborted by user'))
        })
      }

      signal.addEventListener('abort', onAbort, { once: true })

      roundPromise
        .then((message) => {
          finish(() => {
            resolve(message)
          })
        })
        .catch((error: unknown) => {
          finish(() => {
            const err = error instanceof Error ? error : new Error(String(error))
            reject(err)
          })
        })
    })
  }

  private deriveContextUsageFromResult(
    message: SDKResultMessage | null,
    modelName: string,
  ): LoopEvent['contextUsage'] | undefined {
    if (!message) return undefined

    const usage = message.usage as
      | {
          inputTokens?: number
          outputTokens?: number
          cacheReadInputTokens?: number
          cacheCreationInputTokens?: number
          contextWindow?: number
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          context_window?: number
        }
      | undefined

    if (!usage) return undefined

    const totalTokens =
      (usage.inputTokens ?? usage.input_tokens ?? 0) +
      (usage.outputTokens ?? usage.output_tokens ?? 0) +
      (usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0) +
      (usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0)

    const maxTokensRaw = usage.contextWindow ?? usage.context_window ?? 0
    const maxTokens =
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
        ? maxTokensRaw
        : this.estimateContextWindowTokens(modelName)

    if (!Number.isFinite(totalTokens) || !Number.isFinite(maxTokens)) {
      return undefined
    }
    if (totalTokens <= 0 || maxTokens <= 0) {
      return undefined
    }

    return {
      totalTokens: Math.round(totalTokens),
      maxTokens: Math.round(maxTokens),
      percentage: Math.min(100, Math.max(0, (totalTokens / maxTokens) * 100)),
    }
  }

  private estimateContextWindowTokens(modelName: string): number {
    const normalized = modelName.trim().toLowerCase()
    if (normalized.includes('claude')) {
      return DEFAULT_CONTEXT_WINDOW_TOKENS
    }
    return DEFAULT_CONTEXT_WINDOW_TOKENS
  }

  private handleSdkMessage(
    message: SDKMessage,
    ctx: {
      pushEvent: (event: LoopEvent) => void
      taskId: string
      retryCount: number
      roundIndex: number
    },
  ): void {
    if (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting') {
      ctx.pushEvent({
        taskId: ctx.taskId,
        phase: 'observe',
        message: 'Claude SDK is compacting context',
        retryCount: ctx.retryCount,
        roundIndex: ctx.roundIndex,
        timestamp: Date.now(),
      })
    }

    if (message.type === 'system' && message.subtype === 'memory_recall') {
      ctx.pushEvent({
        taskId: ctx.taskId,
        phase: 'observe',
        message: `Memory recall count=${message.memories.length}`,
        retryCount: ctx.retryCount,
        roundIndex: ctx.roundIndex,
        timestamp: Date.now(),
      })
    }
  }
}

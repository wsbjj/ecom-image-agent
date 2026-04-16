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
import { persistRoundArtifacts, pruneRoundOriginalCache } from '../round-image-cache'
import type { AgentEngine, EngineRuntimeOptions } from './types'
import { buildEnforcedGenerationPrompt, buildFallbackDraftPrompt } from '../enforced-generation-prompt'

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_ORIGINAL_ROUNDS = 12
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_MAX_TURNS = 8

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
  }
}

function normalizeImagePaths(paths: string[]): string[] {
  return paths
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
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
    let activeRoundState: ActiveRoundState | null = null
    let queryInstance: SDKQuery | null = null
    let queryPump: Promise<void> | null = null
    let queryBootstrapDone = false
    let pendingRoundResult:
      | {
          roundIndex: number
          resolve: (message: SDKResultMessage) => void
          reject: (error: Error) => void
        }
      | null = null

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

            const result = (await mcpServer.callTool('generate_image', {
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

            const artifacts = await persistRoundArtifacts({
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

            const roundIndex = activeRoundState.roundIndex
            const retryRound = activeRoundState.retryCount
            const targetImagePath = (args.image_path ?? activeRoundState.generatedImagePath ?? '').trim()
            if (!targetImagePath) {
              return {
                content: [{ type: 'text', text: 'Error: no generated image to evaluate' }],
                isError: true,
              }
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

            const result = (await mcpServer.callTool('evaluate_image', evalInput)) as {
              total_score: number
              defect_analysis: DefectAnalysis
              passed: boolean
              pass_threshold: number
            }

            activeRoundState.roundEvalScore = result.total_score
            activeRoundState.roundDefect = result.defect_analysis

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

    const startMessagePump = (q: SDKQuery): void => {
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
              if (activeRoundState) {
                activeRoundState.resultMessage = msg
              }
              if (pendingRoundResult) {
                pendingRoundResult.resolve(msg)
                pendingRoundResult = null
              }
            }
          }

          if (pendingRoundResult) {
            pendingRoundResult.reject(new Error('Claude SDK stream ended before a round result was produced.'))
            pendingRoundResult = null
          }
        } catch (error: unknown) {
          streamFailureReason = error instanceof Error ? error.message : String(error)
          if (activeRoundState) {
            activeRoundState.queryError = streamFailureReason
          }
          if (pendingRoundResult) {
            pendingRoundResult.reject(new Error(streamFailureReason))
            pendingRoundResult = null
          }
        }
      })()
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
        const roundResultPromise = new Promise<SDKResultMessage>((resolve, reject) => {
          pendingRoundResult = { roundIndex, resolve, reject }
        })

        pushEvent({
          taskId,
          phase: 'thought',
          message:
            `Round ${roundIndex + 1} started with Claude SDK stream. product=${input.productName}` +
            `, pass_threshold=${options.scoreThreshold}, max_retries=${options.maxRetries}`,
          retryCount,
          roundIndex,
          timestamp: Date.now(),
        })

        if (!queryInstance) {
          queryInstance = query({
            prompt: createUserMessageStream(roundInstruction),
            options: {
              model: options.anthropicModel ?? DEFAULT_MODEL,
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
          startMessagePump(queryInstance)
        } else {
          try {
            await queryInstance.streamInput(createUserMessageStream(roundInstruction))
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error)
            activeRoundState.queryError = errMsg
            const pending = pendingRoundResult as
              | {
                  reject: (error: Error) => void
                }
              | null
            if (pending) {
              pending.reject(new Error(errMsg))
              pendingRoundResult = null
            }
          }
        }

        if (!queryBootstrapDone && queryInstance) {
          try {
            const init = await queryInstance.initializationResult()
            pushEvent({
              taskId,
              phase: 'observe',
              message: `SDK initialized. models=${init.models.length}, agents=${init.agents.length}, commands=${init.commands.length}`,
              retryCount,
              roundIndex,
              timestamp: Date.now(),
            })

            const statuses = await queryInstance.mcpServerStatus()
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
          pushEvent({
            taskId,
            phase: 'observe',
            message: `Claude SDK round diagnostics: ${resultDiagnostics.detail}`,
            retryCount,
            roundIndex,
            contextUsage,
            costUsd: totalCostUsd,
            timestamp: Date.now(),
          })
        }

        if (generatedImagePath && roundEvalScore === null) {
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
            const err = error instanceof Error ? error.message : String(error)
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

        if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
          const roundFailure = buildRoundFailureDiagnostics({
            generatedImagePath,
            roundEvalScore,
            queryError,
            resultDiagnostics,
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
      if (queryInstance) {
        try {
          queryInstance.close()
        } catch {
          // Ignore close errors.
        }
      }
      if (queryPump) {
        try {
          await queryPump
        } catch {
          // Ignore stream close errors.
        }
      }
    }
  }

  private collectResultDiagnostics(message: SDKResultMessage): ResultDiagnostics {
    const failureTypes = new Set<RoundFailureType>()
    const detailParts = [
      `result_subtype=${message.subtype}`,
      `num_turns=${message.num_turns}`,
      `terminal_reason=${message.terminal_reason ?? 'none'}`,
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

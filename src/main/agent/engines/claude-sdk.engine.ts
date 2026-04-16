import { app, type BrowserWindow } from 'electron'
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
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
import { RoundMemoryLedger } from '../round-memory-ledger'
import { persistRoundArtifacts, pruneRoundOriginalCache } from '../round-image-cache'
import type { AgentEngine, EngineRuntimeOptions } from './types'

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

function buildFinalFallbackPrompt(input: TaskInput, lastDefectAnalysis: DefectAnalysis | null): string {
  const defectHint =
    lastDefectAnalysis && Array.isArray(lastDefectAnalysis.dimensions)
      ? lastDefectAnalysis.dimensions
          .flatMap((dimension) => dimension.issues.slice(0, 1))
          .filter((issue) => issue.trim().length > 0)
          .slice(0, 3)
          .join('; ')
      : ''

  return defectHint
    ? `Generate a realistic e-commerce image for ${input.productName} in ${input.context}. Fix previous issues: ${defectHint}.`
    : `Generate a realistic e-commerce image for ${input.productName} in ${input.context}.`
}

function buildAttemptSummary(roundsAttempted: number, maxRetries: number): string {
  const maxRounds = maxRetries + 1
  return `${roundsAttempted}/${maxRounds}`
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

    const pushEvent: PushEventFn = (event) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, event)
      }
    }

    const mcpServer = await createMcpServer(vlmBridge, options.provider)
    const memoryLedger = new RoundMemoryLedger({
      retentionRatio: options.retentionRatio,
      thresholds: {
        soft: options.compressionThresholdSoft,
        hard: options.compressionThresholdHard,
        critical: options.compressionThresholdCritical,
      },
    })

    const normalizeImagePaths = (paths: string[]): string[] =>
      paths
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

    const productImagePaths = normalizeImagePaths(input.productImages.map((img) => img.path))
    const referenceImagePaths = input.referenceImages
      ? normalizeImagePaths(input.referenceImages.map((img) => img.path))
      : undefined
    const productImageAngles = input.productImages
      .map((img) => img.angle)
      .filter((a): a is string => Boolean(a))

    let retryCount = 0
    let roundsAttempted = 0
    let lastDefectAnalysis: DefectAnalysis | null = null
    let lastImagePath: string | null = null
    let totalCostUsd = 0
    let terminalFailureReason: string | null = null

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

      const memoryBlock = memoryLedger.buildMemoryPromptBlock()
      const systemPrompt = buildSystemPrompt({
        productName: input.productName,
        context: input.context,
        defectAnalysis: lastDefectAnalysis ?? undefined,
        retryCount,
        scoreThreshold: options.scoreThreshold,
        productImageAngles: productImageAngles.length > 0 ? productImageAngles : undefined,
        userPrompt: input.userPrompt,
        rubricDimensions: options.evaluationRubric.dimensions,
      })
      const composedSystemPrompt = memoryBlock
        ? `${systemPrompt}\n\n## Multi-round memory\n${memoryBlock}`
        : systemPrompt

      pushEvent({
        taskId,
        phase: 'thought',
        message:
          `Round ${roundIndex + 1} started with Claude SDK. product=${input.productName}` +
          `, pass_threshold=${options.scoreThreshold}, max_retries=${options.maxRetries}`,
        retryCount,
        roundIndex,
        timestamp: Date.now(),
      })

      let generatedImagePath: string | null = null
      let previewImagePath: string | null = null
      let contextThumbPath: string | null = null
      let roundEvalScore: number | null = null
      let roundDefect: DefectAnalysis | null = null
      let resultMessage: SDKResultMessage | null = null
      let queryError: string | null = null

      const mcpServerName = `ecom-mcp-${taskId}-${roundIndex}`
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
              pushEvent({
                taskId,
                phase: 'act',
                message: `generate_image args=${JSON.stringify(args)}`,
                retryCount,
                roundIndex,
                timestamp: Date.now(),
              })

              const result = (await mcpServer.callTool('generate_image', {
                ...args,
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
              generatedImagePath = artifacts.generatedImagePath
              previewImagePath = artifacts.previewImagePath
              contextThumbPath = artifacts.contextThumbPath
              lastImagePath = generatedImagePath

              await insertTaskRoundArtifact({
                taskId,
                roundIndex,
                generatedImagePath,
                previewImagePath,
                contextThumbPath,
                score: null,
              })

              pushEvent({
                taskId,
                phase: 'observe',
                message: `round ${roundIndex + 1} image generated`,
                retryCount,
                roundIndex,
                generatedImagePath,
                previewImagePath: previewImagePath ?? generatedImagePath,
                timestamp: Date.now(),
              })

              return {
                content: [{ type: 'text', text: JSON.stringify({ ...result, image_path: generatedImagePath }) }],
                structuredContent: { ...result, image_path: generatedImagePath },
              }
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
              const targetImagePath = (args.image_path ?? generatedImagePath ?? '').trim()
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
                retryCount,
                roundIndex,
                timestamp: Date.now(),
              })

              const result = (await mcpServer.callTool('evaluate_image', evalInput)) as {
                total_score: number
                defect_analysis: DefectAnalysis
                passed: boolean
                pass_threshold: number
              }

              roundEvalScore = result.total_score
              roundDefect = result.defect_analysis

              await updateTaskRoundArtifactScore({
                taskId,
                roundIndex,
                score: roundEvalScore,
              })

              return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result,
              }
            },
          ),
        ],
      })

      const imagePathsHint =
        productImagePaths.length > 0
          ? `\nUse ${productImagePaths.length} product images when calling generate_image.`
          : ''

      const prompt =
        `Generate e-commerce image for product=${input.productName}, scene=${input.context}, sku=${input.skuId}.` +
        imagePathsHint +
        '\nYou must call generate_image first, then call evaluate_image. Do not stop at text output only.'
      const allowedTools = [`mcp__${mcpServerName}__generate_image`, `mcp__${mcpServerName}__evaluate_image`]

      const q = query({
        prompt,
        options: {
          model: options.anthropicModel ?? DEFAULT_MODEL,
          systemPrompt: composedSystemPrompt,
          mcpServers: {
            [mcpServerName]: sdkMcpServer,
          },
          maxTurns: DEFAULT_MAX_TURNS,
          permissionMode: 'default',
          tools: [],
          allowedTools,
          canUseTool: async (toolName) => {
            if (toolName.endsWith('__generate_image') || toolName.endsWith('__evaluate_image')) {
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
          settingSources: [],
        },
      })

      try {
        for await (const msg of q) {
          this.handleSdkMessage(msg, {
            pushEvent,
            taskId,
            retryCount,
            roundIndex,
          })

          if (msg.type === 'result') {
            resultMessage = msg
          }
        }
      } catch (error: unknown) {
        queryError = error instanceof Error ? error.message : String(error)
      }

      let contextUsage: LoopEvent['contextUsage'] | undefined
      try {
        const usage = await q.getContextUsage()
        contextUsage = {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
        }
      } catch {
        contextUsage = this.deriveContextUsageFromResult(
          resultMessage,
          options.anthropicModel ?? DEFAULT_MODEL,
        )
      } finally {
        q.close()
      }

      if (resultMessage?.total_cost_usd) {
        totalCostUsd += resultMessage.total_cost_usd
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

      const resultDiagnostics = resultMessage ? this.collectResultDiagnostics(resultMessage) : null
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

      const keywords = roundDefect.dimensions
        .flatMap((dimension) => [dimension.name, ...dimension.issues.slice(0, 2)])
        .filter((item) => item && item.trim().length > 0)
        .slice(0, 10)

      memoryLedger.addEntry({
        roundIndex,
        promptSummary:
          resultMessage && resultMessage.type === 'result' && resultMessage.subtype === 'success'
            ? resultMessage.result.slice(0, 180)
            : `round ${roundIndex + 1} completed`,
        actionSummary: `generated and evaluated image with score ${roundEvalScore}`,
        score: roundEvalScore,
        defectAnalysis: roundDefect,
        keywords,
        generatedImagePath,
        contextThumbPath,
      })

      if (contextUsage) {
        const level = memoryLedger.updateCompressionByUsage(contextUsage.percentage)
        if (level !== 'none') {
          pushEvent({
            taskId,
            phase: 'observe',
            message: `context usage ${contextUsage.percentage.toFixed(1)}%, compression level=${level.toUpperCase()}`,
            retryCount,
            roundIndex,
            contextUsage,
            timestamp: Date.now(),
          })
        }
      }

      await pruneRoundOriginalCache({
        taskId,
        keepRoundIndexes: memoryLedger.getKeepRoundIndexes(),
        maxOriginalRounds: DEFAULT_MAX_ORIGINAL_ROUNDS,
      })

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
        prompt: buildFinalFallbackPrompt(params.input, params.lastDefectAnalysis),
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

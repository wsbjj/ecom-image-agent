import { app, type BrowserWindow } from 'electron'
import type { Codex as CodexClient, Usage as CodexUsage } from '@openai/codex-sdk'
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

const DEFAULT_MODEL = 'gpt-5.4'
const DEFAULT_MAX_ORIGINAL_ROUNDS = 12
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

type RoundFailureType = 'no_generate' | 'no_evaluate' | 'query_error' | 'parse_error'

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
  queryError: string | null
}

interface CompressionThresholds {
  soft: number
  hard: number
  critical: number
}

type CompressionMode = 'none' | 'soft' | 'hard' | 'critical'
type PushEventFn = (event: LoopEvent) => void

const DRAFT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    draft_prompt: { type: 'string' },
    round_summary: { type: 'string' },
  },
  required: ['draft_prompt'],
  additionalProperties: false,
} as const

type CodexCtor = typeof import('@openai/codex-sdk').Codex
let codexCtorPromise: Promise<CodexCtor> | null = null

async function getCodexCtor(): Promise<CodexCtor> {
  if (!codexCtorPromise) {
    codexCtorPromise = import('@openai/codex-sdk').then((mod) => mod.Codex)
  }
  return codexCtorPromise
}

async function createCodexClient(options: {
  apiKey: string
  baseUrl?: string
}): Promise<CodexClient> {
  const Codex = await getCodexCtor()
  return new Codex(options)
}

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
      ? '\nContext pressure is CRITICAL. Keep response and draft prompt concise.'
      : params.compressionMode === 'hard'
        ? '\nContext pressure is HIGH. Avoid repeating previous rounds.'
        : params.compressionMode === 'soft'
          ? '\nContext usage is rising. Keep this round concise.'
          : ''

  const productImageHint =
    params.productImageCount > 0
      ? `\nUse ${params.productImageCount} product images when generating the draft prompt.`
      : ''

  return (
    `Round ${params.roundIndex + 1}: generate an e-commerce image for product=${params.input.productName}, scene=${params.input.context}, sku=${params.input.skuId}.` +
    productImageHint +
    issueBlock +
    compressionHint +
    `\nTarget pass threshold is ${params.scoreThreshold}.` +
    '\nReturn a strict JSON object with field `draft_prompt` only.'
  )
}

function parseDraftPrompt(rawText: string): string | null {
  const trimmed = rawText.trim()
  if (!trimmed) return null

  const candidates: string[] = [trimmed]
  const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (jsonFenceMatch?.[1]) {
    candidates.push(jsonFenceMatch[1].trim())
  }
  const genericFenceMatch = trimmed.match(/```\s*([\s\S]*?)```/)
  if (genericFenceMatch?.[1]) {
    candidates.push(genericFenceMatch[1].trim())
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim())
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter((candidate) => candidate.length > 0)))
  for (const candidate of uniqueCandidates) {
    try {
      const payload = JSON.parse(candidate) as { draft_prompt?: unknown }
      if (typeof payload.draft_prompt === 'string') {
        const draftPrompt = payload.draft_prompt.trim()
        if (draftPrompt.length > 0) {
          return draftPrompt
        }
      }
    } catch {
      // Ignore and try next candidate.
    }
  }

  return null
}

export class CodexSdkAgentEngine implements AgentEngine {
  readonly name = 'codex_sdk' as const

  async run(
    input: TaskInput,
    win: BrowserWindow,
    vlmBridge: VLMEvalBridge,
    signal: AbortSignal,
    options: EngineRuntimeOptions,
  ): Promise<void> {
    if (!options.codexApiKey) {
      throw new Error('CODEX_API_KEY is required when AGENT_ENGINE=codex_sdk')
    }

    const taskId = input.taskId ?? 'unknown-task'
    const readyDir = path.join(app.getPath('userData'), 'ready_to_publish')
    const failedDir = path.join(app.getPath('userData'), 'failed')
    await fs.mkdir(readyDir, { recursive: true })
    await fs.mkdir(failedDir, { recursive: true })

    const isolatedProjectDir = path.join(app.getPath('userData'), 'codex_sdk_task_projects', taskId)
    await fs.mkdir(isolatedProjectDir, { recursive: true })

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

    const model = options.codexModel ?? DEFAULT_MODEL
    const codex = await createCodexClient({
      apiKey: options.codexApiKey,
      ...(options.codexBaseUrl ? { baseUrl: options.codexBaseUrl } : {}),
    })
    const thread = codex.startThread({
      model,
      workingDirectory: isolatedProjectDir,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    })

    pushEvent({
      taskId,
      phase: 'observe',
      message: `Codex SDK initialized. model=${model}, sandbox=read-only, approval=never`,
      retryCount,
      roundIndex: retryCount,
      timestamp: Date.now(),
    })

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

      const activeRoundState = createActiveRoundState(roundIndex, retryCount)

      pushEvent({
        taskId,
        phase: 'thought',
        message:
          `Round ${roundIndex + 1} started with Codex SDK. product=${input.productName}` +
          `, pass_threshold=${options.scoreThreshold}, max_retries=${options.maxRetries}`,
        retryCount,
        roundIndex,
        timestamp: Date.now(),
      })

      let contextUsage: LoopEvent['contextUsage'] | undefined
      let resultDiagnostics: ResultDiagnostics | null = null
      let draftPrompt: string | null = null

      try {
        const turn = await thread.run(
          `${baseSystemPrompt}\n\n${roundInstruction}`,
          {
            outputSchema: DRAFT_OUTPUT_SCHEMA,
            signal,
          },
        )

        contextUsage = this.deriveContextUsageFromUsage(turn.usage, model)
        if (contextUsage) {
          latestContextUsagePercentage = contextUsage.percentage
        }

        draftPrompt = parseDraftPrompt(turn.finalResponse)
        if (!draftPrompt) {
          resultDiagnostics = {
            failureTypes: ['parse_error'],
            detail: 'codex_response_parse_failed',
          }
          pushEvent({
            taskId,
            phase: 'observe',
            message: 'Codex draft parsing failed, fallback prompt will be used.',
            retryCount,
            roundIndex,
            contextUsage,
            timestamp: Date.now(),
          })
        }
      } catch (error: unknown) {
        activeRoundState.queryError = error instanceof Error ? error.message : String(error)
      }

      const draftForGeneration =
        draftPrompt ?? buildFallbackDraftPrompt(input.productName, input.context)

      if (!activeRoundState.queryError) {
        const enforcedPrompt = buildEnforcedGenerationPrompt({
          productName: input.productName,
          context: input.context,
          userPrompt: input.userPrompt,
          modelPrompt: draftForGeneration,
          defectAnalysis: lastDefectAnalysis,
          roundIndex,
        })

        pushEvent({
          taskId,
          phase: 'act',
          message: `generate_image prompt=${JSON.stringify(enforcedPrompt)}`,
          retryCount,
          roundIndex,
          contextUsage,
          timestamp: Date.now(),
        })

        try {
          const result = (await mcpServer.callTool('generate_image', {
            prompt: enforcedPrompt,
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
            retryCount,
            roundIndex,
            generatedImagePath: artifacts.generatedImagePath,
            previewImagePath: artifacts.previewImagePath ?? artifacts.generatedImagePath,
            contextUsage,
            timestamp: Date.now(),
          })
        } catch (error: unknown) {
          activeRoundState.queryError = error instanceof Error ? error.message : String(error)
        }
      }

      if (activeRoundState.generatedImagePath && activeRoundState.roundEvalScore === null) {
        try {
          const evalResult = (await mcpServer.callTool('evaluate_image', {
            image_path: activeRoundState.generatedImagePath,
            product_name: input.productName,
            context: input.context,
            rubric: options.evaluationRubric,
            pass_threshold: options.scoreThreshold,
          })) as {
            total_score: number
            defect_analysis: DefectAnalysis
          }

          activeRoundState.roundEvalScore = evalResult.total_score
          activeRoundState.roundDefect = evalResult.defect_analysis
          await updateTaskRoundArtifactScore({
            taskId,
            roundIndex,
            score: evalResult.total_score,
            contextUsage: contextUsage ? JSON.stringify(contextUsage) : null,
          })
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          activeRoundState.queryError = activeRoundState.queryError ?? errorMessage
        }
      }

      if (activeRoundState.queryError) {
        pushEvent({
          taskId,
          phase: 'observe',
          message: `Codex SDK query error: ${activeRoundState.queryError}`,
          retryCount,
          roundIndex,
          contextUsage,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })
      }

      if (resultDiagnostics) {
        pushEvent({
          taskId,
          phase: 'observe',
          message: `Codex SDK round diagnostics: ${resultDiagnostics.detail}`,
          retryCount,
          roundIndex,
          contextUsage,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })
      }

      let generatedImagePath = activeRoundState.generatedImagePath
      let previewImagePath = activeRoundState.previewImagePath
      let contextThumbPath = activeRoundState.contextThumbPath
      let roundEvalScore = activeRoundState.roundEvalScore
      let roundDefect = activeRoundState.roundDefect

      if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
        const roundFailure = buildRoundFailureDiagnostics({
          generatedImagePath,
          roundEvalScore,
          queryError: activeRoundState.queryError,
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

  private deriveContextUsageFromUsage(
    usage: CodexUsage | null,
    modelName: string,
  ): LoopEvent['contextUsage'] | undefined {
    if (!usage) return undefined

    const totalTokens = usage.input_tokens + usage.cached_input_tokens + usage.output_tokens
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined

    const maxTokens = this.estimateContextWindowTokens(modelName)
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return undefined

    return {
      totalTokens: Math.round(totalTokens),
      maxTokens: Math.round(maxTokens),
      percentage: Math.min(100, Math.max(0, (totalTokens / maxTokens) * 100)),
    }
  }

  private estimateContextWindowTokens(_modelName: string): number {
    return DEFAULT_CONTEXT_WINDOW_TOKENS
  }
}

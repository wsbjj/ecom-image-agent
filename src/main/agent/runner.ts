import Anthropic from '@anthropic-ai/sdk'
import { BrowserWindow, app } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { LoopEvent, TaskInput, DefectAnalysis, EvalRubric } from '../../shared/types'
import { createMcpServer, type McpServer } from './mcp-server'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { ImageProvider } from './providers/base'
import { buildSystemPrompt } from './prompt-builder'
import { updateTaskSuccess, updateTaskFailed } from '../db/queries'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_SCORE_THRESHOLD = 85
const COST_PER_INPUT_TOKEN = 3 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000

type RoundFailureType =
  | 'no_generate'
  | 'no_evaluate'
  | 'permission_denied'
  | 'max_turns'
  | 'query_error'
  | 'result_error'

interface RoundFailureDiagnosticsInput {
  generatedImagePath: string | null
  roundEvalScore: number | null
  queryError: string | null
  stopReason: string | null
  modelTurns: number
  failureSignals: Set<RoundFailureType>
}

function normalizeFailureTypes(types: Iterable<RoundFailureType>): RoundFailureType[] {
  return Array.from(new Set(types))
}

function buildRoundFailureDiagnostics(input: RoundFailureDiagnosticsInput): {
  failureTypes: RoundFailureType[]
  detail: string
} {
  const failureTypes = new Set<RoundFailureType>(input.failureSignals)
  if (!input.generatedImagePath) {
    failureTypes.add('no_generate')
  }
  if (input.generatedImagePath && input.roundEvalScore === null) {
    failureTypes.add('no_evaluate')
  }
  if (input.queryError) {
    failureTypes.add('query_error')
  }
  if (input.stopReason === 'max_tokens' || input.stopReason === 'pause_turn') {
    failureTypes.add('max_turns')
  }

  const normalizedFailureTypes = normalizeFailureTypes(failureTypes)
  const detailParts = [
    `failure_types=${normalizedFailureTypes.join(',') || 'unknown'}`,
    `stop_reason=${input.stopReason ?? 'null'}`,
    `num_turns=${input.modelTurns}`,
    `query_error=${input.queryError ?? 'none'}`,
  ]
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

export async function runAgentLoop(
  input: TaskInput,
  win: BrowserWindow,
  vlmBridge: VLMEvalBridge,
  signal: AbortSignal,
  options: {
    provider: ImageProvider
    anthropicApiKey: string
    anthropicBaseUrl?: string
    anthropicModel?: string
    maxRetries?: number
    scoreThreshold?: number
    evaluationRubric: EvalRubric
  },
): Promise<void> {
  const taskId = input.taskId ?? uuidv4()
  const readyDir = path.join(app.getPath('userData'), 'ready_to_publish')
  const failedDir = path.join(app.getPath('userData'), 'failed')
  await fs.mkdir(readyDir, { recursive: true })
  await fs.mkdir(failedDir, { recursive: true })

  let retryCount = 0
  let roundsAttempted = 0
  const maxRetries =
    typeof options.maxRetries === 'number' && Number.isInteger(options.maxRetries)
      ? Math.max(0, options.maxRetries)
      : DEFAULT_MAX_RETRIES
  const scoreThreshold =
    typeof options.scoreThreshold === 'number' && Number.isInteger(options.scoreThreshold)
      ? Math.min(100, Math.max(0, options.scoreThreshold))
      : DEFAULT_SCORE_THRESHOLD
  let lastDefectAnalysis: DefectAnalysis | null = null
  let lastImagePath: string | null = null
  let totalCostUsd = 0
  let terminalFailureReason: string | null = null

  const pushEvent = (event: LoopEvent): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, event)
    }
  }

  const mcpServer: McpServer = await createMcpServer(vlmBridge, options.provider)
  const anthropic = new Anthropic({
    apiKey: options.anthropicApiKey,
    ...(options.anthropicBaseUrl ? { baseURL: options.anthropicBaseUrl } : {}),
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

  while (retryCount <= maxRetries) {
    if (signal.aborted) {
      pushEvent({
        taskId,
        phase: 'failed',
        message: '任务已手动中止',
        retryCount,
        roundIndex: retryCount,
        timestamp: Date.now(),
      })
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
      return
    }

    const roundIndex = retryCount
    const isLastRound = roundIndex >= maxRetries
    roundsAttempted = roundIndex + 1

    const systemPrompt = buildSystemPrompt({
      productName: input.productName,
      context: input.context,
      defectAnalysis: lastDefectAnalysis ?? undefined,
      retryCount,
      scoreThreshold,
      productImageAngles: productImageAngles.length > 0 ? productImageAngles : undefined,
      userPrompt: input.userPrompt,
      rubricDimensions: options.evaluationRubric.dimensions,
    })

    pushEvent({
      taskId,
      phase: 'thought',
      message:
        `[第 ${roundIndex + 1} 轮] 开始推理 -> 商品: ${input.productName}` +
        `（通过阈值 >= ${scoreThreshold}，最大重试 ${maxRetries}）`,
      retryCount,
      roundIndex,
      timestamp: Date.now(),
    })

    let generatedImagePath: string | null = null
    let roundEvalScore: number | null = null
    let roundDefect: DefectAnalysis | null = null
    let queryError: string | null = null
    let lastStopReason: string | null = null
    let modelTurns = 0
    const failureSignals = new Set<RoundFailureType>()

    const toolDefs = mcpServer.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const imagePathsHint =
      productImagePaths.length > 0
        ? `\n已提供 ${productImagePaths.length} 张白底商品图，调用 generate_image 时请传入 product_image_paths=${JSON.stringify(productImagePaths)}${referenceImagePaths?.length ? `，参考风格图 reference_image_paths=${JSON.stringify(referenceImagePaths)}` : ''}`
        : ''

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `生成电商精品图：商品名称=${input.productName}，场景=${input.context}，SKU=${input.skuId}。` +
          imagePathsHint +
          '\n生成图片后立即调用 evaluate_image 工具进行质量评估。',
      },
    ]

    let continueLoop = true
    while (continueLoop) {
      if (signal.aborted) break

      let response: Awaited<ReturnType<typeof anthropic.messages.create>>
      try {
        response = await anthropic.messages.create({
          model: options.anthropicModel ?? 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          tools: toolDefs,
          messages,
        })
      } catch (error: unknown) {
        queryError = error instanceof Error ? error.message : String(error)
        failureSignals.add('query_error')
        continueLoop = false
        break
      }

      modelTurns += 1
      lastStopReason = response.stop_reason
      totalCostUsd +=
        response.usage.input_tokens * COST_PER_INPUT_TOKEN +
        response.usage.output_tokens * COST_PER_OUTPUT_TOKEN

      if (response.stop_reason !== 'tool_use') {
        continueLoop = false
        break
      }

      const assistantContent = response.content
      messages.push({ role: 'assistant', content: assistantContent })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue

        pushEvent({
          taskId,
          phase: block.name === 'generate_image' ? 'act' : 'observe',
          message: `调用 ${block.name}，参数: ${JSON.stringify(block.input)}`,
          retryCount,
          roundIndex,
          timestamp: Date.now(),
        })

        try {
          const normalizedToolInput =
            block.name === 'generate_image'
              ? {
                  ...(block.input as Record<string, unknown>),
                  product_image_paths: productImagePaths,
                  ...(referenceImagePaths?.length ? { reference_image_paths: referenceImagePaths } : {}),
                  product_name: input.productName,
                  context: input.context,
                  rubric: options.evaluationRubric,
                  pass_threshold: scoreThreshold,
                }
              : block.name === 'evaluate_image'
                ? {
                    ...(block.input as Record<string, unknown>),
                    rubric: options.evaluationRubric,
                    pass_threshold: scoreThreshold,
                  }
                : (block.input as Record<string, unknown>)

          const result = await mcpServer.callTool(block.name, normalizedToolInput)

          if (block.name === 'generate_image') {
            const genResult = result as {
              image_path: string
              debug_info?: {
                request_id?: string
                task_id?: string
                provider_mode?: 'visual_official' | 'openai_compat'
                visual_route?: 't2i' | 'i2i'
                fallback_reason?: string
                product_image_count?: number
                reference_image_count?: number
                used_composite_image?: boolean
              }
            }
            generatedImagePath = genResult.image_path
            lastImagePath = generatedImagePath
            pushEvent({
              taskId,
              phase: 'observe',
              message: `第 ${roundIndex + 1} 轮图片已生成`,
              retryCount,
              roundIndex,
              generatedImagePath,
              previewImagePath: generatedImagePath,
              timestamp: Date.now(),
            })

            if (genResult.debug_info?.request_id || genResult.debug_info?.task_id) {
              const details = [
                genResult.debug_info.provider_mode ? `mode=${genResult.debug_info.provider_mode}` : null,
                genResult.debug_info.visual_route ? `visual_route=${genResult.debug_info.visual_route}` : null,
                genResult.debug_info.request_id ? `request_id=${genResult.debug_info.request_id}` : null,
                genResult.debug_info.task_id ? `task_id=${genResult.debug_info.task_id}` : null,
                typeof genResult.debug_info.product_image_count === 'number'
                  ? `product_images=${genResult.debug_info.product_image_count}`
                  : null,
                typeof genResult.debug_info.reference_image_count === 'number'
                  ? `reference_images=${genResult.debug_info.reference_image_count}`
                  : null,
                typeof genResult.debug_info.used_composite_image === 'boolean'
                  ? `composite=${genResult.debug_info.used_composite_image}`
                  : null,
                genResult.debug_info.fallback_reason
                  ? `fallback=${genResult.debug_info.fallback_reason}`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')
              pushEvent({
                taskId,
                phase: 'observe',
                message: `generate_image debug: ${details}`,
                retryCount,
                roundIndex,
                timestamp: Date.now(),
              })
            }
          }

          if (block.name === 'evaluate_image') {
            const evalRes = result as {
              total_score: number
              defect_analysis: DefectAnalysis
            }
            roundEvalScore = evalRes.total_score
            roundDefect = evalRes.defect_analysis
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          if (block.name === 'generate_image') {
            failureSignals.add('no_generate')
          }
          if (block.name === 'evaluate_image') {
            failureSignals.add('no_evaluate')
          }
          if (/permission|denied|forbidden/i.test(errMsg)) {
            failureSignals.add('permission_denied')
          }
          failureSignals.add('result_error')

          pushEvent({
            taskId,
            phase: 'observe',
            message: `${block.name} 执行失败: ${errMsg}`,
            retryCount,
            roundIndex,
            timestamp: Date.now(),
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${errMsg}`,
            is_error: true,
          })
        }
      }

      messages.push({ role: 'user', content: toolResults })

      if (roundEvalScore !== null) {
        continueLoop = false
      }
    }

    if (signal.aborted) {
      pushEvent({
        taskId,
        phase: 'failed',
        message: '任务已手动中止',
        retryCount,
        roundIndex,
        timestamp: Date.now(),
      })
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
      return
    }

    if (generatedImagePath && roundEvalScore === null) {
      try {
        const evalRes = (await mcpServer.callTool('evaluate_image', {
          image_path: generatedImagePath,
          product_name: input.productName,
          context: input.context,
          rubric: options.evaluationRubric,
          pass_threshold: scoreThreshold,
        })) as { total_score: number; defect_analysis: DefectAnalysis }
        roundEvalScore = evalRes.total_score
        roundDefect = evalRes.defect_analysis
        pushEvent({
          taskId,
          phase: 'observe',
          message: '模型未主动调用 evaluate_image，已自动补充评估',
          retryCount,
          roundIndex,
          timestamp: Date.now(),
        })
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        if (/permission|denied|forbidden/i.test(errMsg)) {
          failureSignals.add('permission_denied')
        }
        failureSignals.add('no_evaluate')
        pushEvent({
          taskId,
          phase: 'observe',
          message: `自动评估失败: ${errMsg}`,
          retryCount,
          roundIndex,
          timestamp: Date.now(),
        })
      }
    }

    if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
      const diagnostics = buildRoundFailureDiagnostics({
        generatedImagePath,
        roundEvalScore,
        queryError,
        stopReason: lastStopReason,
        modelTurns,
        failureSignals,
      })

      if (!isLastRound) {
        pushEvent({
          taskId,
          phase: 'observe',
          message: `Round incomplete, continue retry. ${diagnostics.detail}`,
          retryCount,
          roundIndex,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })
        retryCount += 1
        continue
      }

      pushEvent({
        taskId,
        phase: 'observe',
        message: `Last round fallback start. ${diagnostics.detail}`,
        retryCount,
        roundIndex,
        costUsd: totalCostUsd,
        timestamp: Date.now(),
      })

      try {
        if (!generatedImagePath) {
          const generated = (await mcpServer.callTool('generate_image', {
            prompt: buildFinalFallbackPrompt(input, lastDefectAnalysis),
            product_image_paths: productImagePaths,
            ...(referenceImagePaths?.length ? { reference_image_paths: referenceImagePaths } : {}),
            product_name: input.productName,
            context: input.context,
            rubric: options.evaluationRubric,
            pass_threshold: scoreThreshold,
          })) as { image_path: string }
          generatedImagePath = generated.image_path
          lastImagePath = generatedImagePath

          pushEvent({
            taskId,
            phase: 'observe',
            message: 'Last round fallback generated image',
            retryCount,
            roundIndex,
            generatedImagePath,
            previewImagePath: generatedImagePath,
            timestamp: Date.now(),
          })
        }

        if (!generatedImagePath) {
          throw new Error('fallback generate_image returned empty path')
        }

        if (roundEvalScore === null || !roundDefect) {
          const evalRes = (await mcpServer.callTool('evaluate_image', {
            image_path: generatedImagePath,
            product_name: input.productName,
            context: input.context,
            rubric: options.evaluationRubric,
            pass_threshold: scoreThreshold,
          })) as { total_score: number; defect_analysis: DefectAnalysis }
          roundEvalScore = evalRes.total_score
          roundDefect = evalRes.defect_analysis

          pushEvent({
            taskId,
            phase: 'observe',
            message: 'Last round fallback evaluated image',
            retryCount,
            roundIndex,
            timestamp: Date.now(),
          })
        }
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        terminalFailureReason = `last_round_fallback_failed: ${errMsg}`
        break
      }
    }

    pushEvent({
      taskId,
      phase: 'observe',
      message: `评分结果: ${roundEvalScore} / 100`,
      score: roundEvalScore,
      defectAnalysis: roundDefect,
      costUsd: totalCostUsd,
      retryCount,
      roundIndex,
      generatedImagePath,
      previewImagePath: generatedImagePath,
      timestamp: Date.now(),
    })

    if (roundEvalScore >= scoreThreshold) {
      const destPath = path.join(readyDir, `${taskId}_${retryCount}.png`)
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
        message: `任务成功，评分 ${roundEvalScore}，总费用 $${totalCostUsd.toFixed(4)}`,
        score: roundEvalScore,
        costUsd: totalCostUsd,
        retryCount,
        roundIndex,
        generatedImagePath,
        previewImagePath: generatedImagePath,
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

  const attemptSummary = buildAttemptSummary(Math.max(1, roundsAttempted), maxRetries)
  const reasonSuffix = terminalFailureReason ? `，原因：${terminalFailureReason}` : ''
  pushEvent({
    taskId,
    phase: 'failed',
    message: `任务失败：已尝试 ${attemptSummary} 轮，总费用 $${totalCostUsd.toFixed(4)}${reasonSuffix}`,
    costUsd: totalCostUsd,
    retryCount,
    roundIndex: retryCount,
    timestamp: Date.now(),
  })
}

export const runLegacyAgentLoop = runAgentLoop

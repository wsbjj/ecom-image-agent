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

    const pushEvent = (event: LoopEvent): void => {
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
    let lastDefectAnalysis: DefectAnalysis | null = null
    let lastImagePath: string | null = null
    let totalCostUsd = 0

    while (retryCount <= options.maxRetries) {
      const roundIndex = retryCount

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
        ? `${systemPrompt}\n\n## 多轮记忆上下文\n${memoryBlock}`
        : systemPrompt

      pushEvent({
        taskId,
        phase: 'thought',
        message:
          `Claude SDK 推理开始 → 商品: ${input.productName}` +
          `（通过阈值 >= ${options.scoreThreshold}，最大重试 ${options.maxRetries}）`,
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

      const sdkMcpServer = createSdkMcpServer({
        name: `ecom-mcp-${taskId}-${roundIndex}`,
        tools: [
          tool(
            'generate_image',
            '调用图像生成 API 生成电商精品图，返回本地绝对路径。',
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
                message: `调用 generate_image，参数: ${JSON.stringify(args)}`,
                retryCount,
                roundIndex,
                timestamp: Date.now(),
              })

              const result = (await mcpServer.callTool('generate_image', {
                ...args,
                product_image_paths: productImagePaths,
                ...(referenceImagePaths?.length ? { reference_image_paths: referenceImagePaths } : {}),
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
                message: `第 ${roundIndex + 1} 轮已生成图片`,
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
            '按评估模板打分，返回总分与缺陷。',
            {
              image_path: z.string().optional(),
              product_name: z.string().optional(),
              context: z.string().optional(),
            },
            async (args) => {
              const targetImagePath = (args.image_path ?? generatedImagePath ?? '').trim()
              if (!targetImagePath) {
                return {
                  content: [{ type: 'text', text: 'Error: 尚未生成图片，无法评估' }],
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
                message: `调用 evaluate_image，参数: ${JSON.stringify(evalInput)}`,
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
          ? `\n已提供 ${productImagePaths.length} 张白底商品图，调用 generate_image 时请使用这些图片。`
          : ''

      const prompt =
        `生成电商精品图：商品名称=${input.productName}，场景=${input.context}，SKU=${input.skuId}。` +
        imagePathsHint +
        '\n必须严格按顺序调用 generate_image，再调用 evaluate_image；不要只输出文字结论。'
      const mcpServerName = `ecom-mcp-${roundIndex}`
      const allowedTools = [`mcp__${mcpServerName}__generate_image`, `mcp__${mcpServerName}__evaluate_image`]

      const q = query({
        prompt,
        options: {
          model: options.anthropicModel ?? DEFAULT_MODEL,
          systemPrompt: composedSystemPrompt,
          mcpServers: {
            [mcpServerName]: sdkMcpServer,
          },
          maxTurns: 8,
          permissionMode: 'default',
          tools: [],
          allowedTools,
          canUseTool: async (toolName) => {
            if (toolName.endsWith('__generate_image') || toolName.endsWith('__evaluate_image')) {
              return { behavior: 'allow' }
            }
            return {
              behavior: 'deny',
              message: `不允许调用工具 ${toolName}，仅允许 generate_image/evaluate_image`,
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
        contextUsage = this.deriveContextUsageFromResult(resultMessage)
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
          message: `Claude SDK 执行异常：${queryError}`,
          retryCount,
          roundIndex,
          contextUsage,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })
      }

      const resultDiagnostics = resultMessage ? this.collectResultDiagnostics(resultMessage) : []
      if (resultDiagnostics.length > 0) {
        pushEvent({
          taskId,
          phase: 'observe',
          message: `Claude SDK 回合诊断：${resultDiagnostics.join('；')}`,
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
            message: '模型未主动调用 evaluate_image，已自动补充评估',
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
            message: `自动评估失败：${err}`,
            retryCount,
            roundIndex,
            contextUsage,
            timestamp: Date.now(),
          })
        }
      }

      if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
        const missingSteps: string[] = []
        if (!generatedImagePath) {
          missingSteps.push('未执行 generate_image')
        }
        if (generatedImagePath && roundEvalScore === null) {
          missingSteps.push('未完成 evaluate_image')
        }
        if (resultDiagnostics.length > 0) {
          missingSteps.push(...resultDiagnostics)
        }
        if (queryError) {
          missingSteps.push(`执行异常：${queryError}`)
        }
        const detail = missingSteps.length > 0 ? `（${missingSteps.join('；')}）` : ''
        pushEvent({
          taskId,
          phase: 'failed',
          message: `Agent 未完成完整 generate+evaluate 循环${detail}`,
          retryCount,
          roundIndex,
          contextUsage,
          costUsd: totalCostUsd,
          timestamp: Date.now(),
        })
        break
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
            : `第 ${roundIndex + 1} 轮执行完成`,
        actionSummary: `生成并评估图片，得分 ${roundEvalScore}`,
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
            message: `上下文占用 ${contextUsage.percentage.toFixed(1)}%，触发 ${level.toUpperCase()} 压缩策略`,
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
        message: `评分结果: ${roundEvalScore} / 100`,
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
          message: `任务成功！评分 ${roundEvalScore}，总费用 $${totalCostUsd.toFixed(4)}`,
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
    pushEvent({
      taskId,
      phase: 'failed',
      message: `任务失败：已重试 ${options.maxRetries} 次，总费用 $${totalCostUsd.toFixed(4)}`,
      retryCount,
      roundIndex: retryCount,
      costUsd: totalCostUsd,
      timestamp: Date.now(),
    })
  }

  private collectResultDiagnostics(message: SDKResultMessage): string[] {
    const diagnostics: string[] = []

    if (message.subtype !== 'success') {
      diagnostics.push(`result=${message.subtype}`)
      if (message.errors.length > 0) {
        diagnostics.push(`errors=${message.errors.slice(0, 2).join(' | ')}`)
      }
      return diagnostics
    }

    if (message.permission_denials.length > 0) {
      const deniedTools = Array.from(
        new Set(message.permission_denials.map((item) => item.tool_name.trim()).filter((name) => name.length > 0)),
      )
      diagnostics.push(`permission_denials=${deniedTools.join(', ')}`)
    }

    if (message.num_turns >= 8 && !message.deferred_tool_use) {
      diagnostics.push('达到 maxTurns 但未检测到完整工具链')
    }

    return diagnostics
  }

  private deriveContextUsageFromResult(
    message: SDKResultMessage | null,
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

    const maxTokens = usage.contextWindow ?? usage.context_window ?? 0

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
        message: 'Claude SDK 正在自动压缩上下文',
        retryCount: ctx.retryCount,
        roundIndex: ctx.roundIndex,
        timestamp: Date.now(),
      })
    }

    if (message.type === 'system' && message.subtype === 'memory_recall') {
      ctx.pushEvent({
        taskId: ctx.taskId,
        phase: 'observe',
        message: `触发记忆召回：${message.memories.length} 条`,
        retryCount: ctx.retryCount,
        roundIndex: ctx.roundIndex,
        timestamp: Date.now(),
      })
    }
  }
}

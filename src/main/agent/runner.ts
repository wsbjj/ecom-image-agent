import Anthropic from '@anthropic-ai/sdk'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { LoopEvent, TaskInput, DefectAnalysis } from '../../shared/types'
import { createMcpServer, type McpServer } from './mcp-server'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { ImageProvider } from './providers/base'
import { buildSystemPrompt } from './prompt-builder'
import { updateTaskSuccess, updateTaskFailed } from '../db/queries'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'

const MAX_RETRIES = 3
const SCORE_THRESHOLD = 85
const COST_PER_INPUT_TOKEN = 3 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000

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
  },
): Promise<void> {
  const taskId = input.taskId ?? uuidv4()
  const readyDir = path.join(app.getPath('userData'), 'ready_to_publish')
  const failedDir = path.join(app.getPath('userData'), 'failed')
  await fs.mkdir(readyDir, { recursive: true })
  await fs.mkdir(failedDir, { recursive: true })

  let retryCount = 0
  let lastDefectAnalysis: DefectAnalysis | null = null
  let lastImagePath: string | null = null
  let totalCostUsd = 0

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

  while (retryCount <= MAX_RETRIES) {
    if (signal.aborted) {
      pushEvent({
        taskId,
        phase: 'failed',
        message: '任务已手动中止',
        retryCount,
        timestamp: Date.now(),
      })
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
      return
    }

    const systemPrompt = buildSystemPrompt({
      productName: input.productName,
      context: input.context,
      defectAnalysis: lastDefectAnalysis ?? undefined,
      retryCount,
      productImageAngles: productImageAngles.length > 0 ? productImageAngles : undefined,
      userPrompt: input.userPrompt,
    })

    pushEvent({
      taskId,
      phase: 'thought',
      message: `[第 ${retryCount + 1} 轮] 开始推理 → 商品: ${input.productName}`,
      retryCount,
      timestamp: Date.now(),
    })

    let generatedImagePath: string | null = null
    let roundEvalScore: number | null = null
    let roundDefect: DefectAnalysis | null = null

    const toolDefs = mcpServer.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const imagePathsHint = productImagePaths.length > 0
      ? `\n已提供 ${productImagePaths.length} 张白底商品图，调用 generate_image 时请传入 product_image_paths=${JSON.stringify(productImagePaths)}${referenceImagePaths?.length ? `，参考风格图 reference_image_paths=${JSON.stringify(referenceImagePaths)}` : ''}`
      : ''

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `生成电商精品图：商品名称=${input.productName}，场景=${input.context}，SKU=${input.skuId}。` +
          imagePathsHint +
          `\n生成图片后立即调用 evaluate_image 工具进行质量评估。`,
      },
    ]

    let continueLoop = true
    while (continueLoop) {
      if (signal.aborted) break

      const response = await anthropic.messages.create({
        model: options.anthropicModel ?? 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      })

      totalCostUsd +=
        (response.usage.input_tokens) * COST_PER_INPUT_TOKEN +
        (response.usage.output_tokens) * COST_PER_OUTPUT_TOKEN

      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
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
          timestamp: Date.now(),
        })

        try {
          const normalizedToolInput =
            block.name === 'generate_image'
              ? {
                  ...(block.input as Record<string, unknown>),
                  // Force using user-uploaded local image paths to prevent model hallucinated paths.
                  product_image_paths: productImagePaths,
                  ...(referenceImagePaths?.length
                    ? { reference_image_paths: referenceImagePaths }
                    : {}),
                }
              : (block.input as Record<string, unknown>)

          const result = await mcpServer.callTool(
            block.name,
            normalizedToolInput,
          )

          if (block.name === 'generate_image') {
            const genResult = result as {
              image_path: string
              debug_info?: {
                request_id?: string
                task_id?: string
                provider_mode?: 'visual_official' | 'openai_compat'
                fallback_reason?: string
              }
            }
            generatedImagePath = genResult.image_path
            lastImagePath = generatedImagePath
            if (
              genResult.debug_info?.request_id ||
              genResult.debug_info?.task_id ||
              genResult.debug_info?.provider_mode ||
              genResult.debug_info?.fallback_reason
            ) {
              const details = [
                genResult.debug_info.provider_mode
                  ? `mode=${genResult.debug_info.provider_mode}`
                  : null,
                genResult.debug_info.request_id
                  ? `request_id=${genResult.debug_info.request_id}`
                  : null,
                genResult.debug_info.task_id
                  ? `task_id=${genResult.debug_info.task_id}`
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
                message: `generate_image 调试信息: ${details}`,
                retryCount,
                timestamp: Date.now(),
              })
            }
          }

          if (block.name === 'evaluate_image') {
            const evalRes = result as { total_score: number; defect_analysis: DefectAnalysis }
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
          pushEvent({
            taskId,
            phase: 'observe',
            message: `${block.name} 执行失败：${errMsg}`,
            retryCount,
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
        timestamp: Date.now(),
      })
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
      return
    }

    // Fallback: if model generated image but skipped evaluate_image, run evaluation automatically.
    if (generatedImagePath && roundEvalScore === null) {
      try {
        const evalRes = await mcpServer.callTool('evaluate_image', {
          image_path: generatedImagePath,
          product_name: input.productName,
          context: input.context,
        }) as { total_score: number; defect_analysis: DefectAnalysis }
        roundEvalScore = evalRes.total_score
        roundDefect = evalRes.defect_analysis
        pushEvent({
          taskId,
          phase: 'observe',
          message: '模型未主动调用 evaluate_image，已自动补充评估',
          retryCount,
          timestamp: Date.now(),
        })
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        pushEvent({
          taskId,
          phase: 'observe',
          message: `自动评估失败：${errMsg}`,
          retryCount,
          timestamp: Date.now(),
        })
      }
    }

    if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
      pushEvent({
        taskId,
        phase: 'failed',
        message: 'Agent 未完成完整 generate+evaluate 循环',
        retryCount,
        timestamp: Date.now(),
      })
      break
    }

    pushEvent({
      taskId,
      phase: 'observe',
      message: `评分结果: ${roundEvalScore} / 100`,
      score: roundEvalScore,
      defectAnalysis: roundDefect,
      costUsd: totalCostUsd,
      retryCount,
      timestamp: Date.now(),
    })

    if (roundEvalScore >= SCORE_THRESHOLD) {
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
        message: `任务成功！评分 ${roundEvalScore}，总费用 $${totalCostUsd.toFixed(4)}`,
        score: roundEvalScore,
        costUsd: totalCostUsd,
        retryCount,
        timestamp: Date.now(),
      })
      return
    }

    lastDefectAnalysis = roundDefect
    retryCount++
  }

  if (lastImagePath) {
    const destPath = path.join(failedDir, `${taskId}_final.png`)
    await fs.copyFile(lastImagePath, destPath)
  }
  await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd })
  pushEvent({
    taskId,
    phase: 'failed',
    message: `任务失败：已重试 ${MAX_RETRIES} 次，总费用 $${totalCostUsd.toFixed(4)}`,
    costUsd: totalCostUsd,
    retryCount,
    timestamp: Date.now(),
  })
}

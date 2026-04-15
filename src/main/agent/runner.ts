import Anthropic from '@anthropic-ai/sdk'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { LoopEvent, TaskInput, DefectAnalysis } from '../../shared/types'
import { createMcpServer, type McpServer } from './mcp-server'
import type { VLMEvalBridge } from './vlmeval-bridge'
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
    googleApiKey: string
    googleBaseUrl?: string
    googleImageModel?: string
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

  const mcpServer: McpServer = await createMcpServer(vlmBridge, {
    googleApiKey: options.googleApiKey,
    googleBaseUrl: options.googleBaseUrl,
    googleImageModel: options.googleImageModel,
  })
  const anthropic = new Anthropic({
    apiKey: options.anthropicApiKey,
    ...(options.anthropicBaseUrl ? { baseURL: options.anthropicBaseUrl } : {}),
  })

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

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `生成电商精品图：商品名称=${input.productName}，场景=${input.context}，SKU=${input.skuId}。` +
          `生成图片后立即调用 evaluate_image 工具进行质量评估。`,
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
          const result = await mcpServer.callTool(
            block.name,
            block.input as Record<string, unknown>,
          )

          if (block.name === 'generate_image') {
            const genResult = result as { image_path: string }
            generatedImagePath = genResult.image_path
            lastImagePath = generatedImagePath
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { DefectAnalysis } from '../../../src/shared/types'

const {
  mockMessagesCreate,
  mockCreateMcpServer,
  mockUpdateTaskSuccess,
  mockUpdateTaskFailed,
  mockMkdir,
  mockCopyFile,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockCreateMcpServer: vi.fn(),
  mockUpdateTaskSuccess: vi.fn(),
  mockUpdateTaskFailed: vi.fn(),
  mockMkdir: vi.fn(),
  mockCopyFile: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockMessagesCreate }
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
}))

vi.mock('../../../src/main/agent/mcp-server', () => ({
  createMcpServer: mockCreateMcpServer,
}))

vi.mock('../../../src/main/db/queries', () => ({
  updateTaskSuccess: mockUpdateTaskSuccess,
  updateTaskFailed: mockUpdateTaskFailed,
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
}))

import { runAgentLoop } from '../../../src/main/agent/runner'

function createWindowCollector(): {
  win: BrowserWindow
  events: Array<{ channel: string; payload: unknown }>
} {
  const events: Array<{ channel: string; payload: unknown }> = []
  return {
    win: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          events.push({ channel, payload })
        },
      },
    } as unknown as BrowserWindow,
    events,
  }
}

function createInput(taskId = 'task-legacy-1') {
  return {
    taskId,
    skuId: 'SKU-001',
    productName: 'Liquid Bottle',
    context: 'warm studio lighting',
    templateId: 1,
    productImages: [{ path: '/images/p1.png' }],
  }
}

function createEvalRubric() {
  return {
    dimensions: [
      {
        key: 'overall_quality',
        name: 'Overall',
        maxScore: 100,
        weight: 1,
        description: 'overall',
      },
    ],
  }
}

function createScoreResponse(score: number, defects?: DefectAnalysis) {
  return {
    total_score: score,
    defect_analysis:
      defects ??
      ({
        dimensions: [],
        overall_recommendation: 'ok',
      } as DefectAnalysis),
  }
}

describe('runAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockCopyFile.mockResolvedValue(undefined)
    mockUpdateTaskSuccess.mockResolvedValue(undefined)
    mockUpdateTaskFailed.mockResolvedValue(undefined)
  })

  it('continues retry when generate_image is missing instead of failing immediately', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 10,
      },
    })

    mockCreateMcpServer.mockResolvedValue({
      tools: [
        { name: 'generate_image', description: 'generate', inputSchema: {} },
        { name: 'evaluate_image', description: 'evaluate', inputSchema: {} },
      ],
      callTool: vi.fn(async () => {
        throw new Error('fallback generate failed')
      }),
    })

    const { win, events } = createWindowCollector()
    const controller = new AbortController()

    await runAgentLoop(
      createInput('task-legacy-retry'),
      win,
      {} as never,
      controller.signal,
      {
        provider: {} as never,
        anthropicApiKey: 'test-key',
        maxRetries: 1,
        scoreThreshold: 90,
        evaluationRubric: createEvalRubric(),
      },
    )

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    const thoughtCount = payloads.filter((item) => item.phase === 'thought').length
    expect(thoughtCount).toBe(2)

    const finalFailure = payloads.filter((item) => item.phase === 'failed').at(-1)
    expect(finalFailure?.message).toContain('2/2')
    expect(finalFailure?.message).toContain('last_round_fallback_failed')
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)
  })

  it('uses last-round fallback generate + evaluate and succeeds', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [],
      usage: {
        input_tokens: 5,
        output_tokens: 5,
      },
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return { image_path: '/tmp/fallback-generated.png' }
      }
      if (name === 'evaluate_image') {
        return createScoreResponse(97)
      }
      throw new Error(`unknown tool: ${name}`)
    })

    mockCreateMcpServer.mockResolvedValue({
      tools: [
        { name: 'generate_image', description: 'generate', inputSchema: {} },
        { name: 'evaluate_image', description: 'evaluate', inputSchema: {} },
      ],
      callTool,
    })

    const { win, events } = createWindowCollector()
    const controller = new AbortController()

    await runAgentLoop(
      createInput('task-legacy-fallback-success'),
      win,
      {} as never,
      controller.signal,
      {
        provider: {} as never,
        anthropicApiKey: 'test-key',
        maxRetries: 0,
        scoreThreshold: 90,
        evaluationRubric: createEvalRubric(),
      },
    )

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      'generate_image',
      expect.objectContaining({
        product_image_paths: ['/images/p1.png'],
        product_name: 'Liquid Bottle',
        context: 'warm studio lighting',
        rubric: createEvalRubric(),
        pass_threshold: 90,
      }),
    )
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'evaluate_image',
      expect.objectContaining({
        image_path: '/tmp/fallback-generated.png',
      }),
    )
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.some((item) => item.phase === 'success')).toBe(true)
  })

  it('keeps final failure actionable when last-round fallback fails', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    })

    const callTool = vi.fn(async () => {
      throw new Error('generate API unavailable')
    })

    mockCreateMcpServer.mockResolvedValue({
      tools: [
        { name: 'generate_image', description: 'generate', inputSchema: {} },
        { name: 'evaluate_image', description: 'evaluate', inputSchema: {} },
      ],
      callTool,
    })

    const { win, events } = createWindowCollector()
    const controller = new AbortController()

    await runAgentLoop(
      createInput('task-legacy-fallback-fail'),
      win,
      {} as never,
      controller.signal,
      {
        provider: {} as never,
        anthropicApiKey: 'test-key',
        maxRetries: 0,
        scoreThreshold: 95,
        evaluationRubric: createEvalRubric(),
      },
    )

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    const failed = payloads.filter((item) => item.phase === 'failed').at(-1)
    expect(failed?.message).toContain('1/1')
    expect(failed?.message).toContain('last_round_fallback_failed')
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)
  })
})

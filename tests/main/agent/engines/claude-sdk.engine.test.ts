import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { TaskInput, DefectAnalysis } from '../../../../src/shared/types'

const {
  mockCreateSdkMcpServer,
  mockQuery,
  mockTool,
  mockCreateMcpServer,
  mockInsertTaskRoundArtifact,
  mockUpdateTaskRoundArtifactScore,
  mockUpdateTaskSuccess,
  mockUpdateTaskFailed,
  mockPersistRoundArtifacts,
  mockPruneRoundOriginalCache,
  mockMkdir,
  mockCopyFile,
} = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn(),
  mockQuery: vi.fn(),
  mockTool: vi.fn(),
  mockCreateMcpServer: vi.fn(),
  mockInsertTaskRoundArtifact: vi.fn(),
  mockUpdateTaskRoundArtifactScore: vi.fn(),
  mockUpdateTaskSuccess: vi.fn(),
  mockUpdateTaskFailed: vi.fn(),
  mockPersistRoundArtifacts: vi.fn(),
  mockPruneRoundOriginalCache: vi.fn(),
  mockMkdir: vi.fn(),
  mockCopyFile: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  query: mockQuery,
  tool: mockTool,
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
}))

vi.mock('../../../../src/main/agent/mcp-server', () => ({
  createMcpServer: mockCreateMcpServer,
}))

vi.mock('../../../../src/main/db/queries', () => ({
  insertTaskRoundArtifact: mockInsertTaskRoundArtifact,
  updateTaskRoundArtifactScore: mockUpdateTaskRoundArtifactScore,
  updateTaskSuccess: mockUpdateTaskSuccess,
  updateTaskFailed: mockUpdateTaskFailed,
}))

vi.mock('../../../../src/main/agent/round-image-cache', () => ({
  persistRoundArtifacts: mockPersistRoundArtifacts,
  pruneRoundOriginalCache: mockPruneRoundOriginalCache,
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
}))

import { ClaudeSdkAgentEngine } from '../../../../src/main/agent/engines/claude-sdk.engine'

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

function createInput(taskId = 'task-claude-1'): TaskInput {
  return {
    taskId,
    skuId: 'SKU-001',
    productName: 'Liquid Bottle',
    context: 'warm studio lighting',
    templateId: 1,
    productImages: [{ path: '/images/p1.png' }],
  }
}

function createOptions(maxRetries: number) {
  return {
    provider: {} as never,
    anthropicApiKey: 'test-key',
    anthropicBaseUrl: undefined,
    anthropicModel: 'claude-sonnet-4-20250514',
    maxRetries,
    scoreThreshold: 90,
    evaluationTemplate: {
      id: 1,
      name: 'default',
      version: 1,
      default_threshold: 90,
      rubric_json: '{}',
      created_at: new Date().toISOString(),
    },
    evaluationRubric: {
      dimensions: [
        {
          key: 'overall_quality',
          name: 'Overall',
          maxScore: 100,
          weight: 1,
          description: 'overall',
        },
      ],
    },
    retentionRatio: 0.3,
    compressionThresholdSoft: 70,
    compressionThresholdHard: 85,
    compressionThresholdCritical: 92,
  }
}

function createSdkResultMessage(params?: {
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>
  numTurns?: number
  terminalReason?: string
}) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: params?.numTurns ?? 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: 0,
      web_search_requests: 0,
    },
    modelUsage: {},
    permission_denials: params?.permissionDenials ?? [],
    terminal_reason: params?.terminalReason ?? 'completed',
    uuid: 'uuid-1',
    session_id: 'session-1',
  }
}

function createMockQueryResult(resultMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield resultMessage
    },
    getContextUsage: vi.fn(async () => ({
      totalTokens: 100,
      maxTokens: 200,
      percentage: 50,
    })),
    close: vi.fn(),
  }
}

describe('ClaudeSdkAgentEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockCopyFile.mockResolvedValue(undefined)
    mockInsertTaskRoundArtifact.mockResolvedValue(undefined)
    mockUpdateTaskRoundArtifactScore.mockResolvedValue(undefined)
    mockUpdateTaskSuccess.mockResolvedValue(undefined)
    mockUpdateTaskFailed.mockResolvedValue(undefined)
    mockPersistRoundArtifacts.mockResolvedValue({
      generatedImagePath: '/tmp/generated-final.png',
      previewImagePath: '/tmp/preview-final.png',
      contextThumbPath: '/tmp/context-final.png',
    })
    mockPruneRoundOriginalCache.mockResolvedValue(undefined)

    mockCreateSdkMcpServer.mockImplementation((options: { name: string }) => ({
      type: 'sdk',
      name: options.name,
      instance: {},
    }))

    mockTool.mockImplementation((name: string) => ({ name }))
  })

  it('retries instead of failing immediately and uses aligned mcp tool names', async () => {
    mockQuery.mockImplementation(() => createMockQueryResult(createSdkResultMessage()))

    const callTool = vi.fn(async () => {
      throw new Error('fallback generate failed')
    })
    mockCreateMcpServer.mockResolvedValue({
      callTool,
    })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-retry'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(mockQuery).toHaveBeenCalledTimes(2)

    const firstQueryArgs = mockQuery.mock.calls[0][0] as {
      options: { mcpServers: Record<string, unknown>; allowedTools: string[] }
    }
    const firstServerName = Object.keys(firstQueryArgs.options.mcpServers)[0]
    expect(firstServerName).toBe('ecom-mcp-task-claude-retry-0')
    expect(firstQueryArgs.options.allowedTools).toEqual([
      'mcp__ecom-mcp-task-claude-retry-0__generate_image',
      'mcp__ecom-mcp-task-claude-retry-0__evaluate_image',
    ])

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    const thoughtCount = payloads.filter((item) => item.phase === 'thought').length
    expect(thoughtCount).toBe(2)

    const finalFailed = payloads.filter((item) => item.phase === 'failed').at(-1)
    expect(finalFailed?.message).toContain('2/2')
    expect(finalFailed?.message).toContain('last_round_fallback_failed')
  })

  it('logs diagnostics and succeeds through last-round fallback', async () => {
    mockQuery.mockImplementation(() =>
      createMockQueryResult(
        createSdkResultMessage({
          permissionDenials: [{ tool_name: 'mcp__deny__x', tool_use_id: '1', tool_input: {} }],
          numTurns: 8,
          terminalReason: 'max_turns',
        }),
      ),
    )

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return { image_path: '/tmp/fallback-generated.png' }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 96,
          defect_analysis: {
            dimensions: [],
            overall_recommendation: 'ok',
          } as DefectAnalysis,
          passed: true,
          pass_threshold: 90,
        }
      }
      throw new Error(`unknown tool ${name}`)
    })

    mockCreateMcpServer.mockResolvedValue({
      callTool,
    })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-fallback-success'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      'generate_image',
      expect.objectContaining({
        product_image_paths: ['/images/p1.png'],
        product_name: 'Liquid Bottle',
        context: 'warm studio lighting',
        rubric: createOptions(0).evaluationRubric,
        pass_threshold: 90,
      }),
    )
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'evaluate_image',
      expect.objectContaining({
        image_path: '/tmp/generated-final.png',
      }),
    )
    expect(mockInsertTaskRoundArtifact).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    const diagnosticsMessage = payloads.find((item) =>
      item.message.includes('Claude SDK round diagnostics:'),
    )
    expect(diagnosticsMessage?.message).toContain('permission_denials=')
    expect(diagnosticsMessage?.message).toContain('terminal_reason=max_turns')
    expect(payloads.some((item) => item.phase === 'success')).toBe(true)
  })
})

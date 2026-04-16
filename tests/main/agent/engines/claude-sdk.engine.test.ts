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
    userPrompt: 'Keep the bottle label and amber liquid exactly consistent.',
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

function createMockStreamingQuery(resultMessage: unknown) {
  const queue: unknown[] = []
  let pendingResolver: ((value: IteratorResult<unknown>) => void) | null = null
  let closed = false

  const emit = (message: unknown): void => {
    if (closed) return
    if (pendingResolver) {
      pendingResolver({ done: false, value: message })
      pendingResolver = null
      return
    }
    queue.push(message)
  }

  const close = (): void => {
    closed = true
    if (pendingResolver) {
      pendingResolver({ done: true, value: undefined })
      pendingResolver = null
    }
  }

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (closed) break
        const next = await new Promise<IteratorResult<unknown>>((resolve) => {
          pendingResolver = resolve
        })
        if (next.done) break
        yield next.value
      }
    },
    initializationResult: vi.fn(async () => ({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [{ id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet' }],
      account: {},
    })),
    mcpServerStatus: vi.fn(async () => [{ name: 'sdk-local', status: 'connected' }]),
    streamInput: vi.fn(async (stream: AsyncIterable<unknown>) => {
      for await (const _ of stream) {
        break
      }
      emit(resultMessage)
    }),
    getContextUsage: vi.fn(async () => ({
      totalTokens: 100,
      maxTokens: 200,
      percentage: 50,
    })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => {
      close()
    }),
    _emitFromInitialPrompt: (prompt: string | AsyncIterable<unknown>) => {
      if (typeof prompt === 'string') {
        emit(resultMessage)
        return
      }
      void (async () => {
        for await (const _ of prompt) {
          emit(resultMessage)
          break
        }
      })()
    },
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

  it('uses single query + streamInput for retries and applies project-isolated settings', async () => {
    const permissionResults: unknown[] = []
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      const q = createMockStreamingQuery(createSdkResultMessage())
      q._emitFromInitialPrompt(params.prompt)

      const allowedTools = params.options.allowedTools as string[]
      const canUseTool = params.options.canUseTool as
        | ((toolName: string, toolInput: Record<string, unknown>) => Promise<unknown>)
        | undefined

      if (canUseTool && Array.isArray(allowedTools)) {
        const generateTool = allowedTools.find((item) => item.endsWith('__generate_image')) ?? ''
        const evaluateTool = allowedTools.find((item) => item.endsWith('__evaluate_image')) ?? ''
        if (generateTool) {
          void canUseTool(generateTool, { prompt: 'draft prompt' }).then((res) => permissionResults.push(res))
        }
        if (evaluateTool) {
          void canUseTool(evaluateTool, {}).then((res) => permissionResults.push(res))
        }
        void canUseTool('unknown_tool', {}).then((res) => permissionResults.push(res))
      }

      return q
    })

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

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const firstQueryArgs = mockQuery.mock.calls[0][0] as {
      options: {
        mcpServers: Record<string, unknown>
        allowedTools: string[]
        settingSources: string[]
        persistSession: boolean
        cwd: string
      }
    }
    const serverName = Object.keys(firstQueryArgs.options.mcpServers)[0]
    expect(serverName).toBe('ecom-mcp-task-claude-retry')
    expect(firstQueryArgs.options.allowedTools).toEqual([
      'mcp__ecom-mcp-task-claude-retry__generate_image',
      'mcp__ecom-mcp-task-claude-retry__evaluate_image',
    ])
    expect(firstQueryArgs.options.settingSources).toEqual(['project'])
    expect(firstQueryArgs.options.persistSession).toBe(true)
    const normalizedCwd = firstQueryArgs.options.cwd.replace(/\\/g, '/')
    expect(normalizedCwd).toContain('/tmp/ecom-image-agent/claude_sdk_task_projects/task-claude-retry')

    const q = mockQuery.mock.results[0].value as { streamInput: ReturnType<typeof vi.fn> }
    expect(q.streamInput).toHaveBeenCalledTimes(1)

    const permissionAllowGenerate = permissionResults.find((item) => {
      return (
        typeof item === 'object' &&
        item !== null &&
        'behavior' in item &&
        (item as { behavior: string }).behavior === 'allow' &&
        'updatedInput' in item
      )
    }) as { behavior: string; updatedInput?: Record<string, unknown> } | undefined

    expect(permissionAllowGenerate?.updatedInput?.prompt).toContain('Liquid Bottle')
    expect(permissionAllowGenerate?.updatedInput?.prompt).toContain('Keep the bottle label')
    expect(permissionResults.some((item) => (item as { behavior?: string })?.behavior === 'deny')).toBe(true)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    const thoughtCount = payloads.filter((item) => item.phase === 'thought').length
    expect(thoughtCount).toBe(2)

    const finalFailed = payloads.filter((item) => item.phase === 'failed').at(-1)
    expect(finalFailed?.message).toContain('2/2')
    expect(finalFailed?.message).toContain('last_round_fallback_failed')
  })

  it('logs diagnostics and succeeds through last-round fallback', async () => {
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown> }) => {
      const q = createMockStreamingQuery(
        createSdkResultMessage({
          permissionDenials: [{ tool_name: 'mcp__deny__x', tool_use_id: '1', tool_input: {} }],
          numTurns: 8,
          terminalReason: 'max_turns',
        }),
      )
      q._emitFromInitialPrompt(params.prompt)
      return q
    })

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

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const q = mockQuery.mock.results[0].value as { streamInput: ReturnType<typeof vi.fn> }
    expect(q.streamInput).not.toHaveBeenCalled()

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

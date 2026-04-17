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
    provider: { name: 'seedream' } as never,
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
  subtype?: string
  errors?: string[]
  stopReason?: string
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>
  numTurns?: number
  terminalReason?: string
}) {
  return {
    type: 'result',
    subtype: params?.subtype ?? 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: (params?.subtype ?? 'success') !== 'success',
    num_turns: params?.numTurns ?? 1,
    result: 'done',
    stop_reason: params?.stopReason ?? 'end_turn',
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
    errors: params?.errors ?? [],
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

    mockCreateSdkMcpServer.mockImplementation((options: { name: string; tools: unknown[] }) => ({
      type: 'sdk',
      name: options.name,
      tools: options.tools,
      instance: {},
    }))

    mockTool.mockImplementation((
      name: string,
      _description: string,
      _schema: unknown,
      handler: (input: Record<string, unknown>) => Promise<unknown>,
    ) => ({
      name,
      handler,
    }))
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

  it('fails fast on non-retriable 401 from result errors without fallback retries', async () => {
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown> }) => {
      const q = createMockStreamingQuery(
        createSdkResultMessage({
          subtype: 'error_during_execution',
          numTurns: 6,
          terminalReason: 'aborted_tools',
          stopReason: 'tool_use',
          errors: [
            'AxiosError: Request failed with status code 401, request_id=req-tool-401',
          ],
        }),
      )
      q._emitFromInitialPrompt(params.prompt)
      return q
    })

    const callTool = vi.fn(async () => ({
      image_path: '/tmp/should-not-be-used.png',
    }))
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-fastfail-result-401'),
      win,
      {} as never,
      controller.signal,
      createOptions(2),
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(callTool).not.toHaveBeenCalled()
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.some((item) => item.message.includes('non-retriable auth/permission error'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('status=401'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(false)
    expect(payloads.filter((item) => item.phase === 'thought')).toHaveLength(1)
  })

  it('fails fast on coding-plan model unavailable error and reports anthropic provider', async () => {
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown> }) => {
      const q = createMockStreamingQuery(
        createSdkResultMessage({
          subtype: 'error_during_execution',
          numTurns: 4,
          terminalReason: 'aborted_tools',
          stopReason: 'tool_use',
          errors: [
            "Error: 400 {\"code\":10007,\"msg\":\"Bad Request: [model 'claude-haiku-4-5-20251001' is not available in your coding plan]\"}",
          ],
        }),
      )
      q._emitFromInitialPrompt(params.prompt)
      return q
    })

    const callTool = vi.fn(async () => ({
      image_path: '/tmp/should-not-be-used.png',
    }))
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-fastfail-coding-plan-model'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(callTool).not.toHaveBeenCalled()
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.some((item) => item.message.includes('non-retriable auth/permission error'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('status=400'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('provider=anthropic'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('Coding plan'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(false)
  })

  it('auto-switches to an available anthropic model when coding-plan model is unavailable', async () => {
    const firstQuery = createMockStreamingQuery(
      createSdkResultMessage({
        subtype: 'error_during_execution',
        numTurns: 1,
        terminalReason: 'completed',
        stopReason: 'none',
        errors: [
          "Error: 400 {\"code\":10007,\"msg\":\"Bad Request: [model 'claude-haiku-4-5-20251001' is not available in your coding plan]\"}",
        ],
      }),
    )
    firstQuery.initializationResult = vi.fn(async () => ({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [
        { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet' },
        { id: 'claude-opus-4-20250514', displayName: 'Claude Opus' },
      ],
      account: {},
    }))

    const secondQuery = createMockStreamingQuery(
      createSdkResultMessage({
        subtype: 'error_max_turns',
        numTurns: 8,
        terminalReason: 'max_turns',
        stopReason: 'end_turn',
      }),
    )
    secondQuery.initializationResult = vi.fn(async () => ({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [
        { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet' },
        { id: 'claude-opus-4-20250514', displayName: 'Claude Opus' },
      ],
      account: {},
    }))

    mockQuery
      .mockImplementationOnce((params: { prompt: string | AsyncIterable<unknown> }) => {
        firstQuery._emitFromInitialPrompt(params.prompt)
        return firstQuery
      })
      .mockImplementationOnce((params: { prompt: string | AsyncIterable<unknown> }) => {
        secondQuery._emitFromInitialPrompt(params.prompt)
        return secondQuery
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-coding-plan-auto-switch'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const firstQueryArgs = mockQuery.mock.calls[0][0] as { options: { model: string } }
    const secondQueryArgs = mockQuery.mock.calls[1][0] as { options: { model: string } }
    expect(firstQueryArgs.options.model).toBe('claude-sonnet-4-20250514')
    expect(secondQueryArgs.options.model).toBe('claude-opus-4-20250514')
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()

    const payloads = events.map((item) => item.payload as { message: string })
    expect(
      payloads.some((item) =>
        item.message.includes('switching model from claude-sonnet-4-20250514 to claude-opus-4-20250514'),
      ),
    ).toBe(true)
  })

  it('tolerates non-standard initialization model entries from anthropic-compatible runtimes', async () => {
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown> }) => {
      const q = createMockStreamingQuery(
        createSdkResultMessage({
          permissionDenials: [{ tool_name: 'mcp__deny__x', tool_use_id: '1', tool_input: {} }],
          numTurns: 8,
          terminalReason: 'max_turns',
        }),
      )
      q.initializationResult = vi.fn(async () => ({
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: ['glm-5', { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet' }, {}, null],
        account: {},
      }))
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-nonstandard-model-list'),
      win,
      {} as never,
      controller.signal,
      {
        ...createOptions(0),
        anthropicModel: 'glm-5',
      },
    )

    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.some((item) => item.message.includes('sdk_bootstrap_failed'))).toBe(false)
    expect(payloads.some((item) => item.message.includes('SDK initialized. models=4'))).toBe(true)
  })

  it('fails fast on query-layer 403 and skips last-round fallback', async () => {
    mockQuery.mockImplementation((params: { prompt: string | AsyncIterable<unknown> }) => {
      const q = createMockStreamingQuery(createSdkResultMessage())
      q._emitFromInitialPrompt(params.prompt)
      q.streamInput = vi.fn(async () => {
        throw new Error('AxiosError: Request failed with status code 403, request_id=req-query-403')
      })
      return q
    })

    const callTool = vi.fn(async () => ({
      image_path: '/tmp/should-not-be-used.png',
    }))
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-fastfail-query-403'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const q = mockQuery.mock.results[0].value as { streamInput: ReturnType<typeof vi.fn> }
    expect(q.streamInput).toHaveBeenCalledTimes(1)
    expect(callTool).not.toHaveBeenCalled()
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.some((item) => item.message.includes('non-retriable auth/permission error'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('status=403'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(false)
  })

  it('fails fast on non-retriable evaluate_image model/input compatibility error without repeated generate_image', async () => {
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

    const controlledQuery = {
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
        emit(createSdkResultMessage())
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')
      const evaluateTool = mcpServer?.tools?.find((item) => item.name === 'evaluate_image')

      void (async () => {
        if (typeof params.prompt !== 'string') {
          for await (const _ of params.prompt) {
            break
          }
        }

        if (generateTool?.handler) {
          await generateTool.handler({ prompt: 'draft prompt from test' })
        }
        if (evaluateTool?.handler) {
          try {
            await evaluateTool.handler({ image_path: '/tmp/generated-final.png' })
          } catch {
            // Expected non-retriable model/input capability failure.
          }
        }

        emit(createSdkResultMessage())
      })()

      return controlledQuery
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
      }
      if (name === 'evaluate_image') {
        throw new Error(
          "Error code: 400 - {'error': {'code': 'invalid_argument', 'message': 'Invalid content type. image_url is only supported by certain models', 'type': 'invalid_request_error'}, 'id': 'as-test-model-cap'}",
        )
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-model-capability-fastfail'),
      win,
      {} as never,
      controller.signal,
      createOptions(2),
    )

    expect(callTool).toHaveBeenCalledTimes(2)
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      'generate_image',
      expect.objectContaining({
        product_name: 'Liquid Bottle',
      }),
    )
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'evaluate_image',
      expect.objectContaining({
        image_path: '/tmp/generated-final.png',
      }),
    )
    expect(controlledQuery.interrupt).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(
      payloads.some((item) => item.message.includes('non-retriable model/input compatibility error')),
    ).toBe(true)
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(false)
    expect(payloads.filter((item) => item.message.includes('generate_image args='))).toHaveLength(1)
    expect(payloads.filter((item) => item.phase === 'thought')).toHaveLength(1)
  })

  it('ignores stale model-provided image_path and retries on the next round after ordinary evaluate failure', async () => {
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

    let initialPromptHandled = false
    const controlledQuery = {
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
        emit(createSdkResultMessage())
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')
      const evaluateTool = mcpServer?.tools?.find((item) => item.name === 'evaluate_image')

      if (!initialPromptHandled) {
        initialPromptHandled = true
        void (async () => {
          if (typeof params.prompt !== 'string') {
            for await (const _ of params.prompt) {
              break
            }
          }

          if (generateTool?.handler) {
            await generateTool.handler({ prompt: 'draft prompt from test' })
          }
          if (evaluateTool?.handler) {
            try {
              await evaluateTool.handler({
                image_path: 'D:\\Users\\Public\\Documents\\eComAgent\\assets\\images\\generated_image_0016.png',
              })
            } catch {
              // Expected ordinary evaluate failure path.
            }
          }

          emit(createSdkResultMessage())
        })()
      }

      return controlledQuery
    })

    let evaluateCallCount = 0
    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
      }
      if (name === 'evaluate_image') {
        evaluateCallCount += 1
        if (evaluateCallCount === 1) {
          throw new Error(
            'image not found: D:\\Users\\Public\\Documents\\eComAgent\\assets\\images\\generated_image_0016.png',
          )
        }
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-stale-image-path-retry'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    const evaluateCalls = callTool.mock.calls.filter((call) => call[0] === 'evaluate_image')
    expect(evaluateCalls).toHaveLength(2)
    expect(evaluateCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        image_path: '/tmp/generated-final.png',
      }),
    )
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)

    const payloads = events.map(
      (item) => item.payload as { phase: string; message: string; roundIndex: number },
    )
    expect(
      payloads.some((item) =>
        item.message.includes('ignored model-provided image_path and used current round artifact path'),
      ),
    ).toBe(true)
    expect(
      payloads.some((item) =>
        item.message.includes('Skip evaluate_image fallback because evaluate_image failed earlier in this round.'),
      ),
    ).toBe(true)
    expect(payloads.some((item) => item.message.includes('Round incomplete, continue retry.'))).toBe(true)
    expect(payloads.some((item) => item.phase === 'thought' && item.roundIndex === 1)).toBe(true)
    expect(
      payloads.filter((item) => item.roundIndex === 0 && item.message.includes('generate_image args=')),
    ).toHaveLength(1)
  })

  it('ends the current round on ordinary generate_image failure and retries on the next round', async () => {
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

    let initialPromptHandled = false
    const controlledQuery = {
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
        emit(createSdkResultMessage())
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')

      if (!initialPromptHandled) {
        initialPromptHandled = true
        void (async () => {
          if (typeof params.prompt !== 'string') {
            for await (const _ of params.prompt) {
              break
            }
          }

          if (generateTool?.handler) {
            try {
              await generateTool.handler({ prompt: 'draft prompt from test' })
            } catch {
              // Expected ordinary generate failure path.
            }
          }

          emit(createSdkResultMessage())
        })()
      }

      return controlledQuery
    })

    let generateCallCount = 0
    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        generateCallCount += 1
        if (generateCallCount === 1) {
          throw new Error('Official Visual request failed: upstream 502')
        }
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-generate-failure-retry'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    const generateCalls = callTool.mock.calls.filter((call) => call[0] === 'generate_image')
    expect(generateCalls).toHaveLength(2)
    expect(controlledQuery.interrupt).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)

    const payloads = events.map(
      (item) => item.payload as { phase: string; message: string; roundIndex: number },
    )
    expect(
      payloads.some((item) =>
        item.message.includes('generate_image failed; ending current round. error=Official Visual request failed: upstream 502'),
      ),
    ).toBe(true)
    expect(payloads.some((item) => item.message.includes('Round incomplete, continue retry.'))).toBe(true)
    expect(payloads.some((item) => item.phase === 'thought' && item.roundIndex === 1)).toBe(true)
    expect(
      payloads.filter((item) => item.roundIndex === 0 && item.message.includes('generate_image args=')),
    ).toHaveLength(1)
  })

  it('ends the current round on generate_image post-processing failure and logs the artifact error', async () => {
    mockPersistRoundArtifacts
      .mockRejectedValueOnce(new Error('copy failed: source image missing'))
      .mockResolvedValue({
        generatedImagePath: '/tmp/generated-final.png',
        previewImagePath: '/tmp/preview-final.png',
        contextThumbPath: '/tmp/context-final.png',
      })

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

    let initialPromptHandled = false
    const controlledQuery = {
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
        emit(createSdkResultMessage())
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')

      if (!initialPromptHandled) {
        initialPromptHandled = true
        void (async () => {
          if (typeof params.prompt !== 'string') {
            for await (const _ of params.prompt) {
              break
            }
          }

          if (generateTool?.handler) {
            try {
              await generateTool.handler({ prompt: 'draft prompt from test' })
            } catch {
              // Expected post-processing failure path.
            }
          }

          emit(createSdkResultMessage())
        })()
      }

      return controlledQuery
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-generate-postprocess-failure'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(controlledQuery.interrupt).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockInsertTaskRoundArtifact).toHaveBeenCalledTimes(1)

    const payloads = events.map(
      (item) => item.payload as { phase: string; message: string; roundIndex: number },
    )
    expect(
      payloads.some((item) =>
        item.message.includes(
          'generate_image post-processing failed; ending current round. error=copy failed: source image missing',
        ),
      ),
    ).toBe(true)
    expect(payloads.some((item) => item.message.includes('Round incomplete, continue retry.'))).toBe(true)
    expect(
      payloads.filter((item) => item.roundIndex === 0 && item.message.includes('generate_image args=')),
    ).toHaveLength(1)
    expect(payloads.some((item) => item.message.includes('round 2 image generated'))).toBe(true)
  })

  it('rejects repeated generate_image calls in the same round and does not generate twice', async () => {
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

    const controlledQuery = {
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
      streamInput: vi.fn(async (_stream: AsyncIterable<unknown>) => {
        emit(createSdkResultMessage())
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')

      void (async () => {
        if (typeof params.prompt !== 'string') {
          for await (const _ of params.prompt) {
            break
          }
        }

        if (generateTool?.handler) {
          await generateTool.handler({ prompt: 'draft prompt from test' })
          try {
            await generateTool.handler({ prompt: 'second draft prompt from test' })
          } catch {
            // Expected repeated-generate guard.
          }
        }

        emit(createSdkResultMessage())
      })()

      return controlledQuery
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 95,
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-repeat-generate-guard'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    const generateCalls = callTool.mock.calls.filter((call) => call[0] === 'generate_image')
    expect(generateCalls).toHaveLength(1)
    expect(controlledQuery.interrupt).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(
      payloads.some((item) =>
        item.message.includes('Repeated generate_image call detected; ending current round.'),
      ),
    ).toBe(true)
    expect(
      payloads.some((item) =>
        item.message.includes('Skip evaluate_image fallback because generate_image was called again'),
      ),
    ).toBe(true)
    expect(payloads.filter((item) => item.message.includes('generate_image args='))).toHaveLength(1)
  })

  it('ignores post-interrupt coding-plan auth errors after local repeated-generate termination', async () => {
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

    const controlledQuery = {
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
      streamInput: vi.fn(async (_stream: AsyncIterable<unknown>) => undefined),
      getContextUsage: vi.fn(async () => ({
        totalTokens: 100,
        maxTokens: 200,
        percentage: 50,
      })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(() => {
        close()
      }),
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')

      void (async () => {
        if (typeof params.prompt !== 'string') {
          for await (const _ of params.prompt) {
            break
          }
        }

        if (generateTool?.handler) {
          await generateTool.handler({ prompt: 'draft prompt from test' })
          try {
            await generateTool.handler({ prompt: 'second draft prompt from test' })
          } catch {
            // Expected repeated-generate guard.
          }
        }

        emit(
          createSdkResultMessage({
            subtype: 'error_during_execution',
            numTurns: 5,
            terminalReason: 'aborted_streaming',
            stopReason: 'tool_use',
            errors: [
              'Error: 400 {"code":10007,"msg":"Bad Request: [model \'claude-haiku-4-5-20251001\' is not available in your coding plan]"}',
            ],
          }),
        )
      })()

      return controlledQuery
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 95,
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-ignore-post-interrupt-auth'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(
      payloads.some((item) =>
        item.message.includes('Ignoring SDK auth/model errors emitted after local round termination.'),
      ),
    ).toBe(true)
    expect(
      payloads.some((item) =>
        item.message.includes('round diagnostics (post-interrupt, ignored for failure classification)'),
      ),
    ).toBe(true)
    expect(payloads.some((item) => item.message.includes('non-retriable auth/permission error'))).toBe(false)
  })

  it('rebuilds query session on transport-not-ready and continues same round without extra thought rounds', async () => {
    const firstQuery = createMockStreamingQuery(createSdkResultMessage())
    const secondQuery = createMockStreamingQuery(createSdkResultMessage())

    firstQuery.streamInput = vi.fn(async () => {
      throw new Error('ProcessTransport is not ready for writing')
    })

    mockQuery
      .mockImplementationOnce((params: { prompt: string | AsyncIterable<unknown> }) => {
        firstQuery._emitFromInitialPrompt(params.prompt)
        return firstQuery
      })
      .mockImplementationOnce((params: { prompt: string | AsyncIterable<unknown> }) => {
        secondQuery._emitFromInitialPrompt(params.prompt)
        return secondQuery
      })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return { image_path: '/tmp/fallback-generated.png' }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 95,
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
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-transport-rebuild'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(firstQuery.streamInput).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.filter((item) => item.phase === 'thought')).toHaveLength(2)
    expect(payloads.some((item) => item.message.includes('transport unavailable'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('query session rebuilt'))).toBe(true)
  })

  it('skips evaluate fallback when evaluate timed out earlier in the same round', async () => {
    const firstRoundResult = createSdkResultMessage()
    const secondRoundResult = createSdkResultMessage({
      subtype: 'error_during_execution',
      stopReason: 'tool_use',
      terminalReason: 'aborted_tools',
      errors: ['AxiosError: Request failed with status code 401, request_id=req-round2-401'],
    })

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

    const controlledQuery = {
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
        emit(secondRoundResult)
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
    }

    mockQuery.mockImplementation((params: {
      prompt: string | AsyncIterable<unknown>
      options: {
        mcpServers: Record<
          string,
          {
            tools?: Array<{
              name: string
              handler?: (input: Record<string, unknown>) => Promise<unknown>
            }>
          }
        >
      }
    }) => {
      const mcpServer = Object.values(params.options.mcpServers)[0]
      const generateTool = mcpServer?.tools?.find((item) => item.name === 'generate_image')
      const evaluateTool = mcpServer?.tools?.find((item) => item.name === 'evaluate_image')

      void (async () => {
        if (typeof params.prompt !== 'string') {
          for await (const _ of params.prompt) {
            break
          }
        }

        if (generateTool?.handler) {
          await generateTool.handler({ prompt: 'draft prompt from test' })
        }
        if (evaluateTool?.handler) {
          try {
            await evaluateTool.handler({ image_path: '/tmp/generated-final.png' })
          } catch {
            // Expected timeout path.
          }
        }

        emit(firstRoundResult)
      })()

      return controlledQuery
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/tool-generated.png',
          prompt_used: 'tool-generated',
        }
      }
      if (name === 'evaluate_image') {
        throw new Error('VLMEval evaluation timeout (120000ms)')
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-eval-timeout-dedupe'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    const evaluateCalls = callTool.mock.calls.filter((call) => call[0] === 'evaluate_image')
    expect(evaluateCalls).toHaveLength(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(
      payloads.some((item) =>
        item.message.includes('Skip evaluate_image fallback because evaluate timed out earlier in this round.'),
      ),
    ).toBe(true)
    expect(
      payloads.some((item) => item.message.includes('Round incomplete, continue retry.') && item.message.includes('evaluate_timeout_in_round=yes')),
    ).toBe(true)
  })

  it('falls back to existing retry/fallback flow when transport rebuild itself fails', async () => {
    const firstQuery = createMockStreamingQuery(createSdkResultMessage())
    firstQuery.streamInput = vi.fn(async () => {
      throw new Error('ProcessTransport is not ready for writing')
    })

    mockQuery
      .mockImplementationOnce((params: { prompt: string | AsyncIterable<unknown> }) => {
        firstQuery._emitFromInitialPrompt(params.prompt)
        return firstQuery
      })
      .mockImplementationOnce(() => {
        throw new Error('query rebuild failed')
      })

    const callTool = vi.fn(async () => {
      throw new Error('fallback generate failed')
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new ClaudeSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-claude-transport-rebuild-failed'),
      win,
      {} as never,
      controller.signal,
      createOptions(1),
    )

    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)

    const payloads = events.map((item) => item.payload as { phase: string; message: string })
    expect(payloads.filter((item) => item.phase === 'thought')).toHaveLength(2)
    expect(payloads.some((item) => item.message.includes('transport unavailable'))).toBe(true)
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(true)
    expect(payloads.some((item) => item.phase === 'failed' && item.message.includes('last_round_fallback_failed'))).toBe(true)
  })
})

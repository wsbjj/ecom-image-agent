import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { TaskInput, DefectAnalysis } from '../../../../src/shared/types'

const {
  mockCodexStartThread,
  mockCodexThreadRun,
  mockAnthropicMessagesCreate,
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
  mockCodexStartThread: vi.fn(),
  mockCodexThreadRun: vi.fn(),
  mockAnthropicMessagesCreate: vi.fn(),
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

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(() => ({
    startThread: mockCodexStartThread,
  })),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: {
      create: mockAnthropicMessagesCreate,
    },
  })),
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

import { CodexSdkAgentEngine } from '../../../../src/main/agent/engines/codex-sdk.engine'

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

function createInput(taskId = 'task-codex-1'): TaskInput {
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

function createOptions(maxRetries: number, overrides?: { codexModel?: string; codexApiKey?: string }) {
  return {
    provider: {} as never,
    anthropicApiKey: 'anthropic-test-key',
    anthropicBaseUrl: undefined,
    anthropicModel: 'claude-sonnet-4-20250514',
    codexApiKey: overrides?.codexApiKey ?? 'codex-test-key',
    codexBaseUrl: undefined,
    codexModel: overrides?.codexModel,
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

function createDefect(): DefectAnalysis {
  return {
    dimensions: [],
    overall_recommendation: 'ok',
  }
}

describe('CodexSdkAgentEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAnthropicMessagesCreate.mockReset()
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
    mockCodexStartThread.mockReturnValue({
      run: mockCodexThreadRun,
    })
  })

  it('uses default model gpt-5.4 and succeeds with generated score', async () => {
    mockCodexThreadRun.mockResolvedValue({
      finalResponse: '{"draft_prompt":"hero product shot"}',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 80,
      },
      items: [],
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/original-generated.png',
          prompt_used: 'x',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 95,
          defect_analysis: createDefect(),
        }
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-codex-default-model'),
      win,
      {} as never,
      controller.signal,
      createOptions(0, { codexModel: undefined }),
    )

    expect(mockCodexStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
      }),
    )
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()
    expect(events.some((item) => (item.payload as { phase: string }).phase === 'success')).toBe(true)
  })

  it('sends local images to codex and configures additional directories', async () => {
    mockCodexThreadRun.mockResolvedValue({
      finalResponse: '{"draft_prompt":"hero product shot from attachments"}',
      usage: {
        input_tokens: 120,
        cached_input_tokens: 10,
        output_tokens: 50,
      },
      items: [],
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/original-generated.png',
          prompt_used: 'x',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 95,
          defect_analysis: createDefect(),
        }
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()
    const input: TaskInput = {
      ...createInput('task-codex-image-attachments'),
      productImages: [{ path: '/images/p1.png' }, { path: '/images/p2.png' }],
      referenceImages: [{ path: '/refs/r1.png' }],
    }

    await engine.run(
      input,
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    expect(mockCodexStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalDirectories: expect.arrayContaining([
          expect.stringContaining('images'),
          expect.stringContaining('refs'),
        ]),
      }),
    )

    const firstRunInput = mockCodexThreadRun.mock.calls[0]?.[0] as Array<{
      type: 'text' | 'local_image'
      text?: string
      path?: string
    }>
    expect(Array.isArray(firstRunInput)).toBe(true)
    expect(firstRunInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'local_image', path: '/images/p1.png' }),
        expect.objectContaining({ type: 'local_image', path: '/images/p2.png' }),
        expect.objectContaining({ type: 'local_image', path: '/refs/r1.png' }),
      ]),
    )
  })

  it('falls back when codex response cannot be parsed as draft prompt', async () => {
    mockCodexThreadRun.mockResolvedValue({
      finalResponse: 'this is not valid json',
      usage: {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 10,
      },
      items: [],
    })

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/original-generated.png',
          prompt_used: 'x',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 92,
          defect_analysis: createDefect(),
        }
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-codex-parse-fallback'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    const payloads = events.map((item) => item.payload as { message: string })
    expect(payloads.some((item) => item.message.includes('draft parsing failed'))).toBe(true)
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
  })

  it('executes last-round fallback when codex turn fails', async () => {
    mockCodexThreadRun.mockRejectedValue(new Error('codex turn failed'))

    const callTool = vi.fn(async (name: string) => {
      if (name === 'generate_image') {
        return {
          image_path: '/tmp/fallback-generated.png',
          prompt_used: 'x',
        }
      }
      if (name === 'evaluate_image') {
        return {
          total_score: 94,
          defect_analysis: createDefect(),
        }
      }
      throw new Error(`unknown tool ${name}`)
    })
    mockCreateMcpServer.mockResolvedValue({ callTool })

    const { win, events } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-codex-last-round-fallback'),
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
      }),
    )
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'evaluate_image',
      expect.objectContaining({
        image_path: '/tmp/generated-final.png',
      }),
    )
    expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
    const payloads = events.map((item) => item.payload as { message: string })
    expect(payloads.some((item) => item.message.includes('Last round fallback start.'))).toBe(true)
  })

  it('retries 502 twice and succeeds in the same round', async () => {
    vi.useFakeTimers()
    try {
      mockCodexThreadRun
        .mockRejectedValueOnce(
          new Error(
            'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-a',
          ),
        )
        .mockRejectedValueOnce(
          new Error(
            'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-b',
          ),
        )
        .mockResolvedValueOnce({
          finalResponse: '{"draft_prompt":"hero bottle on bright white table"}',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 10,
            output_tokens: 40,
          },
          items: [],
        })

      const callTool = vi.fn(async (name: string) => {
        if (name === 'generate_image') {
          return {
            image_path: '/tmp/retry-success.png',
            prompt_used: 'x',
          }
        }
        if (name === 'evaluate_image') {
          return {
            total_score: 96,
            defect_analysis: createDefect(),
          }
        }
        throw new Error(`unknown tool ${name}`)
      })
      mockCreateMcpServer.mockResolvedValue({ callTool })

      const { win, events } = createWindowCollector()
      const engine = new CodexSdkAgentEngine()
      const controller = new AbortController()

      const runPromise = engine.run(
        createInput('task-codex-retry-502-success'),
        win,
        {} as never,
        controller.signal,
        createOptions(0),
      )
      await vi.runAllTimersAsync()
      await runPromise

      expect(mockCodexThreadRun).toHaveBeenCalledTimes(3)
      expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
      const payloads = events.map((item) => item.payload as { message?: string })
      expect(payloads.some((item) => item.message?.includes('attempt=1/3'))).toBe(true)
      expect(payloads.some((item) => item.message?.includes('source=codex'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to anthropic draft when codex keeps returning 502', async () => {
    vi.useFakeTimers()
    try {
      mockCodexThreadRun.mockRejectedValue(
        new Error(
          'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-c',
        ),
      )
      mockAnthropicMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"draft_prompt":"anthropic fallback prompt"}' }],
      })

      const callTool = vi.fn(async (name: string) => {
        if (name === 'generate_image') {
          return {
            image_path: '/tmp/anthropic-fallback-generated.png',
            prompt_used: 'x',
          }
        }
        if (name === 'evaluate_image') {
          return {
            total_score: 93,
            defect_analysis: createDefect(),
          }
        }
        throw new Error(`unknown tool ${name}`)
      })
      mockCreateMcpServer.mockResolvedValue({ callTool })

      const { win, events } = createWindowCollector()
      const engine = new CodexSdkAgentEngine()
      const controller = new AbortController()

      const runPromise = engine.run(
        createInput('task-codex-502-anthropic-fallback'),
        win,
        {} as never,
        controller.signal,
        createOptions(0),
      )
      await vi.runAllTimersAsync()
      await runPromise

      expect(mockCodexThreadRun).toHaveBeenCalledTimes(3)
      expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
      expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
      const payloads = events.map((item) => item.payload as { message?: string })
      expect(payloads.some((item) => item.message?.includes('switching to Anthropic draft fallback'))).toBe(true)
      expect(payloads.some((item) => item.message?.includes('Anthropic draft fallback succeeded'))).toBe(true)
      expect(payloads.some((item) => item.message?.includes('source=anthropic'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses fallback template when anthropic fallback also fails after codex 502', async () => {
    vi.useFakeTimers()
    try {
      mockCodexThreadRun.mockRejectedValue(
        new Error(
          'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-d',
        ),
      )
      mockAnthropicMessagesCreate.mockRejectedValue(new Error('anthropic unavailable'))

      const callTool = vi.fn(async (name: string) => {
        if (name === 'generate_image') {
          return {
            image_path: '/tmp/template-fallback-generated.png',
            prompt_used: 'x',
          }
        }
        if (name === 'evaluate_image') {
          return {
            total_score: 91,
            defect_analysis: createDefect(),
          }
        }
        throw new Error(`unknown tool ${name}`)
      })
      mockCreateMcpServer.mockResolvedValue({ callTool })

      const { win, events } = createWindowCollector()
      const engine = new CodexSdkAgentEngine()
      const controller = new AbortController()

      const runPromise = engine.run(
        createInput('task-codex-502-template-fallback'),
        win,
        {} as never,
        controller.signal,
        createOptions(0),
      )
      await vi.runAllTimersAsync()
      await runPromise

      expect(mockCodexThreadRun).toHaveBeenCalledTimes(3)
      expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
      expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
      const payloads = events.map((item) => item.payload as { message?: string })
      expect(payloads.some((item) => item.message?.includes('Anthropic draft fallback failed'))).toBe(true)
      expect(payloads.some((item) => item.message?.includes('source=fallback_template'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens 502 circuit and bypasses codex in later rounds', async () => {
    vi.useFakeTimers()
    try {
      mockCodexThreadRun.mockRejectedValue(
        new Error(
          'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-circuit',
        ),
      )
      mockAnthropicMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"draft_prompt":"anthropic circuit prompt"}' }],
      })

      let evalCall = 0
      const callTool = vi.fn(async (name: string) => {
        if (name === 'generate_image') {
          return {
            image_path: `/tmp/circuit-generated-${Date.now()}.png`,
            prompt_used: 'x',
          }
        }
        if (name === 'evaluate_image') {
          evalCall += 1
          return {
            total_score: evalCall === 1 ? 88 : 94,
            defect_analysis: createDefect(),
          }
        }
        throw new Error(`unknown tool ${name}`)
      })
      mockCreateMcpServer.mockResolvedValue({ callTool })

      const { win, events } = createWindowCollector()
      const engine = new CodexSdkAgentEngine()
      const controller = new AbortController()

      const runPromise = engine.run(
        createInput('task-codex-502-circuit-open'),
        win,
        {} as never,
        controller.signal,
        createOptions(1),
      )
      await vi.runAllTimersAsync()
      await runPromise

      expect(mockCodexThreadRun).toHaveBeenCalledTimes(3)
      expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(2)
      expect(mockUpdateTaskSuccess).toHaveBeenCalledTimes(1)
      const payloads = events.map((item) => item.payload as { message?: string })
      expect(payloads.some((item) => item.message?.includes('gateway circuit opened'))).toBe(true)
      expect(payloads.some((item) => item.message?.includes('circuit is OPEN'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on non-retriable 401 without calling generate_image', async () => {
    mockCodexThreadRun.mockRejectedValue(
      new Error(
        'unexpected status 401 Unauthorized, url: https://agent.cam01.cn/v1/responses, request id: req-401-a',
      ),
    )
    mockCreateMcpServer.mockResolvedValue({
      callTool: vi.fn(),
    })

    const { win, events } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()

    await engine.run(
      createInput('task-codex-non-retriable-401'),
      win,
      {} as never,
      controller.signal,
      createOptions(2),
    )

    expect(mockCodexThreadRun).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskSuccess).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)
    const payloads = events.map((item) => item.payload as { message?: string })
    expect(payloads.some((item) => item.message?.includes('non-retriable auth/permission error'))).toBe(true)
  })

  it('marks task as failed when signal is aborted before first round', async () => {
    mockCodexThreadRun.mockResolvedValue({
      finalResponse: '{"draft_prompt":"unused"}',
      usage: null,
      items: [],
    })
    mockCreateMcpServer.mockResolvedValue({
      callTool: vi.fn(),
    })

    const { win } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()
    controller.abort()

    await engine.run(
      createInput('task-codex-abort'),
      win,
      {} as never,
      controller.signal,
      createOptions(0),
    )

    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)
    expect(mockCodexThreadRun).not.toHaveBeenCalled()
  })

  it('throws clear error when codex api key is missing', async () => {
    mockCreateMcpServer.mockResolvedValue({
      callTool: vi.fn(),
    })
    const { win } = createWindowCollector()
    const engine = new CodexSdkAgentEngine()
    const controller = new AbortController()

    await expect(
      engine.run(
        createInput('task-codex-missing-key'),
        win,
        {} as never,
        controller.signal,
        {
          ...createOptions(0),
          codexApiKey: undefined,
        },
      ),
    ).rejects.toThrow(/CODEX_API_KEY/)
  })
})

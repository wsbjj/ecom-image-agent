import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { TaskInput } from '../../../src/shared/types'
import { IPC_CHANNELS } from '../../../src/shared/ipc-channels'

const {
  handlerMap,
  mockInsertTask,
  mockGetConfigValue,
  mockGetEvaluationTemplateById,
  mockEnsureDefaultEvaluationTemplate,
  mockBuildDefaultEvalRubric,
  mockUpdateTaskFailed,
  mockCreateAgentEngine,
  mockEngineRun,
  mockSeedreamGenerate,
  mockGeminiGenerate,
  mockVisualGenerate,
  mockVlmStart,
  mockVlmStop,
  mockUuid,
} = vi.hoisted(() => ({
  handlerMap: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  mockInsertTask: vi.fn(),
  mockGetConfigValue: vi.fn(),
  mockGetEvaluationTemplateById: vi.fn(),
  mockEnsureDefaultEvaluationTemplate: vi.fn(),
  mockBuildDefaultEvalRubric: vi.fn(),
  mockUpdateTaskFailed: vi.fn(),
  mockCreateAgentEngine: vi.fn(),
  mockEngineRun: vi.fn(),
  mockSeedreamGenerate: vi.fn(),
  mockGeminiGenerate: vi.fn(),
  mockVisualGenerate: vi.fn(),
  mockVlmStart: vi.fn(),
  mockVlmStop: vi.fn(),
  mockUuid: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlerMap.set(channel, handler)
    }),
  },
  safeStorage: {
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString('utf8')),
  },
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}))

vi.mock('../../../src/main/db/queries', () => ({
  insertTask: mockInsertTask,
  getConfigValue: mockGetConfigValue,
  getEvaluationTemplateById: mockGetEvaluationTemplateById,
  ensureDefaultEvaluationTemplate: mockEnsureDefaultEvaluationTemplate,
  buildDefaultEvalRubric: mockBuildDefaultEvalRubric,
  updateTaskFailed: mockUpdateTaskFailed,
}))

vi.mock('../../../src/main/agent/engines', () => ({
  createAgentEngine: mockCreateAgentEngine,
}))

vi.mock('../../../src/main/agent/providers/seedream.provider', () => ({
  SeedreamProvider: vi.fn(() => ({
    name: 'seedream',
    generate: mockSeedreamGenerate,
  })),
}))

vi.mock('../../../src/main/agent/providers/seedream-visual.provider', () => ({
  SeedreamVisualProvider: vi.fn(() => ({
    name: 'seedream-visual',
    generate: mockVisualGenerate,
  })),
}))

vi.mock('../../../src/main/agent/providers/gemini.provider', () => ({
  GeminiProvider: vi.fn(() => ({
    name: 'gemini',
    generate: mockGeminiGenerate,
  })),
}))

vi.mock('../../../src/main/agent/vlmeval-bridge', () => ({
  VLMEvalBridge: vi.fn(() => ({
    start: mockVlmStart,
    stop: mockVlmStop,
    evaluate: vi.fn(),
  })),
  normalizeRubricForJudge: vi.fn((rubric) => rubric),
}))

vi.mock('uuid', () => ({
  v4: mockUuid,
}))

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

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

function createInput(): TaskInput {
  return {
    skuId: 'SKU-001',
    productName: 'Liquid Bottle',
    context: 'warm studio lighting',
    templateId: 1,
    productImages: [{ path: '/images/p1.png' }],
    userPrompt: 'Keep product identity.',
  }
}

let configStore: Map<string, string>

describe('registerAgentHandlers preflight switch', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.resetModules()
    vi.clearAllMocks()

    configStore = new Map<string, string>([
      ['IMAGE_PROVIDER', encode('seedream')],
      ['SEEDREAM_CALL_MODE', encode('openai_compat')],
      ['APIKEY_SEEDREAM', encode('seedream-key')],
      ['ANTHROPIC_API_KEY', encode('anthropic-key')],
    ])

    mockGetConfigValue.mockImplementation(async (key: string) => configStore.get(key))

    mockUuid.mockReturnValue('task-preflight-test')
    mockInsertTask.mockResolvedValue(undefined)
    mockUpdateTaskFailed.mockResolvedValue(undefined)
    mockVlmStart.mockResolvedValue(undefined)
    mockVlmStop.mockResolvedValue(undefined)
    mockBuildDefaultEvalRubric.mockReturnValue({
      dimensions: [],
    })
    mockEnsureDefaultEvaluationTemplate.mockResolvedValue({
      id: 1,
      name: 'default',
      version: 1,
      default_threshold: 85,
      rubric_json: JSON.stringify({
        dimensions: [
          {
            key: 'overall_quality',
            name: 'Overall',
            maxScore: 100,
            weight: 1,
            description: 'overall',
          },
        ],
      }),
      created_at: new Date().toISOString(),
    })
    mockGetEvaluationTemplateById.mockResolvedValue(undefined)
    mockEngineRun.mockResolvedValue(undefined)
    mockCreateAgentEngine.mockReturnValue({
      run: mockEngineRun,
    })
  })

  it('marks task failed and skips engine run when provider preflight is enabled and returns 401', async () => {
    configStore.set('AGENT_DEBUG_PROVIDER_PREFLIGHT', encode('1'))

    mockSeedreamGenerate.mockRejectedValue(
      new Error('AxiosError: Request failed with status code 401, request_id=req-pref-401'),
    )

    const { win, events } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, createInput())) as { taskId: string }

    expect(result.taskId).toBe('task-preflight-test')
    expect(mockSeedreamGenerate).toHaveBeenCalledTimes(1)
    expect(mockEngineRun).not.toHaveBeenCalled()
    expect(mockUpdateTaskFailed).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskFailed).toHaveBeenCalledWith({
      taskId: 'task-preflight-test',
      retryCount: 0,
      costUsd: 0,
    })

    const payloads = events.map((item) => item.payload as { phase?: string; message?: string })
    expect(payloads.some((item) => item.message?.includes('Provider preflight start'))).toBe(true)
    expect(payloads.some((item) => item.phase === 'failed')).toBe(true)
    expect(payloads.some((item) => item.message?.includes('status=401'))).toBe(true)
  })

  it('skips provider preflight when switch is disabled and runs engine normally', async () => {
    configStore.set('AGENT_DEBUG_PROVIDER_PREFLIGHT', encode('0'))

    mockSeedreamGenerate.mockRejectedValue(new Error('should not be called'))

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, createInput())) as { taskId: string }

    expect(result.taskId).toBe('task-preflight-test')
    expect(mockSeedreamGenerate).not.toHaveBeenCalled()
    expect(mockEngineRun).toHaveBeenCalledTimes(1)
    const engineRunOptions = mockEngineRun.mock.calls[0][4] as { providerPreflightEnabled?: boolean }
    expect(engineRunOptions.providerPreflightEnabled).toBe(false)
    expect(mockUpdateTaskFailed).not.toHaveBeenCalled()
  })

  it('passes vlmevalkit bridge options from config when task starts', async () => {
    configStore.set('EVAL_BACKEND', encode('vlmevalkit'))
    configStore.set('VLMEVAL_MODEL_ID', encode('qwen2.5-vl-72b-instruct'))
    configStore.set('VLMEVAL_USE_CUSTOM_MODEL', encode('true'))
    configStore.set('JUDGE_API_KEY', encode('judge-key'))
    configStore.set('JUDGE_BASE_URL', encode('https://judge-proxy.test'))
    configStore.set('JUDGE_MODEL', encode('glm-5'))

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, createInput())) as { taskId: string }

    expect(result.taskId).toBe('task-preflight-test')
    expect(mockVlmStart).toHaveBeenCalledTimes(1)
    expect(mockVlmStart).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        evalBackend: 'vlmevalkit',
        judgeApiKey: 'judge-key',
        judgeBaseUrl: 'https://judge-proxy.test',
        judgeModel: 'glm-5',
        vlmevalModelId: 'qwen2.5-vl-72b-instruct',
        vlmevalUseCustomModel: true,
      }),
    )
  })

  it('restarts vlmeval bridge when evaluation config changes between tasks', async () => {
    mockUuid
      .mockReturnValueOnce('task-preflight-test-1')
      .mockReturnValueOnce('task-preflight-test-2')

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    const firstResult = (await handler!({}, createInput())) as { taskId: string }
    expect(firstResult.taskId).toBe('task-preflight-test-1')
    expect(mockVlmStart).toHaveBeenCalledTimes(1)
    expect(mockVlmStop).not.toHaveBeenCalled()

    await Promise.resolve()

    configStore.set('EVAL_BACKEND', encode('vlmevalkit'))
    configStore.set('VLMEVAL_MODEL_ID', encode('qwen2.5-vl-72b-instruct'))
    configStore.set('VLMEVAL_USE_CUSTOM_MODEL', encode('true'))

    const secondResult = (await handler!({}, createInput())) as { taskId: string }
    expect(secondResult.taskId).toBe('task-preflight-test-2')
    expect(mockVlmStop).toHaveBeenCalledTimes(1)
    expect(mockVlmStart).toHaveBeenCalledTimes(2)
    expect(mockVlmStart).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        evalBackend: 'vlmevalkit',
        judgeApiKey: 'anthropic-key',
        vlmevalModelId: 'qwen2.5-vl-72b-instruct',
        vlmevalUseCustomModel: true,
      }),
    )
  })

  it('restarts vlmeval bridge when judge api key value changes but stays non-empty', async () => {
    mockUuid
      .mockReturnValueOnce('task-preflight-test-1')
      .mockReturnValueOnce('task-preflight-test-2')

    configStore.set('JUDGE_API_KEY', encode('judge-key-1'))

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    await handler!({}, createInput())
    expect(mockVlmStart).toHaveBeenCalledTimes(1)
    expect(mockVlmStop).not.toHaveBeenCalled()

    await Promise.resolve()

    configStore.set('JUDGE_API_KEY', encode('judge-key-2'))

    await handler!({}, createInput())
    expect(mockVlmStop).toHaveBeenCalledTimes(1)
    expect(mockVlmStart).toHaveBeenCalledTimes(2)
    expect(mockVlmStart).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        judgeApiKey: 'judge-key-2',
      }),
    )
  })

  it('prefers JUDGE_* over ANTHROPIC_* for visual evaluation config', async () => {
    configStore.set('JUDGE_API_KEY', encode('judge-key'))
    configStore.set('JUDGE_BASE_URL', encode('https://judge.example.com'))
    configStore.set('JUDGE_MODEL', encode('glm-5'))
    configStore.set('ANTHROPIC_BASE_URL', encode('https://agent.example.com'))
    configStore.set('ANTHROPIC_MODEL', encode('claude-sonnet-agent'))

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    await handler!({}, createInput())

    expect(mockVlmStart).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        judgeApiKey: 'judge-key',
        judgeBaseUrl: 'https://judge.example.com',
        judgeModel: 'glm-5',
      }),
    )

    const engineRunOptions = mockEngineRun.mock.calls[0][4] as {
      anthropicApiKey?: string
      anthropicBaseUrl?: string
      anthropicModel?: string
    }
    expect(engineRunOptions.anthropicApiKey).toBe('anthropic-key')
    expect(engineRunOptions.anthropicBaseUrl).toBe('https://agent.example.com')
    expect(engineRunOptions.anthropicModel).toBe('claude-sonnet-agent')
  })

  it('falls back to ANTHROPIC_* when JUDGE_* is absent', async () => {
    configStore.set('ANTHROPIC_BASE_URL', encode('https://fallback-agent.example.com'))
    configStore.set('ANTHROPIC_MODEL', encode('claude-sonnet-fallback'))

    const { win } = createWindowCollector()
    const { registerAgentHandlers } = await import('../../../src/main/ipc/agent.handler')
    registerAgentHandlers(win)

    const handler = handlerMap.get(IPC_CHANNELS.TASK_START)
    expect(handler).toBeTruthy()

    await handler!({}, createInput())

    expect(mockVlmStart).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        judgeApiKey: 'anthropic-key',
        judgeBaseUrl: 'https://fallback-agent.example.com',
        judgeModel: 'claude-sonnet-fallback',
      }),
    )
  })
})

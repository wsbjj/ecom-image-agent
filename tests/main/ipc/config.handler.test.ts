import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../src/shared/ipc-channels'

const {
  handlerMap,
  mockInsertEvaluationTemplate,
  mockSetConfigValue,
  mockGetConfigValue,
  mockInsertTemplate,
  mockListTemplates,
  mockDeleteTemplate,
  mockListEvaluationTemplates,
  mockDeleteEvaluationTemplate,
  mockEnsureDefaultEvaluationTemplate,
  mockAnthropicMessagesCreate,
  mockAnthropicModelsList,
  mockCodexStartThread,
  mockCodexThreadRun,
  mockSeedreamProviderCtor,
  mockSeedreamVisualProviderCtor,
  mockSeedreamProviderGenerate,
  mockSeedreamVisualGenerate,
} = vi.hoisted(() => ({
  handlerMap: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  mockInsertEvaluationTemplate: vi.fn(),
  mockSetConfigValue: vi.fn(),
  mockGetConfigValue: vi.fn(),
  mockInsertTemplate: vi.fn(),
  mockListTemplates: vi.fn(),
  mockDeleteTemplate: vi.fn(),
  mockListEvaluationTemplates: vi.fn(),
  mockDeleteEvaluationTemplate: vi.fn(),
  mockEnsureDefaultEvaluationTemplate: vi.fn(),
  mockAnthropicMessagesCreate: vi.fn(),
  mockAnthropicModelsList: vi.fn(),
  mockCodexStartThread: vi.fn(),
  mockCodexThreadRun: vi.fn(),
  mockSeedreamProviderCtor: vi.fn(),
  mockSeedreamVisualProviderCtor: vi.fn(),
  mockSeedreamProviderGenerate: vi.fn(),
  mockSeedreamVisualGenerate: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlerMap.set(channel, handler)
    }),
  },
  safeStorage: {
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString('utf8')),
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: {
      create: mockAnthropicMessagesCreate,
    },
    models: {
      list: mockAnthropicModelsList,
    },
  })),
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(() => ({
    startThread: mockCodexStartThread,
  })),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(),
}))

vi.mock('../../../src/main/agent/providers/seedream.provider', () => ({
  SeedreamProvider: mockSeedreamProviderCtor.mockImplementation(() => ({
    generate: mockSeedreamProviderGenerate,
  })),
}))

vi.mock('../../../src/main/agent/providers/seedream-visual.provider', () => ({
  SeedreamVisualProvider: mockSeedreamVisualProviderCtor.mockImplementation(() => ({
    generate: mockSeedreamVisualGenerate,
  })),
}))

vi.mock('../../../src/main/db/queries', () => ({
  setConfigValue: mockSetConfigValue,
  getConfigValue: mockGetConfigValue,
  insertTemplate: mockInsertTemplate,
  listTemplates: mockListTemplates,
  deleteTemplate: mockDeleteTemplate,
  insertEvaluationTemplate: mockInsertEvaluationTemplate,
  listEvaluationTemplates: mockListEvaluationTemplates,
  deleteEvaluationTemplate: mockDeleteEvaluationTemplate,
  ensureDefaultEvaluationTemplate: mockEnsureDefaultEvaluationTemplate,
}))

import { registerConfigHandlers } from '../../../src/main/ipc/config.handler'

const VALID_MARKDOWN = `
## 评分维度

| key | 名称 | 满分 | 权重 | 描述 |
| --- | --- | --- | --- | --- |
| edge_distortion | 边缘畸变 | 30 | 0.3 | 检查商品边缘是否清晰 |

## 评分说明

保持写实一致性，给出可执行修正建议。
`.trim()

function encodeStoredValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (const item of items) {
        yield item
      }
    },
  }
}

describe('registerConfigHandlers eval-template:save', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockInsertEvaluationTemplate.mockResolvedValue(undefined)
    mockAnthropicMessagesCreate.mockReset()
    mockGetConfigValue.mockResolvedValue(undefined)
  })

  it('parses markdown rubric and stores normalized JSON payload', async () => {
    registerConfigHandlers()
    const saveHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_SAVE)
    expect(saveHandler).toBeTruthy()

    await saveHandler!(
      {},
      {
        name: '标准评估模板',
        version: 1,
        defaultThreshold: 85,
        rubricMarkdown: VALID_MARKDOWN,
      },
    )

    expect(mockInsertEvaluationTemplate).toHaveBeenCalledTimes(1)
    expect(mockInsertEvaluationTemplate).toHaveBeenCalledWith({
      name: '标准评估模板',
      version: 1,
      defaultThreshold: 85,
      rubric: {
        dimensions: [
          {
            key: 'edge_distortion',
            name: '边缘畸变',
            maxScore: 30,
            weight: 0.3,
            description: '检查商品边缘是否清晰',
          },
        ],
        scoringNotes: '保持写实一致性，给出可执行修正建议。',
      },
    })
  })

  it('throws clear validation error for invalid markdown', async () => {
    registerConfigHandlers()
    const saveHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_SAVE)
    expect(saveHandler).toBeTruthy()

    await expect(
      saveHandler!(
        {},
        {
          name: '坏模板',
          version: 1,
          defaultThreshold: 85,
          rubricMarkdown: '## 评分说明\\n\\n只有说明没有维度',
        },
      ),
    ).rejects.toThrow(/评分维度/)
  })
})

describe('registerConfigHandlers eval-template:generate-draft', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockAnthropicMessagesCreate.mockReset()
    mockGetConfigValue.mockResolvedValue(undefined)
  })

  it('returns normalized draft from anthropic response without writing db', async () => {
    mockGetConfigValue.mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return encodeStoredValue('sk-ant-test')
      if (key === 'ANTHROPIC_MODEL') return encodeStoredValue('claude-sonnet-4-test')
      return undefined
    })
    mockAnthropicMessagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: ' 女装主图评估模板 ',
            defaultThreshold: '101',
            rubricMarkdown: VALID_MARKDOWN,
          }),
        },
      ],
    })

    registerConfigHandlers()
    const generateHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_DRAFT)
    expect(generateHandler).toBeTruthy()

    const result = (await generateHandler!({}, {
      requirements: '女装主图，强调材质写实与文字正确',
    })) as {
      name: string
      defaultThreshold: number
      rubricMarkdown: string
    }

    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
    expect(result.name).toBe('女装主图评估模板')
    expect(result.defaultThreshold).toBe(100)
    expect(result.rubricMarkdown).toContain('## 评分维度')
    expect(result.rubricMarkdown).toContain('## 评分说明')
    expect(mockInsertEvaluationTemplate).not.toHaveBeenCalled()
  })

  it('throws clear error when anthropic api key is missing', async () => {
    registerConfigHandlers()
    const generateHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_DRAFT)
    expect(generateHandler).toBeTruthy()

    await expect(
      generateHandler!({}, { requirements: '生成评估模板' }),
    ).rejects.toThrow(/Anthropic API Key/)
    expect(mockAnthropicMessagesCreate).not.toHaveBeenCalled()
  })

  it('retries once when first draft is invalid and succeeds on second attempt', async () => {
    mockGetConfigValue.mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return encodeStoredValue('sk-ant-test')
      return undefined
    })
    mockAnthropicMessagesCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: '坏草稿',
              defaultThreshold: 85,
              rubricMarkdown: '## 评分说明\n\n只有说明没有维度',
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: '修复后草稿',
              defaultThreshold: 90,
              rubricMarkdown: VALID_MARKDOWN,
            }),
          },
        ],
      })

    registerConfigHandlers()
    const generateHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_DRAFT)
    expect(generateHandler).toBeTruthy()

    const result = (await generateHandler!({}, {
      requirements: '修复重试场景',
    })) as {
      name: string
      defaultThreshold: number
      rubricMarkdown: string
    }

    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(2)
    expect(result.name).toBe('修复后草稿')
    expect(result.defaultThreshold).toBe(90)
    expect(result.rubricMarkdown).toContain('edge_distortion')
  })

  it('throws clear error when both attempts fail validation', async () => {
    mockGetConfigValue.mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return encodeStoredValue('sk-ant-test')
      return undefined
    })
    mockAnthropicMessagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"name":"坏草稿","defaultThreshold":85,"rubricMarkdown":"无效内容"}',
        },
      ],
    })

    registerConfigHandlers()
    const generateHandler = handlerMap.get(IPC_CHANNELS.EVAL_TEMPLATE_GENERATE_DRAFT)
    expect(generateHandler).toBeTruthy()

    await expect(
      generateHandler!({}, { requirements: '两次失败场景' }),
    ).rejects.toThrow(/AI 生成模板失败/)
    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(2)
    expect(mockInsertEvaluationTemplate).not.toHaveBeenCalled()
  })
})

describe('registerConfigHandlers config:test-codex', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockGetConfigValue.mockResolvedValue(undefined)
    mockCodexThreadRun.mockReset()
    mockCodexStartThread.mockReset()
    mockCodexStartThread.mockReturnValue({
      run: mockCodexThreadRun,
    })
  })

  it('returns clear error when codex api key is missing', async () => {
    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_TEST_CODEX)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {})) as {
      success: boolean
      message: string
    }
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Codex API Key/i)
    expect(mockCodexThreadRun).not.toHaveBeenCalled()
  })

  it('tests codex connection with explicit params', async () => {
    mockCodexThreadRun.mockResolvedValue({
      items: [],
      finalResponse: '{"draft_prompt":"ok"}',
      usage: null,
    })

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_TEST_CODEX)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {
      apiKey: 'codex-key',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'gpt-5.4',
    })) as {
      success: boolean
      message: string
    }

    expect(mockCodexStartThread).toHaveBeenCalledWith({
      model: 'gpt-5.4',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    })
    expect(mockCodexThreadRun).toHaveBeenCalledWith('ping')
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/succeeded/i)
  })

  it('returns failure message when codex thread run throws', async () => {
    mockCodexThreadRun.mockRejectedValue(new Error('codex unavailable'))

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_TEST_CODEX)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, { apiKey: 'codex-key' })) as {
      success: boolean
      message: string
    }

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/codex unavailable/i)
  })

  it('returns parsed diagnostics and hint for codex upstream errors', async () => {
    mockCodexThreadRun.mockRejectedValue(
      new Error(
        'unexpected status 502 Bad Gateway: Upstream request failed, url: https://agent.cam01.cn/v1/responses, request id: req-502-test',
      ),
    )

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_TEST_CODEX)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, { apiKey: 'codex-key' })) as {
      success: boolean
      message: string
    }

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/status=502/i)
    expect(result.message).toMatch(/request_id=req-502-test/i)
    expect(result.message).toMatch(/agent\.cam01\.cn\/v1\/responses/i)
    expect(result.message).toMatch(/official endpoint/i)
  })
})

describe('registerConfigHandlers config:fetch-anthropic-models', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockGetConfigValue.mockResolvedValue(undefined)
    mockAnthropicModelsList.mockReset()
  })

  it('returns clear error when anthropic api key is missing', async () => {
    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_FETCH_ANTHROPIC_MODELS)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {})) as {
      success: boolean
      message: string
      models: Array<{ id: string; displayName: string }>
    }

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Anthropic API Key/)
    expect(result.models).toEqual([])
    expect(mockAnthropicModelsList).not.toHaveBeenCalled()
  })

  it('returns normalized model list for explicit anthropic params', async () => {
    mockAnthropicModelsList.mockReturnValue(
      createAsyncIterable([
        {
          id: 'claude-sonnet-4-20250514',
          display_name: 'Claude Sonnet 4',
        },
        {
          id: 'claude-opus-4-20250514',
          display_name: 'Claude Opus 4',
        },
      ]),
    )

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_FETCH_ANTHROPIC_MODELS)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {
      apiKey: 'sk-ant-test',
      baseUrl: 'https://proxy.example.com',
    })) as {
      success: boolean
      message: string
      models: Array<{ id: string; displayName: string }>
    }

    expect(mockAnthropicModelsList).toHaveBeenCalledWith({ limit: 100 })
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/已获取 2 个可用模型/)
    expect(result.models).toEqual([
      { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' },
    ])
  })
})

describe('registerConfigHandlers config:fetch-judge-models', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockGetConfigValue.mockResolvedValue(undefined)
    mockAnthropicModelsList.mockReset()
  })

  it('returns clear error when neither judge nor fallback anthropic api key is configured', async () => {
    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_FETCH_JUDGE_MODELS)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {})) as {
      success: boolean
      message: string
      models: Array<{ id: string; displayName: string }>
    }

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Judge API Key/i)
    expect(result.models).toEqual([])
    expect(mockAnthropicModelsList).not.toHaveBeenCalled()
  })

  it('uses explicit judge params to fetch model list', async () => {
    mockAnthropicModelsList.mockReturnValue(
      createAsyncIterable([
        {
          id: 'glm-5',
          display_name: 'GLM 5',
        },
      ]),
    )

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_FETCH_JUDGE_MODELS)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {
      apiKey: 'judge-key',
      baseUrl: 'https://judge.example.com',
    })) as {
      success: boolean
      message: string
      models: Array<{ id: string; displayName: string }>
    }

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/Judge 模型/)
    expect(result.models).toEqual([{ id: 'glm-5', displayName: 'GLM 5' }])
  })

  it('falls back to anthropic config when judge config is absent', async () => {
    mockGetConfigValue.mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return encodeStoredValue('sk-ant-test')
      if (key === 'ANTHROPIC_BASE_URL') return encodeStoredValue('https://fallback.example.com')
      return undefined
    })
    mockAnthropicModelsList.mockReturnValue(
      createAsyncIterable([
        {
          id: 'glm-5',
          display_name: 'GLM 5',
        },
      ]),
    )

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_FETCH_JUDGE_MODELS)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {})) as {
      success: boolean
      message: string
      models: Array<{ id: string; displayName: string }>
    }

    expect(result.success).toBe(true)
    expect(result.models).toEqual([{ id: 'glm-5', displayName: 'GLM 5' }])
    expect(mockAnthropicModelsList).toHaveBeenCalledWith({ limit: 100 })
  })
})

describe('registerConfigHandlers config:test-image-provider', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockGetConfigValue.mockResolvedValue(undefined)
    mockSeedreamProviderGenerate.mockReset()
    mockSeedreamVisualGenerate.mockReset()
  })

  it('allows visual_official test without Seedream API key when AK/SK are provided', async () => {
    mockSeedreamVisualGenerate.mockResolvedValue({
      imagePath: '/tmp/visual.png',
      promptUsed: 'test',
      debugInfo: {
        providerMode: 'visual_official',
      },
    })

    registerConfigHandlers()
    const handler = handlerMap.get(IPC_CHANNELS.CONFIG_TEST_IMAGE_PROVIDER)
    expect(handler).toBeTruthy()

    const result = (await handler!({}, {
      provider: 'seedream',
      callMode: 'visual_official',
      accessKeyId: 'ak-test',
      secretAccessKey: 'sk-test',
      reqKey: 'high_aes_general_v30l_zt2i',
      endpointId: 'doubao-seedream-3-0-t2i-250415',
    })) as {
      success: boolean
      message: string
      durationMs?: number
    }

    expect(result.success).toBe(true)
    expect(mockSeedreamVisualProviderCtor).toHaveBeenCalledTimes(1)
    expect(mockSeedreamProviderCtor).not.toHaveBeenCalled()
    expect(mockSeedreamVisualGenerate).toHaveBeenCalledTimes(1)
  })
})

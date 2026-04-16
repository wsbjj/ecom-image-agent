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
    decryptString: vi.fn(() => ''),
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(),
}))

vi.mock('../../../src/main/agent/providers/seedream.provider', () => ({
  SeedreamProvider: vi.fn(),
}))

vi.mock('../../../src/main/agent/providers/seedream-visual.provider', () => ({
  SeedreamVisualProvider: vi.fn(),
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

describe('registerConfigHandlers eval-template:save', () => {
  beforeEach(() => {
    handlerMap.clear()
    vi.clearAllMocks()
    mockInsertEvaluationTemplate.mockResolvedValue(undefined)
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRun } from '../../../src/renderer/pages/TaskRun'
import { useAgentStore } from '../../../src/renderer/store/agent.store'
import type { ImageAsset, EvaluationTemplateRecord } from '../../../src/shared/types'

vi.mock('../../../src/renderer/components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}))

vi.mock('../../../src/renderer/components/CsvImporter', () => ({
  CsvImporter: () => <div data-testid="csv-importer" />,
}))

vi.mock('../../../src/renderer/components/ScoreGauge', () => ({
  ScoreGauge: () => <div data-testid="score-gauge" />,
}))

vi.mock('../../../src/renderer/components/ImageUploadZone', () => ({
  ImageUploadZone: ({ label, value }: { label: string; value: ImageAsset[] }) => (
    <div data-testid="image-upload-zone" data-label={label} data-paths={value.map((item) => item.path).join('|')} />
  ),
}))

const TASKRUN_LAST_INPUT_KEY = 'TASKRUN_LAST_INPUT_V1'
const TASKRUN_LAST_INPUT_VERSION = 'taskrun_last_input_v1'

const DEFAULT_TEMPLATES: EvaluationTemplateRecord[] = [
  {
    id: 1,
    name: 'Default',
    version: 1,
    default_threshold: 85,
    rubric_json: '{}',
    created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  },
  {
    id: 2,
    name: 'Beauty',
    version: 3,
    default_threshold: 96,
    rubric_json: '{}',
    created_at: new Date('2026-01-02T00:00:00.000Z').toISOString(),
  },
]

interface SnapshotInput {
  skuId: string
  productName: string
  context: string
  productImages: ImageAsset[]
  referenceImages: ImageAsset[]
  userPrompt: string
  evaluationTemplateId: number | null
  scoreThresholdOverrideInput: string
}

function mockConfigValues(
  overrides: Record<string, string | null> = {},
): void {
  vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => ({
    value: Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null,
  }))
}

function buildSnapshotValue(
  overrides: Partial<SnapshotInput> = {},
): string {
  const input: SnapshotInput = {
    skuId: 'SKU-0013',
    productName: '液体瓶',
    context: '前打圆形聚光灯',
    productImages: [{ path: 'C:/images/product-valid-1.jpg', angle: 'front', isPrimary: true }],
    referenceImages: [{ path: 'C:/images/ref-valid-1.jpg' }],
    userPrompt: '两瓶精华液在左侧背景墙上投射锐利阴影',
    evaluationTemplateId: 2,
    scoreThresholdOverrideInput: '96',
    ...overrides,
  }

  return JSON.stringify({
    version: TASKRUN_LAST_INPUT_VERSION,
    savedAt: Date.now(),
    input,
  })
}

function mockReadableImagePaths(readablePaths: string[]): void {
  const readableSet = new Set(readablePaths)
  vi.mocked(window.api.readImageAsDataUrl).mockImplementation(async (path: string) => ({
    dataUrl: readableSet.has(path) ? `data:image/mock;base64,${path}` : null,
  }))
}

function buildRoundPreview(roundIndex: number) {
  return {
    roundIndex,
    generatedImagePath: `/tmp/generated-${roundIndex + 1}.png`,
    previewImagePath: `/tmp/preview-${roundIndex + 1}.png`,
    score: 90 + roundIndex,
    timestamp: Date.now() + roundIndex,
  }
}

describe('TaskRun round preview timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useAgentStore.setState({
      activeTaskId: null,
      currentPhase: null,
      currentScore: null,
      retryCount: 0,
      costUsd: 0,
      contextUsage: null,
      roundPreviews: [],
      logLines: [],
      isRunning: false,
    })

    vi.mocked(window.api.startTask).mockResolvedValue({ taskId: 'test-task-id' })
    vi.mocked(window.api.stopTask).mockResolvedValue({ success: true })
    vi.mocked(window.api.saveConfig).mockResolvedValue({ success: true })
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: null,
    })
    vi.mocked(window.api.listEvaluationTemplates).mockResolvedValue(DEFAULT_TEMPLATES)
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({ dataUrl: null })
  })

  it('renders compact clickable thumbnails and opens preview dialog', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0), buildRoundPreview(1)],
    })

    render(<TaskRun />)

    const timeline = await screen.findByTestId('round-preview-timeline')
    expect(timeline).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open round 1 preview' }))

    expect(screen.getByRole('dialog', { name: 'Round 1 image preview' })).toBeInTheDocument()
  })

  it('shows placeholders instead of file:// fallback when preview DataURL is unavailable', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0)],
    })
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({ dataUrl: null })

    render(<TaskRun />)

    await screen.findByTestId('round-preview-placeholder-0')
    expect(screen.queryByAltText('round-1')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open round 1 preview' }))
    expect(await screen.findByTestId('round-preview-overlay-placeholder')).toBeInTheDocument()
  })

  it('renders round preview image from DataURL when available', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0)],
    })
    mockReadableImagePaths(['/tmp/preview-1.png'])

    render(<TaskRun />)

    await waitFor(() => {
      expect(screen.getByAltText('round-1')).toBeInTheDocument()
    })
    const preview = screen.getByAltText('round-1') as HTMLImageElement
    expect(preview.src).toContain('data:image/mock;base64,/tmp/preview-1.png')
    expect(preview.src).not.toContain('file://')
  })

  it('closes preview dialog by overlay click, close button, and Escape key', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0)],
    })

    render(<TaskRun />)

    const user = userEvent.setup()
    const openButton = await screen.findByRole('button', { name: 'Open round 1 preview' })

    await user.click(openButton)
    expect(screen.getByRole('dialog', { name: 'Round 1 image preview' })).toBeInTheDocument()

    await user.click(screen.getByTestId('round-preview-overlay'))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })

    await user.click(openButton)
    await user.click(screen.getByRole('button', { name: 'Close preview' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })

    await user.click(openButton)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })
  })

  it('shows empty placeholder when no round previews exist', async () => {
    render(<TaskRun />)

    expect(await screen.findByTestId('round-preview-empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open round/i })).not.toBeInTheDocument()
  })

  it('loads snapshot and fills all editable fields in single-task mode', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue({
        skuId: 'SKU-LOADED-1',
        productName: '回填商品',
        context: '回填场景',
        userPrompt: '回填提示词',
        evaluationTemplateId: 2,
        scoreThresholdOverrideInput: '97',
      }),
    })
    mockReadableImagePaths(['C:/images/product-valid-1.jpg', 'C:/images/ref-valid-1.jpg'])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))

    await screen.findByTestId('taskrun-quickload-message')
    expect(screen.getByTestId('taskrun-sku-input')).toHaveValue('SKU-LOADED-1')
    expect(screen.getByTestId('taskrun-product-name-input')).toHaveValue('回填商品')
    expect(screen.getByTestId('taskrun-context-input')).toHaveValue('回填场景')
    expect(screen.getByTestId('taskrun-user-prompt-input')).toHaveValue('回填提示词')
    expect(screen.getByTestId('taskrun-eval-template-select')).toHaveValue('2')
    expect(screen.getByTestId('taskrun-threshold-override-input')).toHaveValue('97')
  })

  it('does not auto-start when loading snapshot', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue(),
    })
    mockReadableImagePaths(['C:/images/product-valid-1.jpg', 'C:/images/ref-valid-1.jpg'])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))

    await screen.findByTestId('taskrun-quickload-message')
    expect(window.api.startTask).not.toHaveBeenCalled()
  })

  it('persists TASKRUN_LAST_INPUT_V1 before start and keeps snapshot isolated from runtime state', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue({
        skuId: '  SKU-SAVE-1  ',
        productName: '  液体瓶  ',
        context: '  前打圆形光斑  ',
        userPrompt: '  用户补充  ',
        scoreThresholdOverrideInput: ' 96 ',
      }),
    })
    mockReadableImagePaths(['C:/images/product-valid-1.jpg', 'C:/images/ref-valid-1.jpg'])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))
    await screen.findByTestId('taskrun-quickload-message')
    await user.click(screen.getByTestId('taskrun-start-button'))

    await waitFor(() => {
      expect(window.api.startTask).toHaveBeenCalledTimes(1)
    })

    const saveCall = vi.mocked(window.api.saveConfig).mock.calls.find(
      (call) => call[0] === TASKRUN_LAST_INPUT_KEY,
    )
    expect(saveCall).toBeTruthy()
    const [, rawSnapshot] = saveCall as [string, string]
    const parsedSnapshot = JSON.parse(rawSnapshot) as {
      version: string
      savedAt: number
      input: Record<string, unknown>
    }

    expect(parsedSnapshot.version).toBe(TASKRUN_LAST_INPUT_VERSION)
    expect(typeof parsedSnapshot.savedAt).toBe('number')
    expect(parsedSnapshot.input).toMatchObject({
      skuId: 'SKU-SAVE-1',
      productName: '液体瓶',
      context: '前打圆形光斑',
      userPrompt: '用户补充',
      evaluationTemplateId: 2,
      scoreThresholdOverrideInput: '96',
    })
    expect(parsedSnapshot).not.toHaveProperty('activeTaskId')
    expect(parsedSnapshot).not.toHaveProperty('currentPhase')
    expect(parsedSnapshot).not.toHaveProperty('retryCount')
    expect(parsedSnapshot).not.toHaveProperty('costUsd')
    expect(parsedSnapshot).not.toHaveProperty('contextUsage')
    expect(parsedSnapshot).not.toHaveProperty('roundPreviews')
    expect(parsedSnapshot).not.toHaveProperty('logLines')
  })

  it('removes invalid image paths and shows cleanup hint while loading snapshot', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue({
        productImages: [
          { path: 'C:/images/product-valid-1.jpg', angle: 'front' },
          { path: 'C:/images/product-invalid-1.jpg', angle: 'side' },
        ],
        referenceImages: [
          { path: 'C:/images/ref-invalid-1.jpg' },
        ],
      }),
    })
    mockReadableImagePaths(['C:/images/product-valid-1.jpg'])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))

    const quickLoadMessage = await screen.findByTestId('taskrun-quickload-message')
    expect(quickLoadMessage).toHaveTextContent('已自动移除失效图片：商品图 1 张，参考图 1 张。')
  })

  it('starts with only valid image paths after snapshot cleanup', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue({
        productImages: [
          { path: 'C:/images/product-valid-1.jpg', angle: 'front', isPrimary: true },
          { path: 'C:/images/product-invalid-1.jpg', angle: 'side' },
        ],
        referenceImages: [
          { path: 'C:/images/ref-invalid-1.jpg' },
        ],
      }),
    })
    mockReadableImagePaths(['C:/images/product-valid-1.jpg'])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))
    await screen.findByTestId('taskrun-quickload-message')
    await user.click(screen.getByTestId('taskrun-start-button'))

    await waitFor(() => {
      expect(window.api.startTask).toHaveBeenCalledTimes(1)
    })

    const startPayload = vi.mocked(window.api.startTask).mock.calls[0]?.[0] as {
      productImages: ImageAsset[]
      referenceImages?: ImageAsset[]
    }
    expect(startPayload.productImages).toEqual([
      { path: 'C:/images/product-valid-1.jpg', angle: 'front', isPrimary: true },
    ])
    expect(startPayload.referenceImages).toBeUndefined()
  })

  it('keeps start disabled when all loaded product images are invalid', async () => {
    mockConfigValues({
      AGENT_SCORE_THRESHOLD: '85',
      EVAL_TEMPLATE_DEFAULT_ID: '1',
      [TASKRUN_LAST_INPUT_KEY]: buildSnapshotValue({
        productImages: [{ path: 'C:/images/product-invalid-1.jpg' }],
      }),
    })
    mockReadableImagePaths([])

    render(<TaskRun />)

    const user = userEvent.setup()
    await user.click(await screen.findByTestId('taskrun-load-last-button'))

    const quickLoadMessage = await screen.findByTestId('taskrun-quickload-message')
    expect(quickLoadMessage).toHaveTextContent('商品图已清空，请重新上传后再启动任务。')
    expect(screen.getByTestId('taskrun-start-button')).toBeDisabled()
  })
})

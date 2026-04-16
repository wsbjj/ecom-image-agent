import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Templates } from '../../../src/renderer/pages/Templates'

vi.mock('../../../src/renderer/components/MonacoPane', () => ({
  MonacoPane: ({
    value,
    onChange,
    language = 'json',
    readOnly = false,
  }: {
    value: string
    onChange: (value: string) => void
    language?: string
    readOnly?: boolean
  }) => (
    <div
      data-testid={readOnly ? 'monaco-readonly' : 'monaco-editor'}
      data-language={language}
      data-readonly={readOnly ? 'true' : 'false'}
    >
      <textarea
        aria-label={readOnly ? 'readonly-monaco' : 'editable-monaco'}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  ),
}))

describe('Templates evaluation markdown workflow', () => {
  const DRAFT_MARKDOWN = `
## 评分维度

| key | 名称 | 满分 | 权重 | 描述 |
| --- | --- | --- | --- | --- |
| realism | 写实一致性 | 40 | 0.4 | 检查主体结构与材质写实程度 |
| lighting | 光影逻辑 | 30 | 0.3 | 检查阴影方向和强度是否合理 |
| text_logo | 文案与logo | 30 | 0.3 | 检查文字及logo是否正确 |

## 评分说明

出现错品或严重结构错误时，相关维度不高于半分。
`.trim()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.listTemplates).mockResolvedValue([])
    vi.mocked(window.api.listEvaluationTemplates).mockResolvedValue([])
    vi.mocked(window.api.saveEvaluationTemplate).mockResolvedValue({ success: true })
    vi.mocked(window.api.deleteEvaluationTemplate).mockResolvedValue({ success: true })
    vi.mocked(window.api.generateEvaluationTemplateDraft).mockResolvedValue({
      name: '女装主图评估模板',
      defaultThreshold: 88,
      rubricMarkdown: DRAFT_MARKDOWN,
    })
    vi.mocked(window.api.generateStandardEvaluationTemplate).mockResolvedValue({
      id: 1,
      name: '默认电商评估标准',
      version: 1,
      default_threshold: 85,
      rubric_json: '{}',
      created_at: new Date().toISOString(),
    })
  })

  it('defaults to split mode with markdown editor and semantic preview', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: '新建' }))

    const editor = screen.getByTestId('monaco-editor')
    expect(editor).toHaveAttribute('data-language', 'markdown')
    const textarea = screen.getByLabelText('editable-monaco') as HTMLTextAreaElement
    expect(textarea.value).toContain('## 评分维度')
    expect(textarea.value).toContain('## 评分说明')
    const previewPane = screen.getByTestId('eval-rubric-preview')
    expect(previewPane).toBeInTheDocument()
    expect(previewPane).toHaveClass('min-h-0', 'flex', 'flex-col')
    const previewScrollBody = screen.getByTestId('eval-rubric-preview-scroll-body')
    expect(previewScrollBody).toHaveClass('min-h-0', 'overflow-y-auto')
    expect(screen.getByText('edge_distortion')).toBeInTheDocument()
  })

  it('opens AI draft modal and requests draft generation', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: 'AI 生成评估模板' }))
    expect(screen.getByRole('dialog', { name: 'AI 生成评估模板' })).toBeInTheDocument()

    const requirementsInput = screen.getByPlaceholderText(
      '例如：女装主图，强调面料质感与真人肤色自然，重点避免衣服结构变形和文字错误...',
    )
    await user.type(requirementsInput, '女装主图，需要强调材质写实和文字准确')
    await user.click(screen.getByRole('button', { name: '生成草稿' }))

    await waitFor(() => {
      expect(window.api.generateEvaluationTemplateDraft).toHaveBeenCalledWith({
        requirements: '女装主图，需要强调材质写实和文字准确',
      })
    })
    expect(screen.getByTestId('eval-draft-result')).toBeInTheDocument()
  })

  it('imports generated draft into editor and still saves via rubricMarkdown payload', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: 'AI 生成评估模板' }))
    await user.type(
      screen.getByPlaceholderText(
        '例如：女装主图，强调面料质感与真人肤色自然，重点避免衣服结构变形和文字错误...',
      ),
      '女装电商主图质检',
    )
    await user.click(screen.getByRole('button', { name: '生成草稿' }))

    await waitFor(() => {
      expect(screen.getByTestId('eval-draft-result')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: '导入到编辑器' }))
    expect(screen.queryByRole('dialog', { name: 'AI 生成评估模板' })).not.toBeInTheDocument()

    expect((screen.getByPlaceholderText('评估模板名称') as HTMLInputElement).value).toBe(
      '女装主图评估模板',
    )
    expect((screen.getByPlaceholderText('默认阈值') as HTMLInputElement).value).toBe('88')
    expect(screen.getByTestId('eval-editor-header')).toHaveClass('space-y-3')
    expect(screen.getByTestId('eval-editor-field-grid')).toHaveClass(
      'grid-cols-1',
      'sm:grid-cols-2',
      'xl:grid-cols-3',
    )
    expect(screen.getByTestId('eval-editor-save-row')).toBeInTheDocument()
    expect((screen.getByLabelText('editable-monaco') as HTMLTextAreaElement).value).toContain('realism')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(window.api.saveEvaluationTemplate).toHaveBeenCalledTimes(1)
    })
    const payload = vi.mocked(window.api.saveEvaluationTemplate).mock.calls[0]?.[0]
    expect(payload.name).toBe('女装主图评估模板')
    expect(payload.defaultThreshold).toBe(88)
    expect(payload.rubricMarkdown).toContain('## 评分维度')
  })

  it('shows generation error only inside modal and does not save template', async () => {
    vi.mocked(window.api.generateEvaluationTemplateDraft).mockRejectedValue(
      new Error('未检测到 Anthropic API Key'),
    )

    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: 'AI 生成评估模板' }))
    await user.type(
      screen.getByPlaceholderText(
        '例如：女装主图，强调面料质感与真人肤色自然，重点避免衣服结构变形和文字错误...',
      ),
      '生成失败场景',
    )
    await user.click(screen.getByRole('button', { name: '生成草稿' }))

    await waitFor(() => {
      expect(screen.getByTestId('eval-draft-error')).toHaveTextContent('未检测到 Anthropic API Key')
    })
    expect(window.api.saveEvaluationTemplate).not.toHaveBeenCalled()
  })

  it('switches between source / preview / split modes', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: '新建' }))

    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    expect(screen.getByTestId('eval-rubric-preview')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '预览' }))
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.getByTestId('eval-rubric-preview')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '源码' }))
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('eval-rubric-preview')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '双栏' }))
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    expect(screen.getByTestId('eval-rubric-preview')).toBeInTheDocument()
  })

  it('shows parse errors and keeps last valid preview content', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: '新建' }))

    expect(screen.getByText('edge_distortion')).toBeInTheDocument()
    const textarea = screen.getByLabelText('editable-monaco')
    fireEvent.change(textarea, { target: { value: 'bad markdown' } })

    await waitFor(() => {
      expect(screen.getByTestId('eval-preview-parse-error')).toBeInTheDocument()
    })
    expect(screen.getByText('edge_distortion')).toBeInTheDocument()
  })

  it('saves evaluation template with rubricMarkdown payload', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: '新建' }))

    const nameInput = screen.getByPlaceholderText('评估模板名称')
    await user.type(nameInput, 'Markdown 模板')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(window.api.saveEvaluationTemplate).toHaveBeenCalledTimes(1)
    })

    const payload = vi.mocked(window.api.saveEvaluationTemplate).mock.calls[0]?.[0]
    expect(payload.name).toBe('Markdown 模板')
    expect(payload.version).toBe(1)
    expect(payload.defaultThreshold).toBe(85)
    expect(payload.rubricMarkdown).toContain('## 评分维度')
    expect('rubric' in payload).toBe(false)
  })

  it('renders saved rubric_json in preview mode for read-only template view', async () => {
    vi.mocked(window.api.listEvaluationTemplates).mockResolvedValue([
      {
        id: 7,
        name: '历史模板',
        version: 1,
        default_threshold: 85,
        rubric_json: JSON.stringify({
          dimensions: [
            {
              key: 'edge_distortion',
              name: '边缘畸变',
              maxScore: 30,
              weight: 0.3,
              description: '检查商品边缘是否清晰',
            },
          ],
          scoringNotes: '保持写实一致性',
        }),
        created_at: new Date().toISOString(),
      },
    ])

    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(await screen.findByText('历史模板'))

    expect(screen.getByTestId('monaco-readonly')).toBeInTheDocument()
    expect(screen.getByTestId('eval-rubric-preview')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '预览' }))

    expect(screen.queryByTestId('monaco-readonly')).not.toBeInTheDocument()
    expect(screen.getByTestId('eval-rubric-preview')).toBeInTheDocument()
    expect(screen.getByText('edge_distortion')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '源码' }))
    const readonlyPane = screen.getByTestId('monaco-readonly')
    expect(readonlyPane).toHaveAttribute('data-language', 'markdown')
    const textarea = screen.getByLabelText('readonly-monaco') as HTMLTextAreaElement
    expect(textarea.value).toContain('## 评分维度')
    expect(textarea.value).toContain('edge_distortion')
  })
})

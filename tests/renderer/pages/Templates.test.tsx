import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.listTemplates).mockResolvedValue([])
    vi.mocked(window.api.listEvaluationTemplates).mockResolvedValue([])
    vi.mocked(window.api.saveEvaluationTemplate).mockResolvedValue({ success: true })
    vi.mocked(window.api.deleteEvaluationTemplate).mockResolvedValue({ success: true })
    vi.mocked(window.api.generateStandardEvaluationTemplate).mockResolvedValue({
      id: 1,
      name: '默认电商评估标准',
      version: 1,
      default_threshold: 85,
      rubric_json: '{}',
      created_at: new Date().toISOString(),
    })
  })

  it('uses markdown editor for new evaluation template', async () => {
    render(<Templates />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '评估模板' }))
    await user.click(screen.getByRole('button', { name: '新建' }))

    const editor = screen.getByTestId('monaco-editor')
    expect(editor).toHaveAttribute('data-language', 'markdown')
    const textarea = screen.getByLabelText('editable-monaco') as HTMLTextAreaElement
    expect(textarea.value).toContain('## 评分维度')
    expect(textarea.value).toContain('## 评分说明')
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

  it('renders saved rubric_json as markdown in read-only panel', async () => {
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

    const readonlyPane = screen.getByTestId('monaco-readonly')
    expect(readonlyPane).toHaveAttribute('data-language', 'markdown')
    const textarea = screen.getByLabelText('readonly-monaco') as HTMLTextAreaElement
    expect(textarea.value).toContain('## 评分维度')
    expect(textarea.value).toContain('edge_distortion')
  })
})

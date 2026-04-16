import { useEffect, useState, useCallback, useMemo } from 'react'
import { MonacoPane } from '../components/MonacoPane'
import {
  parseEvalRubricMarkdown,
  formatEvalRubricMarkdown,
} from '../../shared/eval-rubric-markdown'
import type {
  TemplateRecord,
  TemplateInput,
  EvaluationTemplateRecord,
  EvalRubric,
  EvalTemplateDraftResponse,
} from '../../shared/types'

type EvalViewMode = 'source' | 'preview' | 'split'

const DEFAULT_PROMPT_TEMPLATE: TemplateInput = {
  name: '',
  style: 'minimalist',
  lighting: 'soft natural',
  system_prompt: JSON.stringify(
    {
      prompt_template:
        'Professional product photography of {product_name}, {style} style, {lighting} lighting, white background, 8K resolution',
      negative_prompt: 'blurry, distorted, text overlay, watermark',
    },
    null,
    2,
  ),
}

const DEFAULT_EVAL_RUBRIC: EvalRubric = {
  dimensions: [
    {
      key: 'edge_distortion',
      name: '边缘畸变',
      maxScore: 30,
      weight: 0.3,
      description: '检查商品边缘是否清晰、是否有畸变或锯齿。',
    },
    {
      key: 'perspective_lighting',
      name: '透视与光影',
      maxScore: 30,
      weight: 0.3,
      description: '检查透视关系、光影方向、阴影是否符合写实逻辑。',
    },
    {
      key: 'hallucination',
      name: '幻觉物体',
      maxScore: 30,
      weight: 0.3,
      description: '检查是否出现错误物体、错字、虚假 logo 或产品结构变化。',
    },
    {
      key: 'overall_quality',
      name: '整体商业质量',
      maxScore: 10,
      weight: 0.1,
      description: '综合判断是否可直接用于电商发布。',
    },
  ],
  scoringNotes: '保持写实一致性，给出可执行修正建议。',
}

const DEFAULT_EVAL_FORM = {
  name: '',
  version: '1',
  defaultThreshold: '85',
  rubricMarkdown: formatEvalRubricMarkdown(DEFAULT_EVAL_RUBRIC),
}

function formatStoredRubricAsMarkdown(rubricJson: string): string {
  try {
    const rubric = JSON.parse(rubricJson) as EvalRubric
    return formatEvalRubricMarkdown(rubric)
  } catch {
    return ['## 评分维度', '', '> 解析 rubric_json 失败，以下是原始内容：', '', '```json', rubricJson, '```'].join(
      '\n',
    )
  }
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Rubric Markdown 格式不合法'
}

interface EvalRubricPreviewPaneProps {
  markdown: string
  lastValidRubric: EvalRubric | null
  parseError: string | null
}

function EvalRubricPreviewPane({ markdown, lastValidRubric, parseError }: EvalRubricPreviewPaneProps) {
  return (
    <div
      data-testid="eval-rubric-preview"
      className="h-full min-h-0 flex flex-col rounded-lg border border-gray-700/80 bg-gray-900/40 p-4"
    >
      <h4 className="text-sm font-semibold text-gray-200">语义预览</h4>
      <p className="mt-1 text-xs text-gray-500">按评估模板解析规则渲染，保存前可提前发现结构问题。</p>

      <div
        data-testid="eval-rubric-preview-scroll-body"
        className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1"
      >
        {parseError && (
          <div
            data-testid="eval-preview-parse-error"
            className="mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          >
            <div className="font-medium">预览解析失败</div>
            <div className="mt-1 break-all">{parseError}</div>
            {lastValidRubric && <div className="mt-1 text-amber-100/90">已保留最近一次成功解析结果。</div>}
          </div>
        )}

        {lastValidRubric ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-gray-400">评分维度</div>
              <div className="overflow-x-auto rounded-lg border border-gray-700/60">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-gray-800/70 text-gray-300">
                    <tr>
                      <th className="px-3 py-2 font-medium">key</th>
                      <th className="px-3 py-2 font-medium">名称</th>
                      <th className="px-3 py-2 font-medium">满分</th>
                      <th className="px-3 py-2 font-medium">权重</th>
                      <th className="px-3 py-2 font-medium">描述</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastValidRubric.dimensions.map((dimension) => (
                      <tr key={dimension.key} className="border-t border-gray-800 text-gray-200">
                        <td className="px-3 py-2 align-top font-mono">{dimension.key}</td>
                        <td className="px-3 py-2 align-top">{dimension.name}</td>
                        <td className="px-3 py-2 align-top">{dimension.maxScore}</td>
                        <td className="px-3 py-2 align-top">{dimension.weight}</td>
                        <td className="px-3 py-2 align-top whitespace-pre-wrap">{dimension.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-gray-400">评分说明</div>
              <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
                {lastValidRubric.scoringNotes?.trim() || '（未填写评分说明）'}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-700/50 bg-gray-800/30 px-3 py-4 text-sm text-gray-400">
            {markdown.trim() ? '当前内容无法解析为评估模板，请修复后查看预览。' : '暂无内容可预览。'}
          </div>
        )}
      </div>
    </div>
  )
}

export function Templates() {
  const [tab, setTab] = useState<'prompt' | 'evaluation'>('prompt')

  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [selected, setSelected] = useState<TemplateRecord | null>(null)
  const [isCreatingPrompt, setIsCreatingPrompt] = useState(false)
  const [form, setForm] = useState<TemplateInput>(DEFAULT_PROMPT_TEMPLATE)

  const [evalTemplates, setEvalTemplates] = useState<EvaluationTemplateRecord[]>([])
  const [selectedEval, setSelectedEval] = useState<EvaluationTemplateRecord | null>(null)
  const [isCreatingEval, setIsCreatingEval] = useState(false)
  const [evalForm, setEvalForm] = useState(DEFAULT_EVAL_FORM)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false)
  const [draftRequirements, setDraftRequirements] = useState('')
  const [draftErrorMessage, setDraftErrorMessage] = useState<string | null>(null)
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false)
  const [generatedDraft, setGeneratedDraft] = useState<EvalTemplateDraftResponse | null>(null)
  const [evalViewMode, setEvalViewMode] = useState<EvalViewMode>('split')
  const [previewState, setPreviewState] = useState<{
    key: string
    lastValidRubric: EvalRubric | null
    parseError: string | null
  }>({
    key: '',
    lastValidRubric: null,
    parseError: null,
  })

  const selectedEvalMarkdown = useMemo(() => {
    if (!selectedEval) return ''
    return formatStoredRubricAsMarkdown(selectedEval.rubric_json)
  }, [selectedEval])

  const activeEvalMarkdown = isCreatingEval ? evalForm.rubricMarkdown : selectedEvalMarkdown
  const activePreviewKey = isCreatingEval
    ? 'eval-draft'
    : selectedEval
      ? `eval-template-${selectedEval.id}`
      : 'eval-empty'

  const loadTemplates = useCallback(async () => {
    const [promptTemplates, evaluation] = await Promise.all([
      window.api.listTemplates(),
      window.api.listEvaluationTemplates(),
    ])
    setTemplates(promptTemplates)
    setEvalTemplates(evaluation)
  }, [])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  const handleSavePrompt = useCallback(async () => {
    if (!form.name.trim()) return
    await window.api.saveTemplate(form)
    setIsCreatingPrompt(false)
    setForm(DEFAULT_PROMPT_TEMPLATE)
    await loadTemplates()
  }, [form, loadTemplates])

  const handleDeletePrompt = useCallback(
    async (id: number) => {
      await window.api.deleteTemplate(id)
      if (selected?.id === id) setSelected(null)
      await loadTemplates()
    },
    [selected, loadTemplates],
  )

  const handleSaveEvaluation = useCallback(async () => {
    setErrorMessage(null)
    if (!evalForm.name.trim()) {
      setErrorMessage('评估模板名称不能为空')
      return
    }

    try {
      parseEvalRubricMarkdown(evalForm.rubricMarkdown)
    } catch (error: unknown) {
      setErrorMessage(resolveErrorMessage(error))
      return
    }

    const version = Number.parseInt(evalForm.version, 10)
    const defaultThreshold = Number.parseInt(evalForm.defaultThreshold, 10)
    if (!Number.isInteger(version) || version <= 0) {
      setErrorMessage('版本号必须是正整数')
      return
    }
    if (!Number.isInteger(defaultThreshold) || defaultThreshold < 0 || defaultThreshold > 100) {
      setErrorMessage('默认阈值必须在 0~100')
      return
    }

    try {
      await window.api.saveEvaluationTemplate({
        name: evalForm.name.trim(),
        version,
        defaultThreshold,
        rubricMarkdown: evalForm.rubricMarkdown,
      })
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : '保存评估模板失败')
      return
    }

    setIsCreatingEval(false)
    setEvalForm(DEFAULT_EVAL_FORM)
    await loadTemplates()
  }, [evalForm, loadTemplates])

  const handleDeleteEvaluation = useCallback(
    async (id: number) => {
      await window.api.deleteEvaluationTemplate(id)
      if (selectedEval?.id === id) setSelectedEval(null)
      await loadTemplates()
    },
    [selectedEval, loadTemplates],
  )

  const handleCloseDraftModal = useCallback(() => {
    setIsDraftModalOpen(false)
    setDraftRequirements('')
    setDraftErrorMessage(null)
    setGeneratedDraft(null)
    setIsGeneratingDraft(false)
  }, [])

  const handleGenerateDraft = useCallback(async () => {
    const requirements = draftRequirements.trim()
    if (!requirements) {
      setDraftErrorMessage('请输入业务需求后再生成')
      return
    }

    setDraftErrorMessage(null)
    setIsGeneratingDraft(true)
    try {
      const draft = await window.api.generateEvaluationTemplateDraft({ requirements })
      setGeneratedDraft(draft)
    } catch (error: unknown) {
      setDraftErrorMessage(error instanceof Error ? error.message : 'AI 生成失败')
    } finally {
      setIsGeneratingDraft(false)
    }
  }, [draftRequirements])

  const handleImportGeneratedDraft = useCallback(() => {
    if (!generatedDraft) return
    setErrorMessage(null)
    setIsCreatingEval(true)
    setSelectedEval(null)
    setEvalForm({
      name: generatedDraft.name,
      version: '1',
      defaultThreshold: String(generatedDraft.defaultThreshold),
      rubricMarkdown: generatedDraft.rubricMarkdown,
    })
    setEvalViewMode('split')
    handleCloseDraftModal()
  }, [generatedDraft, handleCloseDraftModal])

  useEffect(() => {
    if (!isCreatingEval && !selectedEval) {
      setPreviewState({
        key: 'eval-empty',
        lastValidRubric: null,
        parseError: null,
      })
      return
    }

    try {
      const rubric = parseEvalRubricMarkdown(activeEvalMarkdown)
      setPreviewState({
        key: activePreviewKey,
        lastValidRubric: rubric,
        parseError: null,
      })
    } catch (error: unknown) {
      const parseError = resolveErrorMessage(error)
      setPreviewState((prev) => ({
        key: activePreviewKey,
        lastValidRubric: prev.key === activePreviewKey ? prev.lastValidRubric : null,
        parseError,
      }))
    }
  }, [activeEvalMarkdown, activePreviewKey, isCreatingEval, selectedEval])

  const renderPromptPane = () => (
    <>
      <div className="w-72 border-r border-gray-700/50 flex flex-col">
        <div className="p-4 border-b border-gray-700/50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-200">提示词模板</h2>
          <button
            onClick={() => {
              setIsCreatingPrompt(true)
              setSelected(null)
              setForm(DEFAULT_PROMPT_TEMPLATE)
            }}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs transition-colors"
          >
            新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {templates.map((t) => (
            <div
              key={t.id}
              className={`p-3 border-b border-gray-800/50 cursor-pointer transition-colors ${
                selected?.id === t.id
                  ? 'bg-blue-600/20 border-l-2 border-l-blue-500'
                  : 'hover:bg-gray-800/50'
              }`}
              onClick={() => {
                setSelected(t)
                setIsCreatingPrompt(false)
              }}
            >
              <div className="text-sm text-gray-200">{t.name}</div>
              <div className="text-xs text-gray-500 mt-1">
                {t.style} · {t.lighting}
              </div>
            </div>
          ))}
          {templates.length === 0 && <div className="p-4 text-sm text-gray-500 text-center">暂无模板</div>}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {isCreatingPrompt ? (
          <div className="flex-1 flex flex-col">
            <div className="p-4 border-b border-gray-700/50 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="模板名称"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={form.style}
                  onChange={(e) => setForm({ ...form, style: e.target.value })}
                  placeholder="风格"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={form.lighting}
                  onChange={(e) => setForm({ ...form, lighting: e.target.value })}
                  placeholder="光影"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <button
                onClick={handleSavePrompt}
                disabled={!form.name.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded-lg text-sm"
              >
                保存模板
              </button>
            </div>
            <div className="flex-1 p-4">
              <MonacoPane value={form.system_prompt} onChange={(v) => setForm({ ...form, system_prompt: v })} />
            </div>
          </div>
        ) : selected ? (
          <div className="flex-1 flex flex-col">
            <div className="p-4 border-b border-gray-700/50 flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-200">{selected.name}</h3>
                <div className="text-xs text-gray-500 mt-1">
                  {selected.style} · {selected.lighting}
                </div>
              </div>
              <button
                onClick={() => handleDeletePrompt(selected.id)}
                className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg text-xs"
              >
                删除
              </button>
            </div>
            <div className="flex-1 p-4">
              <MonacoPane value={selected.system_prompt} onChange={() => {}} readOnly />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">选择或创建提示词模板</div>
        )}
      </div>
    </>
  )

  const renderEvaluationPane = () => (
    <>
      <div className="w-80 border-r border-gray-700/50 flex flex-col">
        <div className="p-4 border-b border-gray-700/50 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-200">评估模板</h2>
            <button
              onClick={() => {
                setIsCreatingEval(true)
                setSelectedEval(null)
                setEvalForm(DEFAULT_EVAL_FORM)
              }}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs"
            >
              新建
            </button>
          </div>
          <button
            onClick={() => {
              setDraftErrorMessage(null)
              setGeneratedDraft(null)
              setDraftRequirements('')
              setIsDraftModalOpen(true)
            }}
            className="w-full px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 rounded-lg text-xs"
          >
            AI 生成评估模板
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {evalTemplates.map((t) => (
            <div
              key={t.id}
              className={`p-3 border-b border-gray-800/50 cursor-pointer transition-colors ${
                selectedEval?.id === t.id
                  ? 'bg-blue-600/20 border-l-2 border-l-blue-500'
                  : 'hover:bg-gray-800/50'
              }`}
              onClick={() => {
                setSelectedEval(t)
                setIsCreatingEval(false)
              }}
            >
              <div className="text-sm text-gray-200">{t.name}</div>
              <div className="text-xs text-gray-500 mt-1">
                v{t.version} · 阈值 {t.default_threshold}
              </div>
            </div>
          ))}
          {evalTemplates.length === 0 && (
            <div className="p-4 text-sm text-gray-500 text-center">暂无评估模板</div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {(isCreatingEval || selectedEval) && (
          <div className="mx-4 mt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => setEvalViewMode('source')}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                evalViewMode === 'source'
                  ? 'bg-blue-600/30 text-blue-200 border border-blue-500/40'
                  : 'bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700/70'
              }`}
            >
              源码
            </button>
            <button
              onClick={() => setEvalViewMode('preview')}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                evalViewMode === 'preview'
                  ? 'bg-blue-600/30 text-blue-200 border border-blue-500/40'
                  : 'bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700/70'
              }`}
            >
              预览
            </button>
            <button
              onClick={() => setEvalViewMode('split')}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                evalViewMode === 'split'
                  ? 'bg-blue-600/30 text-blue-200 border border-blue-500/40'
                  : 'bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700/70'
              }`}
            >
              双栏
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="m-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {errorMessage}
          </div>
        )}

        {isCreatingEval ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div data-testid="eval-editor-header" className="p-4 border-b border-gray-700/50 space-y-3">
              <div
                data-testid="eval-editor-field-grid"
                className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
              >
                <input
                  value={evalForm.name}
                  onChange={(e) => setEvalForm({ ...evalForm, name: e.target.value })}
                  placeholder="评估模板名称"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={evalForm.version}
                  onChange={(e) => setEvalForm({ ...evalForm, version: e.target.value })}
                  placeholder="版本"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={evalForm.defaultThreshold}
                  onChange={(e) => setEvalForm({ ...evalForm, defaultThreshold: e.target.value })}
                  placeholder="默认阈值"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div data-testid="eval-editor-save-row" className="flex justify-end">
                <button
                  onClick={handleSaveEvaluation}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm"
                >
                  保存
                </button>
              </div>
            </div>
            {evalViewMode === 'source' && (
              <div className="flex-1 min-h-0 p-4">
                <MonacoPane
                  value={evalForm.rubricMarkdown}
                  onChange={(v) => setEvalForm({ ...evalForm, rubricMarkdown: v })}
                  language="markdown"
                />
              </div>
            )}
            {evalViewMode === 'preview' && (
              <div className="flex-1 min-h-0 p-4">
                <EvalRubricPreviewPane
                  markdown={evalForm.rubricMarkdown}
                  lastValidRubric={previewState.lastValidRubric}
                  parseError={previewState.parseError}
                />
              </div>
            )}
            {evalViewMode === 'split' && (
              <div className="flex-1 min-h-0 p-4 grid grid-cols-2 gap-4 overflow-hidden">
                <div className="min-h-0">
                  <MonacoPane
                    value={evalForm.rubricMarkdown}
                    onChange={(v) => setEvalForm({ ...evalForm, rubricMarkdown: v })}
                    language="markdown"
                  />
                </div>
                <div className="min-h-0">
                  <EvalRubricPreviewPane
                    markdown={evalForm.rubricMarkdown}
                    lastValidRubric={previewState.lastValidRubric}
                    parseError={previewState.parseError}
                  />
                </div>
              </div>
            )}
          </div>
        ) : selectedEval ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="p-4 border-b border-gray-700/50 flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-200">{selectedEval.name}</h3>
                <div className="text-xs text-gray-500 mt-1">
                  v{selectedEval.version} · 默认阈值 {selectedEval.default_threshold}
                </div>
              </div>
              <button
                onClick={() => handleDeleteEvaluation(selectedEval.id)}
                className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg text-xs"
              >
                删除
              </button>
            </div>
            {evalViewMode === 'source' && (
              <div className="flex-1 min-h-0 p-4">
                <MonacoPane value={selectedEvalMarkdown} onChange={() => {}} language="markdown" readOnly />
              </div>
            )}
            {evalViewMode === 'preview' && (
              <div className="flex-1 min-h-0 p-4">
                <EvalRubricPreviewPane
                  markdown={selectedEvalMarkdown}
                  lastValidRubric={previewState.lastValidRubric}
                  parseError={previewState.parseError}
                />
              </div>
            )}
            {evalViewMode === 'split' && (
              <div className="flex-1 min-h-0 p-4 grid grid-cols-2 gap-4 overflow-hidden">
                <div className="min-h-0">
                  <MonacoPane value={selectedEvalMarkdown} onChange={() => {}} language="markdown" readOnly />
                </div>
                <div className="min-h-0">
                  <EvalRubricPreviewPane
                    markdown={selectedEvalMarkdown}
                    lastValidRubric={previewState.lastValidRubric}
                    parseError={previewState.parseError}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">选择或创建评估模板</div>
        )}
      </div>
    </>
  )

  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        <div className="w-48 border-r border-gray-700/50 p-3 space-y-2">
          <button
            onClick={() => setTab('prompt')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
              tab === 'prompt' ? 'bg-blue-600/30 text-blue-200' : 'bg-gray-800 text-gray-400'
            }`}
          >
            提示词模板
          </button>
          <button
            onClick={() => setTab('evaluation')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
              tab === 'evaluation' ? 'bg-blue-600/30 text-blue-200' : 'bg-gray-800 text-gray-400'
            }`}
          >
            评估模板
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {tab === 'prompt' ? renderPromptPane() : renderEvaluationPane()}
        </div>
      </div>

      {isDraftModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          data-testid="eval-draft-modal-overlay"
          onClick={() => {
            if (!isGeneratingDraft) handleCloseDraftModal()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="AI 生成评估模板"
            className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 p-4 space-y-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-100">AI 生成评估模板</h3>
              <button
                onClick={handleCloseDraftModal}
                disabled={isGeneratingDraft}
                className="px-2 py-1 rounded-lg border border-gray-600 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                关闭
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-gray-400">业务需求</label>
              <textarea
                value={draftRequirements}
                onChange={(event) => setDraftRequirements(event.target.value)}
                placeholder="例如：女装主图，强调面料质感与真人肤色自然，重点避免衣服结构变形和文字错误..."
                rows={4}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            {draftErrorMessage && (
              <div
                data-testid="eval-draft-error"
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300"
              >
                {draftErrorMessage}
              </div>
            )}

            {generatedDraft && (
              <div data-testid="eval-draft-result" className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-gray-700/60 bg-gray-800/30 px-3 py-2 text-xs text-gray-300">
                    模板名称：<span className="text-gray-100">{generatedDraft.name}</span>
                  </div>
                  <div className="rounded-lg border border-gray-700/60 bg-gray-800/30 px-3 py-2 text-xs text-gray-300">
                    默认阈值：<span className="text-gray-100">{generatedDraft.defaultThreshold}</span>
                  </div>
                </div>
                <div className="rounded-lg border border-gray-700/60 bg-gray-950/60 p-3">
                  <div className="text-xs text-gray-400 mb-2">生成的 Rubric Markdown</div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-gray-200">
                    {generatedDraft.rubricMarkdown}
                  </pre>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDraftModal}
                disabled={isGeneratingDraft}
                className="px-4 py-2 rounded-lg border border-gray-600 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleGenerateDraft}
                disabled={isGeneratingDraft}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-sm"
              >
                {isGeneratingDraft ? '生成中...' : '生成草稿'}
              </button>
              <button
                onClick={handleImportGeneratedDraft}
                disabled={!generatedDraft || isGeneratingDraft}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-sm"
              >
                导入到编辑器
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

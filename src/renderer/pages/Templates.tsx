import { useEffect, useState, useCallback } from 'react'
import { MonacoPane } from '../components/MonacoPane'
import type {
  TemplateRecord,
  TemplateInput,
  EvaluationTemplateRecord,
  EvalRubric,
} from '../../shared/types'

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
  rubric: JSON.stringify(DEFAULT_EVAL_RUBRIC, null, 2),
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

    let rubric: EvalRubric
    try {
      rubric = JSON.parse(evalForm.rubric) as EvalRubric
      if (!Array.isArray(rubric.dimensions) || rubric.dimensions.length === 0) {
        setErrorMessage('rubric.dimensions 不能为空')
        return
      }
    } catch {
      setErrorMessage('Rubric JSON 格式不合法')
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

    await window.api.saveEvaluationTemplate({
      name: evalForm.name.trim(),
      version,
      defaultThreshold,
      rubric,
    })

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

  const handleGenerateStandard = useCallback(async () => {
    await window.api.generateStandardEvaluationTemplate()
    await loadTemplates()
  }, [loadTemplates])

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
            onClick={handleGenerateStandard}
            className="w-full px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 rounded-lg text-xs"
          >
            一键生成标准模板
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

      <div className="flex-1 flex flex-col">
        {errorMessage && (
          <div className="m-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {errorMessage}
          </div>
        )}

        {isCreatingEval ? (
          <div className="flex-1 flex flex-col">
            <div className="p-4 border-b border-gray-700/50 grid grid-cols-3 gap-3">
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
              <div className="flex gap-2">
                <input
                  value={evalForm.defaultThreshold}
                  onChange={(e) => setEvalForm({ ...evalForm, defaultThreshold: e.target.value })}
                  placeholder="默认阈值"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                />
                <button
                  onClick={handleSaveEvaluation}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm"
                >
                  保存
                </button>
              </div>
            </div>
            <div className="flex-1 p-4">
              <MonacoPane value={evalForm.rubric} onChange={(v) => setEvalForm({ ...evalForm, rubric: v })} />
            </div>
          </div>
        ) : selectedEval ? (
          <div className="flex-1 flex flex-col">
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
            <div className="flex-1 p-4">
              <MonacoPane value={selectedEval.rubric_json} onChange={() => {}} readOnly />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">选择或创建评估模板</div>
        )}
      </div>
    </>
  )

  return (
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
  )
}

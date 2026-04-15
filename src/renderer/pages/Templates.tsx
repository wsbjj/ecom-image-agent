import { useEffect, useState, useCallback } from 'react'
import { MonacoPane } from '../components/MonacoPane'
import type { TemplateRecord, TemplateInput } from '../../shared/types'

const DEFAULT_TEMPLATE: TemplateInput = {
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

export function Templates(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [selected, setSelected] = useState<TemplateRecord | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [form, setForm] = useState<TemplateInput>(DEFAULT_TEMPLATE)

  const loadTemplates = useCallback(async () => {
    const list = await window.api.listTemplates()
    setTemplates(list)
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) return
    await window.api.saveTemplate(form)
    setIsCreating(false)
    setForm(DEFAULT_TEMPLATE)
    await loadTemplates()
  }, [form, loadTemplates])

  const handleDelete = useCallback(
    async (id: number) => {
      await window.api.deleteTemplate(id)
      if (selected?.id === id) setSelected(null)
      await loadTemplates()
    },
    [selected, loadTemplates],
  )

  const handleSelect = useCallback((t: TemplateRecord) => {
    setSelected(t)
    setIsCreating(false)
  }, [])

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 border-r border-gray-700/50 flex flex-col">
        <div className="p-4 border-b border-gray-700/50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-200">提示词模板</h2>
          <button
            onClick={() => {
              setIsCreating(true)
              setSelected(null)
              setForm(DEFAULT_TEMPLATE)
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
              onClick={() => handleSelect(t)}
            >
              <div className="text-sm text-gray-200">{t.name}</div>
              <div className="text-xs text-gray-500 mt-1">
                {t.style} · {t.lighting}
              </div>
            </div>
          ))}
          {templates.length === 0 && (
            <div className="p-4 text-sm text-gray-500 text-center">
              暂无模板，点击「新建」创建
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        {isCreating ? (
          <div className="flex-1 flex flex-col">
            <div className="p-4 border-b border-gray-700/50 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">模板名称</label>
                  <input
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                    placeholder="极简白底"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">风格</label>
                  <input
                    value={form.style}
                    onChange={(e) =>
                      setForm({ ...form, style: e.target.value })
                    }
                    placeholder="minimalist"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">光影</label>
                  <input
                    value={form.lighting}
                    onChange={(e) =>
                      setForm({ ...form, lighting: e.target.value })
                    }
                    placeholder="soft natural"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <button
                onClick={handleSave}
                disabled={!form.name.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
              >
                保存模板
              </button>
            </div>
            <div className="flex-1 p-4">
              <MonacoPane
                value={form.system_prompt}
                onChange={(v) => setForm({ ...form, system_prompt: v })}
              />
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
                onClick={() => handleDelete(selected.id)}
                className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg text-xs transition-colors"
              >
                删除
              </button>
            </div>
            <div className="flex-1 p-4">
              <MonacoPane value={selected.system_prompt} onChange={() => {}} readOnly />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            选择一个模板查看，或点击「新建」创建
          </div>
        )}
      </div>
    </div>
  )
}

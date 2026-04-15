import { useState, useCallback } from 'react'
import type { TaskInput } from '../../shared/types'

interface CsvImporterProps {
  onImport: (tasks: TaskInput[]) => void
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

function parseCsv(text: string): TaskInput[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const skuIdx = headers.indexOf('sku_id')
  const nameIdx = headers.indexOf('product_name')
  const contextIdx = headers.indexOf('context')
  const templateIdx = headers.indexOf('template_id')

  if (skuIdx === -1 || nameIdx === -1) return []

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line)
    return {
      skuId: cols[skuIdx] ?? '',
      productName: cols[nameIdx] ?? '',
      context: contextIdx >= 0 ? (cols[contextIdx] ?? '') : '',
      templateId: templateIdx >= 0 ? parseInt(cols[templateIdx] ?? '1', 10) : 1,
      productImages: [],
    }
  })
}

function parseJson(text: string): TaskInput[] {
  const data = JSON.parse(text) as Array<{
    sku_id?: string
    skuId?: string
    product_name?: string
    productName?: string
    context?: string
    template_id?: number
    templateId?: number
  }>
  return data.map((item) => ({
    skuId: item.sku_id ?? item.skuId ?? '',
    productName: item.product_name ?? item.productName ?? '',
    context: item.context ?? '',
    templateId: item.template_id ?? item.templateId ?? 1,
    productImages: [],
  }))
}

export function CsvImporter({ onImport }: CsvImporterProps): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<TaskInput[]>([])

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null)
      setPreview([])
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const text = ev.target?.result as string
          const tasks = file.name.endsWith('.json')
            ? parseJson(text)
            : parseCsv(text)

          if (tasks.length === 0) {
            setError('未解析到有效任务，请检查文件格式')
            return
          }
          setPreview(tasks)
        } catch (err) {
          setError(`解析失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      reader.readAsText(file)
    },
    [],
  )

  const handleConfirm = useCallback(() => {
    if (preview.length > 0) {
      onImport(preview)
      setPreview([])
    }
  }, [preview, onImport])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg cursor-pointer transition-colors text-sm">
          <span>选择 CSV / JSON 文件</span>
          <input
            type="file"
            accept=".csv,.json"
            onChange={handleFile}
            className="hidden"
          />
        </label>
        {preview.length > 0 && (
          <button
            onClick={handleConfirm}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm transition-colors"
          >
            确认导入 ({preview.length} 条)
          </button>
        )}
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {preview.length > 0 && (
        <div className="overflow-x-auto max-h-60 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="text-left py-2 px-3">SKU</th>
                <th className="text-left py-2 px-3">商品名称</th>
                <th className="text-left py-2 px-3">场景</th>
                <th className="text-left py-2 px-3">模板ID</th>
              </tr>
            </thead>
            <tbody>
              {preview.slice(0, 10).map((task, i) => (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="py-2 px-3 font-mono">{task.skuId}</td>
                  <td className="py-2 px-3">{task.productName}</td>
                  <td className="py-2 px-3 text-gray-400">{task.context}</td>
                  <td className="py-2 px-3">{task.templateId}</td>
                </tr>
              ))}
              {preview.length > 10 && (
                <tr>
                  <td colSpan={4} className="py-2 px-3 text-gray-500 text-center">
                    ... 还有 {preview.length - 10} 条
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

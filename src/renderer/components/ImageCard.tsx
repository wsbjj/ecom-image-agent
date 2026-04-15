import { useEffect, useState } from 'react'
import type { DefectAnalysis, TaskRecord } from '../../shared/types'
import { toFileUrl } from '../lib/fileUrl'

interface ImageCardProps {
  task: TaskRecord
}

function parseDefects(raw: string | null): DefectAnalysis | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as DefectAnalysis
  } catch {
    return null
  }
}

function defectIssuePreview(defects: DefectAnalysis): string[] {
  if (Array.isArray(defects.dimensions) && defects.dimensions.length > 0) {
    return defects.dimensions
      .flatMap((dimension) =>
        dimension.issues.slice(0, 1).map((issue) => `${dimension.name}: ${issue}`),
      )
      .slice(0, 2)
  }

  if (defects.legacy) {
    const result: string[] = []
    if (defects.legacy.edge_distortion.issues.length > 0) {
      result.push(`边缘: ${defects.legacy.edge_distortion.issues[0]}`)
    }
    if (defects.legacy.perspective_lighting.issues.length > 0) {
      result.push(`光影: ${defects.legacy.perspective_lighting.issues[0]}`)
    }
    return result.slice(0, 2)
  }

  return []
}

function getStatusColor(status: TaskRecord['status']): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
    case 'failed':
      return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'running':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    case 'pending':
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
}

function getStatusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'success':
      return '已发布'
    case 'failed':
      return '失败'
    case 'running':
      return '运行中'
    case 'pending':
      return '待处理'
  }
}

function scoreBarColor(status: TaskRecord['status']): string {
  if (status === 'success') return 'bg-emerald-500'
  if (status === 'failed') return 'bg-amber-500'
  return 'bg-blue-500'
}

export function ImageCard({ task }: ImageCardProps) {
  const defects = parseDefects(task.defect_analysis)
  const issuePreview = defects ? defectIssuePreview(defects) : []
  const [imageSrc, setImageSrc] = useState<string | null>(
    task.image_path ? toFileUrl(task.image_path) : null,
  )

  useEffect(() => {
    let mounted = true

    if (!task.image_path) {
      setImageSrc(null)
      return () => {
        mounted = false
      }
    }

    const fallbackUrl = toFileUrl(task.image_path)
    void window.api
      .readImageAsDataUrl(task.image_path)
      .then((result) => {
        if (!mounted) return
        setImageSrc(result.dataUrl ?? fallbackUrl)
      })
      .catch(() => {
        if (!mounted) return
        setImageSrc(fallbackUrl)
      })

    return () => {
      mounted = false
    }
  }, [task.image_path])

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/50 overflow-hidden hover:border-gray-600/50 transition-colors">
      <div className="aspect-square bg-gray-900 flex items-center justify-center">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={task.product_name}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-gray-600 text-sm">暂无图片</span>
        )}
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-200 truncate">
            {task.product_name}
          </h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${getStatusColor(task.status)}`}
          >
            {getStatusLabel(task.status)}
          </span>
        </div>

        <div className="text-xs text-gray-500">SKU: {task.sku_id}</div>

        {task.total_score !== null && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${scoreBarColor(task.status)}`}
                role="progressbar"
                aria-valuenow={task.total_score}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{ width: `${task.total_score}%` }}
              />
            </div>
            <span className="text-xs font-mono text-gray-400">
              {task.total_score}
            </span>
          </div>
        )}

        {defects && issuePreview.length > 0 && (
          <div className="text-xs text-gray-500 space-y-0.5">
            {issuePreview.map((line, index) => (
              <div key={`${task.task_id}-defect-${index}`}>{line}</div>
            ))}
          </div>
        )}

        {task.cost_usd !== null && (
          <div className="text-xs text-gray-500">
            费用: ${task.cost_usd.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  )
}

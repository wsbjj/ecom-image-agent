import { useState, useRef, useCallback, useEffect } from 'react'
import type { ImageAsset } from '../../shared/types'

const ANGLE_OPTIONS = ['front', 'side', 'top', 'detail'] as const
const ANGLE_LABELS: Record<string, string> = {
  front: '正面',
  side: '侧面',
  top: '顶部',
  detail: '细节',
}

interface ImageUploadZoneProps {
  label: string
  required?: boolean
  maxFiles: number
  value: ImageAsset[]
  onChange: (assets: ImageAsset[]) => void
  showAngleTag?: boolean
}

function resolveAssetPath(file: File): string {
  const legacyPath = (file as File & { path?: string }).path
  if (typeof legacyPath === 'string' && legacyPath.trim().length > 0) {
    return legacyPath.trim()
  }

  const resolvedPath = window.api.resolveLocalPath(file)
  if (typeof resolvedPath === 'string' && resolvedPath.trim().length > 0) {
    return resolvedPath.trim()
  }

  return ''
}

export function ImageUploadZone({
  label,
  required,
  maxFiles,
  value,
  onChange,
  showAngleTag,
}: ImageUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [previewSrcByPath, setPreviewSrcByPath] = useState<Record<string, string>>({})
  const loadingPreviewPathsRef = useRef<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const activePaths = Array.from(
      new Set(
        value
          .map((asset) => asset.path.trim())
          .filter((p) => p.length > 0),
      ),
    )

    setPreviewSrcByPath((prev) => {
      const next: Record<string, string> = {}
      let changed = false
      for (const imagePath of activePaths) {
        if (prev[imagePath]) {
          next[imagePath] = prev[imagePath]
        }
      }

      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (prevKeys.length !== nextKeys.length) {
        changed = true
      } else if (!prevKeys.every((key) => key in next)) {
        changed = true
      }

      return changed ? next : prev
    })

    let cancelled = false
    for (const imagePath of activePaths) {
      if (previewSrcByPath[imagePath]) continue
      if (loadingPreviewPathsRef.current.has(imagePath)) continue
      loadingPreviewPathsRef.current.add(imagePath)
      void window.api
        .readImageAsDataUrl(imagePath)
        .then((result) => {
          const dataUrl = result.dataUrl
          if (cancelled || !dataUrl) return
          setPreviewSrcByPath((prev) =>
            prev[imagePath] === dataUrl
              ? prev
              : { ...prev, [imagePath]: dataUrl },
          )
        })
        .catch(() => {
          // Ignore and keep fallback file URL.
        })
        .finally(() => {
          loadingPreviewPathsRef.current.delete(imagePath)
        })
    }

    return () => {
      cancelled = true
    }
  }, [value, previewSrcByPath])

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files)
      const remaining = maxFiles - value.length
      if (remaining <= 0) return

      const nextFiles = fileArray
        .filter((f) => f.type.startsWith('image/'))
        .slice(0, remaining)

      const hasPrimary = value.some((asset) => asset.isPrimary)
      const newAssets: ImageAsset[] = []
      for (const f of nextFiles) {
        const localPath = resolveAssetPath(f)
        if (!localPath) continue
        newAssets.push({
          path: localPath,
          angle: undefined,
          isPrimary: !hasPrimary && newAssets.length === 0,
        })
      }

      if (newAssets.length === 0) return
      onChange([...value, ...newAssets])
    },
    [value, maxFiles, onChange],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      addFiles(e.dataTransfer.files)
    },
    [addFiles],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addFiles(e.target.files)
        e.target.value = ''
      }
    },
    [addFiles],
  )

  const removeFile = useCallback(
    (index: number) => {
      const next = value.filter((_, i) => i !== index)
      onChange(next)
    },
    [value, onChange],
  )

  const setAngle = useCallback(
    (index: number, angle: string) => {
      const next = value.map((item, i) =>
        i === index ? { ...item, angle: item.angle === angle ? undefined : angle } : item,
      )
      onChange(next)
    },
    [value, onChange],
  )

  const resolvePreviewSrc = useCallback(
    (rawPath: string): string => {
      const normalizedPath = rawPath.trim()
      return previewSrcByPath[normalizedPath] ?? ''
    },
    [previewSrcByPath],
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-gray-300">{label}</span>
        {required && <span className="text-xs text-red-400">*</span>}
        <span className="text-xs text-gray-500">
          {value.length}/{maxFiles}
        </span>
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`min-h-[120px] rounded-lg border-2 border-dashed transition-colors cursor-pointer flex flex-col items-center justify-center gap-2 p-3 ${
          isDragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 hover:border-gray-600 bg-gray-800/30'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
        {value.length === 0 ? (
          <>
            <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16v-8m0 0l-3 3m3-3l3 3M3 16.5V18a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 18v-1.5M7.5 12l-2.56 2.56A2.25 2.25 0 003 16.06V18a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 18v-1.94a2.25 2.25 0 00-.66-1.59L17.78 12" />
            </svg>
            <span className="text-xs text-gray-500">拖拽图片到此处，或点击选择</span>
          </>
        ) : (
          <div className="w-full grid grid-cols-4 gap-2">
            {value.map((asset, i) => (
              <div key={`${asset.path}-${i}`} className="relative group">
                {resolvePreviewSrc(asset.path) ? (
                  <img
                    src={resolvePreviewSrc(asset.path)}
                    alt={`${label} ${i + 1}`}
                    className="w-full aspect-square object-cover rounded-md border border-gray-700"
                  />
                ) : (
                  <div
                    className="w-full aspect-square rounded-md border border-gray-700 bg-gray-900/70 flex items-center justify-center text-[10px] text-gray-500"
                    data-testid={`image-upload-placeholder-${i}`}
                  >
                    预览加载中
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFile(i)
                  }}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  x
                </button>
                {showAngleTag && (
                  <div
                    className="absolute bottom-0 left-0 right-0 flex flex-wrap gap-0.5 p-0.5 bg-black/60 rounded-b-md"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {ANGLE_OPTIONS.map((angle) => (
                      <button
                        key={angle}
                        onClick={() => setAngle(i, angle)}
                        className={`text-[10px] px-1 py-0.5 rounded transition-colors ${
                          asset.angle === angle
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-700/80 text-gray-400 hover:bg-gray-600'
                        }`}
                      >
                        {ANGLE_LABELS[angle]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {value.length < maxFiles && (
              <div className="aspect-square rounded-md border border-dashed border-gray-700 flex items-center justify-center text-gray-600 hover:text-gray-400 hover:border-gray-500 transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

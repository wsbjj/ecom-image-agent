import { useState, useCallback, useEffect, useRef } from 'react'
import { TerminalPane } from '../components/TerminalPane'
import { CsvImporter } from '../components/CsvImporter'
import { ScoreGauge } from '../components/ScoreGauge'
import { ImageUploadZone } from '../components/ImageUploadZone'
import { useAgentStore, type RoundPreviewItem } from '../store/agent.store'
import { startTask, stopTask } from '../lib/ipc'
import type { TaskInput, ImageAsset, EvaluationTemplateRecord } from '../../shared/types'
import { toFileUrl } from '../lib/fileUrl'

function parseOptionalThreshold(rawValue: string): number | undefined {
  const trimmed = rawValue.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(parsed)) return undefined
  return Math.min(100, Math.max(0, parsed))
}

function mapArtifactsToPreviews(
  artifacts: Array<{
    round_index: number
    generated_image_path: string
    preview_image_path: string | null
    score: number | null
    created_at: string
  }>,
): RoundPreviewItem[] {
  return artifacts.map((item) => ({
    roundIndex: item.round_index,
    generatedImagePath: item.generated_image_path,
    previewImagePath: item.preview_image_path ?? item.generated_image_path,
    score: item.score,
    timestamp: new Date(item.created_at).getTime() || Date.now(),
  }))
}

function parseLatestContextUsage(
  artifacts: Array<{
    context_usage: string | null
  }>,
):
  | {
      totalTokens: number
      maxTokens: number
      percentage: number
    }
  | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const raw = artifacts[index].context_usage?.trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as {
        totalTokens?: unknown
        maxTokens?: unknown
        percentage?: unknown
      }
      if (
        typeof parsed.totalTokens === 'number' &&
        Number.isFinite(parsed.totalTokens) &&
        typeof parsed.maxTokens === 'number' &&
        Number.isFinite(parsed.maxTokens) &&
        typeof parsed.percentage === 'number' &&
        Number.isFinite(parsed.percentage)
      ) {
        return {
          totalTokens: Math.round(parsed.totalTokens),
          maxTokens: Math.round(parsed.maxTokens),
          percentage: Math.min(100, Math.max(0, parsed.percentage)),
        }
      }
    } catch {
      // Ignore malformed historical payload.
    }
  }
  return null
}

export function TaskRun() {
  const {
    activeTaskId,
    currentPhase,
    currentScore,
    retryCount,
    costUsd,
    isRunning,
    contextUsage,
    roundPreviews,
  } = useAgentStore()
  const agentStartTask = useAgentStore((s) => s.startTask)
  const setRoundPreviews = useAgentStore((s) => s.setRoundPreviews)
  const setContextUsage = useAgentStore((s) => s.setContextUsage)

  const [skuId, setSkuId] = useState('')
  const [productName, setProductName] = useState('')
  const [context, setContext] = useState('')
  const [productImages, setProductImages] = useState<ImageAsset[]>([])
  const [referenceImages, setReferenceImages] = useState<ImageAsset[]>([])
  const [userPrompt, setUserPrompt] = useState('')
  const [scoreThreshold, setScoreThreshold] = useState(85)
  const [scoreThresholdOverrideInput, setScoreThresholdOverrideInput] = useState('')
  const [evalTemplates, setEvalTemplates] = useState<EvaluationTemplateRecord[]>([])
  const [evaluationTemplateId, setEvaluationTemplateId] = useState<number | null>(null)
  const [isBatch, setIsBatch] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [roundPreviewSrcByPath, setRoundPreviewSrcByPath] = useState<Record<string, string>>({})
  const [selectedRoundPreview, setSelectedRoundPreview] = useState<RoundPreviewItem | null>(null)
  const loadingRoundPreviewPathsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let mounted = true

    const load = async (): Promise<void> => {
      try {
        const thresholdResult = await window.api.getConfigValue('AGENT_SCORE_THRESHOLD')
        if (mounted) {
          const rawValue = thresholdResult.value?.trim()
          const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN
          if (Number.isInteger(parsed)) {
            setScoreThreshold(Math.min(100, Math.max(0, parsed)))
          }
        }
      } catch {
        // Ignore and keep default threshold.
      }

      try {
        let templates = await window.api.listEvaluationTemplates()
        if (templates.length === 0) {
          await window.api.generateStandardEvaluationTemplate()
          templates = await window.api.listEvaluationTemplates()
        }

        if (!mounted) return

        setEvalTemplates(templates)

        const defaultIdRaw = await window.api.getConfigValue('EVAL_TEMPLATE_DEFAULT_ID')
        const defaultId = defaultIdRaw.value ? Number.parseInt(defaultIdRaw.value, 10) : Number.NaN

        const selected = Number.isInteger(defaultId)
          ? templates.find((item) => item.id === defaultId) ?? templates[0]
          : templates[0]

        setEvaluationTemplateId(selected?.id ?? null)
      } catch {
        if (mounted) {
          setEvalTemplates([])
          setEvaluationTemplateId(null)
        }
      }
    }

    void load()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!activeTaskId) return

    let mounted = true
    void window.api
      .queryTaskRoundArtifacts(activeTaskId)
      .then((artifacts) => {
        if (!mounted) return
        setContextUsage(parseLatestContextUsage(artifacts))
        if (artifacts.length === 0) return
        setRoundPreviews(mapArtifactsToPreviews(artifacts))
      })
      .catch(() => {
        // Ignore hydrate failures.
      })

    return () => {
      mounted = false
    }
  }, [activeTaskId, setContextUsage, setRoundPreviews])

  useEffect(() => {
    const activePaths = Array.from(
      new Set(
        roundPreviews
          .flatMap((item) => [item.previewImagePath, item.generatedImagePath])
          .map((rawPath) => rawPath.trim())
          .filter((p) => p.length > 0),
      ),
    )

    setRoundPreviewSrcByPath((prev) => {
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
      if (roundPreviewSrcByPath[imagePath]) continue
      if (loadingRoundPreviewPathsRef.current.has(imagePath)) continue
      loadingRoundPreviewPathsRef.current.add(imagePath)
      void window.api
        .readImageAsDataUrl(imagePath)
        .then((result) => {
          const dataUrl = result.dataUrl
          if (cancelled || !dataUrl) return
          setRoundPreviewSrcByPath((prev) =>
            prev[imagePath] === dataUrl ? prev : { ...prev, [imagePath]: dataUrl },
          )
        })
        .catch(() => {
          // Ignore and keep fallback file URL.
        })
        .finally(() => {
          loadingRoundPreviewPathsRef.current.delete(imagePath)
        })
    }

    return () => {
      cancelled = true
    }
  }, [roundPreviews, roundPreviewSrcByPath])

  const resolveRoundPreviewSrc = useCallback(
    (rawPath: string | null | undefined): string => {
      const normalizedPath = rawPath?.trim()
      if (!normalizedPath) return ''
      return roundPreviewSrcByPath[normalizedPath] ?? toFileUrl(normalizedPath)
    },
    [roundPreviewSrcByPath],
  )

  const resolveRoundItemPreviewSrc = useCallback(
    (item: RoundPreviewItem): string =>
      resolveRoundPreviewSrc(item.previewImagePath) || resolveRoundPreviewSrc(item.generatedImagePath),
    [resolveRoundPreviewSrc],
  )

  useEffect(() => {
    if (!selectedRoundPreview) return

    const stillExists = roundPreviews.some((item) => item.roundIndex === selectedRoundPreview.roundIndex)
    if (!stillExists) {
      setSelectedRoundPreview(null)
    }
  }, [roundPreviews, selectedRoundPreview])

  useEffect(() => {
    if (!selectedRoundPreview) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelectedRoundPreview(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedRoundPreview])

  const handleStart = useCallback(async () => {
    if (!productName.trim() || !skuId.trim()) {
      setErrorMessage('请输入 SKU 和商品名称')
      return
    }
    if (!evaluationTemplateId) {
      setErrorMessage('请先选择评估模板')
      return
    }

    const validProductImages = productImages.filter(
      (img) => typeof img.path === 'string' && img.path.trim().length > 0,
    )
    if (validProductImages.length === 0) {
      setErrorMessage('请至少上传一张白底商品图')
      return
    }

    const validReferenceImages = referenceImages.filter(
      (img) => typeof img.path === 'string' && img.path.trim().length > 0,
    )

    const scoreThresholdOverride = parseOptionalThreshold(scoreThresholdOverrideInput)

    try {
      setErrorMessage(null)
      const taskId = await startTask({
        skuId,
        productName,
        context,
        templateId: 1,
        productImages: validProductImages,
        referenceImages: validReferenceImages.length > 0 ? validReferenceImages : undefined,
        userPrompt: userPrompt.trim() || undefined,
        evaluationTemplateId,
        scoreThresholdOverride,
      })
      agentStartTask(taskId)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '启动任务失败，请检查配置后重试'
      setErrorMessage(message)
    }
  }, [
    productName,
    skuId,
    evaluationTemplateId,
    productImages,
    referenceImages,
    scoreThresholdOverrideInput,
    context,
    userPrompt,
    agentStartTask,
  ])

  const handleStop = useCallback(async () => {
    if (activeTaskId) {
      try {
        setErrorMessage(null)
        await stopTask(activeTaskId)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '停止任务失败，请稍后重试'
        setErrorMessage(message)
      }
    }
  }, [activeTaskId])

  const handleBatchImport = useCallback(
    async (tasks: TaskInput[]) => {
      try {
        setErrorMessage(null)
        for (const task of tasks) {
          const taskId = await startTask(task)
          agentStartTask(taskId)
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '批量任务启动失败，请检查配置后重试'
        setErrorMessage(message)
      }
    },
    [agentStartTask],
  )

  const usagePercent = contextUsage ? contextUsage.percentage.toFixed(1) : '--'
  const usageTokens = contextUsage ? `${contextUsage.totalTokens}/${contextUsage.maxTokens}` : '--'

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-gray-700/50 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-100">任务执行</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setIsBatch(!isBatch)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
            >
              {isBatch ? '单任务模式' : '批量导入'}
            </button>
          </div>
        </div>

        {errorMessage && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {errorMessage}
          </div>
        )}

        {isBatch ? (
          <CsvImporter onImport={handleBatchImport} />
        ) : (
          <div className="space-y-4">
            <div className="flex gap-3 items-end">
              <div className="flex-1 space-y-1">
                <label className="text-xs text-gray-400">SKU</label>
                <input
                  value={skuId}
                  onChange={(e) => setSkuId(e.target.value)}
                  placeholder="SKU001"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs text-gray-400">商品名称</label>
                <input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="北欧陶瓷杯"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="flex-[2] space-y-1">
                <label className="text-xs text-gray-400">拍摄场景</label>
                <input
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="侧逆光极简白底场景，柔和阴影"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              {isRunning ? (
                <button
                  onClick={handleStop}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={!productName.trim() || !skuId.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                >
                  开始生成
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              <div className="lg:col-span-5">
                <ImageUploadZone
                  label="白底商品图"
                  required
                  maxFiles={8}
                  value={productImages}
                  onChange={setProductImages}
                  showAngleTag
                />
              </div>
              <div className="lg:col-span-4">
                <ImageUploadZone
                  label="参考风格图"
                  maxFiles={5}
                  value={referenceImages}
                  onChange={setReferenceImages}
                />
              </div>
              <div className="space-y-2 lg:col-span-3">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">评估模板</label>
                  <select
                    value={evaluationTemplateId ?? ''}
                    onChange={(e) =>
                      setEvaluationTemplateId(
                        e.target.value ? Number.parseInt(e.target.value, 10) : null,
                      )
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    {evalTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name} v{template.version}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400">阈值覆盖（可选）</label>
                  <input
                    value={scoreThresholdOverrideInput}
                    onChange={(e) => setScoreThresholdOverrideInput(e.target.value)}
                    placeholder={`默认 ${scoreThreshold}`}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="lg:col-span-12 rounded-lg border border-gray-700/60 bg-gray-900/25 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-gray-300">自定义提示词</span>
                    <span className="text-xs text-gray-500">可选</span>
                  </div>
                  <span className="text-[11px] text-gray-500">会拼接到系统 Prompt 末尾</span>
                </div>
                <textarea
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  placeholder="输入补充提示词，例如材质、氛围、构图偏好..."
                  rows={3}
                  className="w-full min-h-[72px] bg-gray-800/35 border border-dashed border-gray-700 rounded-lg px-3 py-2 text-sm resize-y focus:border-blue-500 focus:outline-none placeholder:text-gray-600"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-4 space-y-4 overflow-y-auto">
          <div className="h-[56%] min-h-[300px]">
            <TerminalPane />
          </div>

          <div className="rounded-lg border border-gray-700/50 bg-gray-900/30 p-3">
            <div className="text-xs text-gray-400 mb-3">轮次生成时间线（仅 generate_image 输出）</div>
            {roundPreviews.length === 0 ? (
              <div className="text-xs text-gray-500" data-testid="round-preview-empty">暂无轮次图片</div>
            ) : (
              <div className="flex flex-wrap gap-2.5" data-testid="round-preview-timeline">
                {roundPreviews.map((item) => (
                  <button
                    key={item.roundIndex}
                    type="button"
                    aria-label={`Open round ${item.roundIndex + 1} preview`}
                    title={`Round ${item.roundIndex + 1}`}
                    className="group w-36 sm:w-40 rounded-md border border-gray-700/60 overflow-hidden text-left bg-gray-900/40 hover:border-gray-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 transition-colors"
                    onClick={() => setSelectedRoundPreview(item)}
                  >
                    <img
                      src={resolveRoundItemPreviewSrc(item)}
                      alt={`round-${item.roundIndex + 1}`}
                      className="w-full h-24 sm:h-28 object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                      onError={(event) => {
                        const fallbackSrc = resolveRoundPreviewSrc(item.generatedImagePath)
                        if (fallbackSrc && event.currentTarget.src !== fallbackSrc) {
                          event.currentTarget.src = fallbackSrc
                        }
                      }}
                    />
                    <div className="px-2 py-1.5 text-[11px] bg-gray-900/80 text-gray-300 flex justify-between">
                      <span>第 {item.roundIndex + 1} 轮</span>
                      <span>{item.score !== null ? `${item.score}` : '--'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="w-72 border-l border-gray-700/50 p-4 space-y-6">
          <div className="relative flex items-center justify-center">
            <ScoreGauge score={currentScore} passThreshold={scoreThreshold} />
          </div>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">状态</span>
              <span
                className={`font-medium ${
                  currentPhase === 'success'
                    ? 'text-emerald-400'
                    : currentPhase === 'failed'
                      ? 'text-red-400'
                      : isRunning
                        ? 'text-blue-400'
                        : 'text-gray-400'
                }`}
              >
                {currentPhase ? currentPhase.toUpperCase() : '空闲'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">重试次数</span>
              <span className="text-gray-200">{retryCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">累计费用</span>
              <span className="text-amber-400 font-mono">${costUsd.toFixed(4)}</span>
            </div>
            {activeTaskId && (
              <div className="flex justify-between">
                <span className="text-gray-500">Task ID</span>
                <span className="text-gray-400 font-mono text-xs truncate ml-2">
                  {activeTaskId.slice(0, 8)}...
                </span>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 space-y-2">
            <div className="text-xs text-blue-300">上下文状态（简洁模式）</div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">当前 Phase</span>
              <span className="text-gray-100">{currentPhase ?? '--'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">占用率</span>
              <span className="text-blue-200">{usagePercent}%</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">Tokens</span>
              <span className="text-blue-200 font-mono">{usageTokens}</span>
            </div>
          </div>
        </div>
      </div>

      {selectedRoundPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          data-testid="round-preview-overlay"
          onClick={() => setSelectedRoundPreview(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Round ${selectedRoundPreview.roundIndex + 1} image preview`}
            className="relative w-full max-w-5xl rounded-xl border border-gray-700 bg-gray-900/95 p-3 sm:p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close preview"
              className="absolute right-2 top-2 rounded-md border border-gray-600/80 bg-gray-800/80 px-2 py-1 text-sm text-gray-200 hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
              onClick={() => setSelectedRoundPreview(null)}
            >
              ×
            </button>

            <div className="mb-2 pr-10 text-xs text-gray-300 flex items-center justify-between">
              <span>第 {selectedRoundPreview.roundIndex + 1} 轮</span>
              <span>{selectedRoundPreview.score !== null ? `${selectedRoundPreview.score}` : '--'}</span>
            </div>

            <div className="rounded-lg bg-black/40 p-2 flex items-center justify-center">
              <img
                src={resolveRoundItemPreviewSrc(selectedRoundPreview)}
                alt={`round-${selectedRoundPreview.roundIndex + 1}-full`}
                className="max-h-[80vh] w-auto max-w-full object-contain rounded-md"
                onError={(event) => {
                  const fallbackSrc = resolveRoundPreviewSrc(selectedRoundPreview.generatedImagePath)
                  if (fallbackSrc && event.currentTarget.src !== fallbackSrc) {
                    event.currentTarget.src = fallbackSrc
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


import { useState, useCallback } from 'react'
import { TerminalPane } from '../components/TerminalPane'
import { CsvImporter } from '../components/CsvImporter'
import { ScoreGauge } from '../components/ScoreGauge'
import { useAgentStore } from '../store/agent.store'
import { startTask, stopTask } from '../lib/ipc'
import type { TaskInput } from '../../shared/types'

export function TaskRun(): JSX.Element {
  const { activeTaskId, currentPhase, currentScore, retryCount, costUsd, isRunning } =
    useAgentStore()
  const agentStartTask = useAgentStore((s) => s.startTask)

  const [skuId, setSkuId] = useState('')
  const [productName, setProductName] = useState('')
  const [context, setContext] = useState('')
  const [isBatch, setIsBatch] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleStart = useCallback(async () => {
    if (!productName.trim() || !skuId.trim()) return
    try {
      setErrorMessage(null)
      const taskId = await startTask({
        skuId,
        productName,
        context,
        templateId: 1,
      })
      agentStartTask(taskId)
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : '启动任务失败，请检查配置后重试'
      setErrorMessage(message)
    }
  }, [skuId, productName, context, agentStartTask])

  const handleStop = useCallback(async () => {
    if (activeTaskId) {
      try {
        setErrorMessage(null)
        await stopTask(activeTaskId)
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : '停止任务失败，请稍后重试'
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
        const message =
          error instanceof Error ? error.message : '批量任务启动失败，请检查配置后重试'
        setErrorMessage(message)
      }
    },
    [agentStartTask],
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
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
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Terminal */}
        <div className="flex-1 p-4">
          <TerminalPane />
        </div>

        {/* Side panel */}
        <div className="w-64 border-l border-gray-700/50 p-4 space-y-6">
          <div className="relative flex items-center justify-center">
            <ScoreGauge score={currentScore} />
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
              <span className="text-amber-400 font-mono">
                ${costUsd.toFixed(4)}
              </span>
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
        </div>
      </div>
    </div>
  )
}

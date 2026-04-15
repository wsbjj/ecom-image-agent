import { useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../store/task.store'
import { TaskTable } from '../components/TaskTable'
import type { TaskRecord } from '../../shared/types'

export function Dashboard() {
  const { tasks, isLoading, filter, fetchTasks, setFilter } = useTaskStore()
  const navigate = useNavigate()

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const filteredTasks = useMemo(() => {
    if (filter === 'all') return tasks
    return tasks.filter((t) => t.status === filter)
  }, [tasks, filter])

  const stats = useMemo(() => {
    const total = tasks.length
    const success = tasks.filter((t) => t.status === 'success').length
    const failed = tasks.filter((t) => t.status === 'failed').length
    const running = tasks.filter((t) => t.status === 'running').length
    const totalCost = tasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0)
    return { total, success, failed, running, totalCost }
  }, [tasks])

  const handleSelect = useCallback(
    (task: TaskRecord) => {
      navigate(`/gallery?task=${task.task_id}`)
    },
    [navigate],
  )

  const filterOptions = [
    { value: 'all' as const, label: '全部' },
    { value: 'running' as const, label: '运行中' },
    { value: 'success' as const, label: '成功' },
    { value: 'failed' as const, label: '失败' },
    { value: 'pending' as const, label: '待处理' },
  ]

  return (
    <div className="flex-1 p-6 space-y-6 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-100">仪表盘</h1>
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/task-run')}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
          >
            新建任务
          </button>
          <button
            onClick={() => fetchTasks()}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
          >
            刷新
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: '总任务', value: stats.total, color: 'text-gray-100' },
          { label: '运行中', value: stats.running, color: 'text-blue-400' },
          { label: '成功', value: stats.success, color: 'text-emerald-400' },
          { label: '失败', value: stats.failed, color: 'text-red-400' },
          {
            label: '总费用',
            value: `$${stats.totalCost.toFixed(2)}`,
            color: 'text-amber-400',
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4"
          >
            <div className="text-xs text-gray-500 mb-1">{stat.label}</div>
            <div className={`text-xl font-bold ${stat.color}`}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex gap-2">
        {filterOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              filter === opt.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Task table */}
      <div className="bg-gray-800/30 border border-gray-700/50 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            加载中...
          </div>
        ) : (
          <TaskTable tasks={filteredTasks} onSelect={handleSelect} />
        )}
      </div>
    </div>
  )
}

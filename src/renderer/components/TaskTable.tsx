import type { TaskRecord } from '../../shared/types'

interface TaskTableProps {
  tasks: TaskRecord[]
  onSelect?: (task: TaskRecord) => void
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusBadge(status: TaskRecord['status']): JSX.Element {
  const styles: Record<TaskRecord['status'], string> = {
    pending: 'bg-gray-500/20 text-gray-400',
    running: 'bg-blue-500/20 text-blue-400',
    success: 'bg-emerald-500/20 text-emerald-400',
    failed: 'bg-red-500/20 text-red-400',
  }
  const labels: Record<TaskRecord['status'], string> = {
    pending: '待处理',
    running: '运行中',
    success: '成功',
    failed: '失败',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

export function TaskTable({ tasks, onSelect }: TaskTableProps): JSX.Element {
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        暂无任务记录
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700/50 text-gray-400">
            <th className="text-left py-3 px-4 font-medium">商品</th>
            <th className="text-left py-3 px-4 font-medium">SKU</th>
            <th className="text-center py-3 px-4 font-medium">评分</th>
            <th className="text-center py-3 px-4 font-medium">重试</th>
            <th className="text-center py-3 px-4 font-medium">状态</th>
            <th className="text-right py-3 px-4 font-medium">费用</th>
            <th className="text-right py-3 px-4 font-medium">时间</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.task_id}
              className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors"
              onClick={() => onSelect?.(task)}
            >
              <td className="py-3 px-4 text-gray-200">{task.product_name}</td>
              <td className="py-3 px-4 text-gray-400 font-mono text-xs">
                {task.sku_id}
              </td>
              <td className="py-3 px-4 text-center">
                {task.total_score !== null ? (
                  <span
                    className={`font-mono font-medium ${
                      task.total_score >= 85
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {task.total_score}
                  </span>
                ) : (
                  <span className="text-gray-600">--</span>
                )}
              </td>
              <td className="py-3 px-4 text-center text-gray-400">
                {task.retry_count}
              </td>
              <td className="py-3 px-4 text-center">{statusBadge(task.status)}</td>
              <td className="py-3 px-4 text-right text-gray-400 font-mono text-xs">
                {task.cost_usd !== null ? `$${task.cost_usd.toFixed(4)}` : '--'}
              </td>
              <td className="py-3 px-4 text-right text-gray-500 text-xs">
                {formatDate(task.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

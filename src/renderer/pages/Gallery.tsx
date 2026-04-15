import { useEffect, useMemo } from 'react'
import { useTaskStore } from '../store/task.store'
import { ImageCard } from '../components/ImageCard'

export function Gallery(): JSX.Element {
  const { tasks, isLoading, fetchTasks } = useTaskStore()

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const tasksWithImages = useMemo(
    () => tasks.filter((t) => t.image_path !== null),
    [tasks],
  )

  const successTasks = useMemo(
    () => tasksWithImages.filter((t) => t.status === 'success'),
    [tasksWithImages],
  )

  const failedTasks = useMemo(
    () => tasksWithImages.filter((t) => t.status === 'failed'),
    [tasksWithImages],
  )

  return (
    <div className="flex-1 p-6 space-y-6 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-100">图片画廊</h1>
        <button
          onClick={() => fetchTasks()}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
        >
          刷新
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          加载中...
        </div>
      ) : tasksWithImages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-500">
          <div className="text-5xl mb-4">🖼️</div>
          <div>还没有生成的图片</div>
          <div className="text-sm mt-1">前往「任务执行」页面开始生成</div>
        </div>
      ) : (
        <>
          {successTasks.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-emerald-400">
                ✅ 已发布 ({successTasks.length})
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {successTasks.map((task) => (
                  <ImageCard key={task.task_id} task={task} />
                ))}
              </div>
            </section>
          )}

          {failedTasks.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold text-red-400">
                ❌ 失败 ({failedTasks.length})
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {failedTasks.map((task) => (
                  <ImageCard key={task.task_id} task={task} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

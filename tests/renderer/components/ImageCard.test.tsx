import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ImageCard } from '../../../src/renderer/components/ImageCard'
import type { TaskRecord } from '../../../src/shared/types'

const baseTask: TaskRecord = {
  id: 1,
  task_id: 'test-task-001',
  sku_id: 'SKU001',
  product_name: '北欧陶瓷杯',
  retry_count: 2,
  total_score: 88,
  defect_analysis: JSON.stringify({
    edge_distortion: { score: 28, issues: ['轻微模糊'] },
    perspective_lighting: { score: 30, issues: [] },
    hallucination: { score: 30, issues: [] },
    overall_recommendation: '基本合格',
  }),
  status: 'success',
  image_path: null,
  prompt_used: null,
  cost_usd: 0.0532,
  created_at: '2026-04-14T10:00:00.000Z',
  updated_at: '2026-04-14T10:05:00.000Z',
}

describe('ImageCard', () => {
  it('should render product name', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('北欧陶瓷杯')).toBeInTheDocument()
  })

  it('should render SKU', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('SKU: SKU001')).toBeInTheDocument()
  })

  it('should render score with progress bar', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('88')).toBeInTheDocument()
    const progressBar = screen.getByRole('progressbar')
    expect(progressBar).toHaveAttribute('aria-valuenow', '88')
  })

  it('should render cost', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('费用: $0.0532')).toBeInTheDocument()
  })

  it('should render status badge', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('已发布')).toBeInTheDocument()
  })

  it('should render failed status correctly', () => {
    const failedTask = { ...baseTask, status: 'failed' as const, total_score: 60 }
    render(<ImageCard task={failedTask} />)
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('should handle missing defect analysis', () => {
    const taskNoDefect = { ...baseTask, defect_analysis: null }
    render(<ImageCard task={taskNoDefect} />)
    expect(screen.getByText('北欧陶瓷杯')).toBeInTheDocument()
  })

  it('should show placeholder when no image', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('暂无图片')).toBeInTheDocument()
  })

  it('should parse and display first defect issue', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('边缘: 轻微模糊')).toBeInTheDocument()
  })
})

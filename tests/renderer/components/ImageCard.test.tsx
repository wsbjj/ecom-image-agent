import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ImageCard } from '../../../src/renderer/components/ImageCard'
import type { TaskRecord } from '../../../src/shared/types'

const baseTask: TaskRecord = {
  id: 1,
  task_id: 'test-task-001',
  sku_id: 'SKU001',
  product_name: 'Test Product',
  retry_count: 2,
  total_score: 88,
  defect_analysis: JSON.stringify({
    dimensions: [
      {
        key: 'edge_distortion',
        name: 'Edge Distortion',
        score: 28,
        maxScore: 30,
        issues: ['slight blur'],
      },
      {
        key: 'perspective_lighting',
        name: 'Perspective & Lighting',
        score: 30,
        maxScore: 30,
        issues: [],
      },
    ],
    overall_recommendation: 'looks good',
  }),
  status: 'success',
  image_path: null,
  prompt_used: null,
  cost_usd: 0.0532,
  product_images: null,
  reference_images: null,
  created_at: '2026-04-14T10:00:00.000Z',
  updated_at: '2026-04-14T10:05:00.000Z',
}

describe('ImageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders product, SKU, score, and cost', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('Test Product')).toBeInTheDocument()
    expect(screen.getByText('SKU: SKU001')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '88')
    expect(screen.getByText(/\$0\.0532/)).toBeInTheDocument()
  })

  it('renders without crashing for success/failed statuses', () => {
    const { rerender } = render(<ImageCard task={baseTask} />)
    expect(screen.getByText('Test Product')).toBeInTheDocument()

    rerender(<ImageCard task={{ ...baseTask, status: 'failed', total_score: 60 }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60')
  })

  it('shows placeholder when no image path', () => {
    render(<ImageCard task={baseTask} />)
    expect(screen.getByText('暂无图片')).toBeInTheDocument()
  })

  it('renders DataURL preview when image data is available', async () => {
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({
      dataUrl: 'data:image/mock;base64,preview',
    })
    const taskWithImage = {
      ...baseTask,
      image_path: 'C:\\Users\\test\\Desktop\\product-1.png',
    }

    render(<ImageCard task={taskWithImage} />)

    await waitFor(() => {
      expect(screen.getByAltText('Test Product')).toBeInTheDocument()
    })
    const image = screen.getByAltText('Test Product') as HTMLImageElement
    expect(image.src).toContain('data:image/mock;base64,preview')
    expect(image.src).not.toContain('file://')
  })

  it('keeps placeholder when image data is unavailable', async () => {
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({ dataUrl: null })
    const taskWithImage = {
      ...baseTask,
      image_path: 'C:\\Users\\test\\Desktop\\missing.png',
    }

    render(<ImageCard task={taskWithImage} />)

    await waitFor(() => {
      expect(screen.getByText('暂无图片')).toBeInTheDocument()
    })
    expect(screen.queryByAltText('Test Product')).not.toBeInTheDocument()
  })
})

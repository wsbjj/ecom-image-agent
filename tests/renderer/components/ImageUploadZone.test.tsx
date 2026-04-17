import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ImageUploadZone } from '../../../src/renderer/components/ImageUploadZone'
import type { ImageAsset } from '../../../src/shared/types'

describe('ImageUploadZone', () => {
  const value: ImageAsset[] = [{ path: 'C:/images/product-1.jpg', isPrimary: true }]

  it('shows placeholder instead of file:// fallback when DataURL is unavailable', async () => {
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({ dataUrl: null })

    render(
      <ImageUploadZone
        label="商品图"
        required
        maxFiles={8}
        value={value}
        onChange={vi.fn()}
        showAngleTag
      />,
    )

    await screen.findByTestId('image-upload-placeholder-0')
    expect(screen.queryByAltText('商品图 1')).not.toBeInTheDocument()
  })

  it('renders image from DataURL when available', async () => {
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({
      dataUrl: 'data:image/mock;base64,upload-preview',
    })

    render(
      <ImageUploadZone
        label="商品图"
        required
        maxFiles={8}
        value={value}
        onChange={vi.fn()}
        showAngleTag
      />,
    )

    await waitFor(() => {
      expect(screen.getByAltText('商品图 1')).toBeInTheDocument()
    })
    const image = screen.getByAltText('商品图 1') as HTMLImageElement
    expect(image.src).toContain('data:image/mock;base64,upload-preview')
    expect(image.src).not.toContain('file://')
  })
})

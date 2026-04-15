import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../../src/renderer/pages/Settings'
import { useConfigStore } from '../../../src/renderer/store/config.store'

describe('Settings', () => {
  beforeEach(() => {
    useConfigStore.setState({
      hasAnthropicKey: false,
      hasGoogleKey: false,
      hasSeedreamKey: false,
      activeProvider: 'gemini',
      isChecking: false,
    })

    vi.mocked(window.api.checkConfig).mockResolvedValue({ exists: false })
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') {
        return { value: 'sk-ant-test-123456' }
      }

      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }

      return { value: null }
    })
  })

  it('shows saved anthropic key after loading existing config', async () => {
    render(<Settings />)

    expect(await screen.findByDisplayValue('sk-ant-test-123456')).toBeInTheDocument()
  })

  it('shows saved seedream base url when using custom config', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'seedream' }
      }

      if (key === 'SEEDREAM_BASE_URL') {
        return { value: 'https://example-ark-proxy/v3' }
      }

      if (key === 'SEEDREAM_ENDPOINT_ID') {
        return { value: 'doubao-seedream-3-0-t2i-custom' }
      }

      return { value: null }
    })

    render(<Settings />)

    expect(await screen.findByDisplayValue('https://example-ark-proxy/v3')).toBeInTheDocument()
  })

  it('can test anthropic connection from settings page', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') {
        return { value: 'sk-ant-test-123456' }
      }
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      return { value: null }
    })
    vi.mocked(window.api.testAnthropicConnection).mockResolvedValue({
      success: true,
      message: 'ok',
    })

    render(<Settings />)
    const user = userEvent.setup()
    await screen.findByDisplayValue('sk-ant-test-123456')
    await user.click(await screen.findByRole('button', { name: '测试连接' }))

    expect(window.api.testAnthropicConnection).toHaveBeenCalled()
    expect((await screen.findAllByText(/Anthropic 连接测试成功/)).length).toBeGreaterThan(0)
  })
})

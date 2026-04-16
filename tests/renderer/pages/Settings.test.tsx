import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
    const testButtons = await screen.findAllByRole('button', { name: '测试连接' })
    await user.click(testButtons[1])

    expect(window.api.testAnthropicConnection).toHaveBeenCalled()
    expect((await screen.findAllByText(/Anthropic 连接测试成功/)).length).toBeGreaterThan(0)
  })

  it('can test codex connection from settings page', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') {
        return { value: 'sk-ant-test-123456' }
      }
      if (key === 'CODEX_API_KEY') {
        return { value: 'codex-key-test-123456' }
      }
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      return { value: null }
    })
    vi.mocked(window.api.testCodexConnection).mockResolvedValue({
      success: true,
      message: 'ok',
    })

    render(<Settings />)
    const user = userEvent.setup()
    await screen.findByDisplayValue('codex-key-test-123456')
    const codexCard = screen.getByText('Codex API 密钥').closest('div[class*="bg-gray-800"]')
    expect(codexCard).toBeTruthy()
    const codexTestButton = within(codexCard as HTMLElement).getByRole('button', { name: '测试连接' })
    await user.click(codexTestButton)

    expect(window.api.testCodexConnection).toHaveBeenCalled()
    expect((await screen.findAllByText(/Codex 连接测试成功/)).length).toBeGreaterThan(0)
  })

  it('can test image provider connection from settings page', async () => {
    vi.mocked(window.api.testImageProviderConnection).mockResolvedValue({
      success: true,
      message: 'Google Gemini 图像测试成功（模型: gemini-2.0-flash-preview-image-generation）',
      durationMs: 120,
    })

    render(<Settings />)
    const user = userEvent.setup()
    const testButtons = await screen.findAllByRole('button', { name: '测试连接' })
    await user.click(testButtons[0])

    expect(window.api.testImageProviderConnection).toHaveBeenCalled()
    expect((await screen.findAllByText(/Google Gemini 图像测试成功/)).length).toBeGreaterThan(0)
  })
})

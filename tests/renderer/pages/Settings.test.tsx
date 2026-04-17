import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../../src/renderer/pages/Settings'
import { useConfigStore } from '../../../src/renderer/store/config.store'

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState({
      hasAnthropicKey: false,
      hasGoogleKey: false,
      hasSeedreamKey: false,
      activeProvider: 'gemini',
      isChecking: false,
    })

    vi.mocked(window.api.saveConfig).mockResolvedValue({ success: true })
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

  it('can fetch anthropic model list from base url and choose a model from dropdown', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') {
        return { value: 'sk-ant-test-123456' }
      }
      if (key === 'ANTHROPIC_BASE_URL') {
        return { value: 'https://proxy.example.com' }
      }
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      return { value: null }
    })
    vi.mocked(window.api.fetchAnthropicModels).mockResolvedValue({
      success: true,
      message: '已获取 2 个可用模型',
      models: [
        { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' },
        { id: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' },
      ],
    })

    render(<Settings />)

    const user = userEvent.setup()
    expect(await screen.findByDisplayValue('https://proxy.example.com')).toBeInTheDocument()

    await user.click(screen.getByTestId('settings-anthropic-fetch-models-button'))

    expect(window.api.fetchAnthropicModels).toHaveBeenCalledWith({
      apiKey: 'sk-ant-test-123456',
      baseUrl: 'https://proxy.example.com',
    })

    const modelSelect = await screen.findByTestId('settings-anthropic-model-select')
    await user.selectOptions(modelSelect, 'claude-opus-4-20250514')

    expect(await screen.findByDisplayValue('claude-opus-4-20250514')).toBeInTheDocument()
    expect((await screen.findAllByText(/已获取 2 个可用模型/)).length).toBeGreaterThan(0)
  })

  it('loads saved vlmevalkit evaluation settings', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      if (key === 'JUDGE_API_KEY') {
        return { value: 'judge-key-123' }
      }
      if (key === 'JUDGE_BASE_URL') {
        return { value: 'https://judge.example.com' }
      }
      if (key === 'JUDGE_MODEL') {
        return { value: 'glm-5' }
      }
      if (key === 'EVAL_BACKEND') {
        return { value: 'vlmevalkit' }
      }
      if (key === 'VLMEVAL_MODEL_ID') {
        return { value: 'qwen2.5-vl-72b-instruct' }
      }
      if (key === 'VLMEVAL_USE_CUSTOM_MODEL') {
        return { value: 'false' }
      }
      return { value: null }
    })

    render(<Settings />)

    expect(await screen.findByTestId('settings-eval-backend-select')).toHaveValue('vlmevalkit')
    expect(await screen.findByTestId('settings-judge-api-key-input')).toHaveValue('judge-key-123')
    expect(await screen.findByTestId('settings-judge-base-url-input')).toHaveValue(
      'https://judge.example.com',
    )
    expect(await screen.findByTestId('settings-judge-model-input')).toHaveValue('glm-5')
    expect(await screen.findByTestId('settings-vlmeval-model-id-input')).toHaveValue(
      'qwen2.5-vl-72b-instruct',
    )
    expect(
      await screen.findByTestId('settings-vlmeval-use-custom-model-checkbox'),
    ).not.toBeChecked()
  })

  it('saves vlmevalkit evaluation settings', async () => {
    render(<Settings />)

    const user = userEvent.setup()
    const judgeApiKeyInput = await screen.findByTestId('settings-judge-api-key-input')
    await user.clear(judgeApiKeyInput)
    await user.type(judgeApiKeyInput, 'judge-key-123')
    const judgeBaseUrlInput = screen.getByTestId('settings-judge-base-url-input')
    await user.clear(judgeBaseUrlInput)
    await user.type(judgeBaseUrlInput, 'https://judge.example.com')
    const judgeModelInput = screen.getByTestId('settings-judge-model-input')
    await user.clear(judgeModelInput)
    await user.type(judgeModelInput, 'glm-5')
    await user.click(screen.getByRole('button', { name: '保存 Judge 配置' }))
    const backendSelect = await screen.findByTestId('settings-eval-backend-select')
    await user.selectOptions(backendSelect, 'vlmevalkit')
    await user.click(screen.getByRole('button', { name: '保存后端' }))

    const modelInput = await screen.findByTestId('settings-vlmeval-model-id-input')
    await user.clear(modelInput)
    await user.type(modelInput, 'qwen2.5-vl-72b-instruct')

    const customModelCheckbox = await screen.findByTestId(
      'settings-vlmeval-use-custom-model-checkbox',
    )
    await user.click(customModelCheckbox)
    await user.click(screen.getByRole('button', { name: '保存 VLMEvalKit 配置' }))

    expect(window.api.saveConfig).toHaveBeenCalledWith('JUDGE_API_KEY', 'judge-key-123')
    expect(window.api.saveConfig).toHaveBeenCalledWith('JUDGE_BASE_URL', 'https://judge.example.com')
    expect(window.api.saveConfig).toHaveBeenCalledWith('JUDGE_MODEL', 'glm-5')
    expect(window.api.saveConfig).toHaveBeenCalledWith('EVAL_BACKEND', 'vlmevalkit')
    expect(window.api.saveConfig).toHaveBeenCalledWith(
      'VLMEVAL_MODEL_ID',
      'qwen2.5-vl-72b-instruct',
    )
    expect(window.api.saveConfig).toHaveBeenCalledWith('VLMEVAL_USE_CUSTOM_MODEL', 'false')
  })

  it('can fetch judge model list and choose a model from dropdown', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      return { value: null }
    })
    vi.mocked(window.api.fetchJudgeModels).mockResolvedValue({
      success: true,
      message: '已获取 2 个可用 Judge 模型',
      models: [
        { id: 'glm-5', displayName: 'GLM 5' },
        { id: 'glm-4.5v', displayName: 'GLM 4.5V' },
      ],
    })

    render(<Settings />)
    const user = userEvent.setup()

    await user.type(await screen.findByTestId('settings-judge-api-key-input'), 'judge-key')
    await user.type(screen.getByTestId('settings-judge-base-url-input'), 'https://judge.example.com')
    await user.click(screen.getByTestId('settings-judge-fetch-models-button'))

    expect(window.api.fetchJudgeModels).toHaveBeenCalledWith({
      apiKey: 'judge-key',
      baseUrl: 'https://judge.example.com',
    })

    const modelSelect = await screen.findByTestId('settings-judge-model-select')
    await user.selectOptions(modelSelect, 'glm-4.5v')
    expect(await screen.findByDisplayValue('glm-4.5v')).toBeInTheDocument()
  })

  it('shows warning when claude_sdk uses a likely non-claude agent model', async () => {
    vi.mocked(window.api.getConfigValue).mockImplementation(async (key: string) => {
      if (key === 'IMAGE_PROVIDER') {
        return { value: 'gemini' }
      }
      if (key === 'AGENT_ENGINE') {
        return { value: 'claude_sdk' }
      }
      if (key === 'ANTHROPIC_MODEL') {
        return { value: 'glm-5' }
      }
      return { value: null }
    })

    render(<Settings />)

    expect(
      await screen.findByText(/当前 `AGENT_ENGINE=claude_sdk`，但 Agent 模型看起来不是 Claude 系列/),
    ).toBeInTheDocument()
  })
})

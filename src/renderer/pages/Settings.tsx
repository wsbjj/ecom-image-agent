import { useEffect, useState, useCallback } from 'react'
import { useConfigStore } from '../store/config.store'
import type { ImageProviderName } from '../../shared/types'

export function Settings(): JSX.Element {
  const {
    hasAnthropicKey,
    hasGoogleKey,
    hasSeedreamKey,
    activeProvider,
    isChecking,
    checkKeys,
    saveKey,
    setActiveProvider,
  } = useConfigStore()

  const [anthropicInput, setAnthropicInput] = useState('')
  const [googleInput, setGoogleInput] = useState('')
  const [seedreamInput, setSeedreamInput] = useState('')
  const [seedreamEndpointId, setSeedreamEndpointId] = useState('')
  const [seedreamBaseUrl, setSeedreamBaseUrl] = useState('')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('')
  const [anthropicModel, setAnthropicModel] = useState('')
  const [googleBaseUrl, setGoogleBaseUrl] = useState('')
  const [googleImageModel, setGoogleImageModel] = useState('')
  const [anthropicCustomEnabled, setAnthropicCustomEnabled] = useState(false)
  const [googleCustomEnabled, setGoogleCustomEnabled] = useState(false)
  const [seedreamCustomEnabled, setSeedreamCustomEnabled] = useState(false)
  const [userDataPath, setUserDataPath] = useState<string>('%APPDATA%/ecom-image-agent')
  const [saving, setSaving] = useState(false)
  const [testingAnthropic, setTestingAnthropic] = useState(false)
  const [anthropicTestMessage, setAnthropicTestMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [message, setMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)

  const loadSavedConfigs = useCallback(async () => {
    try {
      const [
        anthropicKeyResult,
        googleKeyResult,
        seedreamKeyResult,
        seedreamEndpointResult,
        seedreamBaseUrlResult,
        anthropicBaseUrlResult,
        anthropicModelResult,
        googleBaseUrlResult,
        googleImageModelResult,
      ] = await Promise.all([
        window.api.getConfigValue('ANTHROPIC_API_KEY'),
        window.api.getConfigValue('GOOGLE_API_KEY'),
        window.api.getConfigValue('APIKEY_SEEDREAM'),
        window.api.getConfigValue('SEEDREAM_ENDPOINT_ID'),
        window.api.getConfigValue('SEEDREAM_BASE_URL'),
        window.api.getConfigValue('ANTHROPIC_BASE_URL'),
        window.api.getConfigValue('ANTHROPIC_MODEL'),
        window.api.getConfigValue('GOOGLE_BASE_URL'),
        window.api.getConfigValue('GOOGLE_IMAGE_MODEL'),
      ])

      const nextAnthropicKey = anthropicKeyResult.value ?? ''
      const nextGoogleKey = googleKeyResult.value ?? ''
      const nextSeedreamKey = seedreamKeyResult.value ?? ''
      const nextSeedreamEndpointId = seedreamEndpointResult.value ?? ''
      const nextSeedreamBaseUrl = seedreamBaseUrlResult.value ?? ''
      const nextAnthropicBaseUrl = anthropicBaseUrlResult.value ?? ''
      const nextAnthropicModel = anthropicModelResult.value ?? ''
      const nextGoogleBaseUrl = googleBaseUrlResult.value ?? ''
      const nextGoogleImageModel = googleImageModelResult.value ?? ''

      setAnthropicInput(nextAnthropicKey)
      setGoogleInput(nextGoogleKey)
      setSeedreamInput(nextSeedreamKey)
      setSeedreamEndpointId(nextSeedreamEndpointId)
      setSeedreamBaseUrl(nextSeedreamBaseUrl)
      setAnthropicBaseUrl(nextAnthropicBaseUrl)
      setAnthropicModel(nextAnthropicModel)
      setGoogleBaseUrl(nextGoogleBaseUrl)
      setGoogleImageModel(nextGoogleImageModel)
      setAnthropicCustomEnabled(Boolean(nextAnthropicBaseUrl || nextAnthropicModel))
      setGoogleCustomEnabled(Boolean(nextGoogleBaseUrl || nextGoogleImageModel))
      setSeedreamCustomEnabled(Boolean(nextSeedreamBaseUrl || nextSeedreamEndpointId))
    } catch (error) {
      console.error('[Settings] loadSavedConfigs failed:', error)
    }
  }, [])

  useEffect(() => {
    void checkKeys()
    void loadSavedConfigs()
  }, [checkKeys, loadSavedConfigs])

  useEffect(() => {
    window.api
      .getUserDataPath()
      .then((result) => {
        setUserDataPath(result.path)
      })
      .catch((error) => {
        console.error('[Settings] getUserDataPath failed:', error)
      })
  }, [])

  const handleSave = useCallback(
    async (key: string, value: string, label: string) => {
      const trimmedValue = value.trim()
      if (!trimmedValue) return
      setSaving(true)
      setMessage(null)
      const ok = await saveKey(key, trimmedValue)
      setSaving(false)
      if (ok) {
        setMessage({ type: 'success', text: `${label} 已保存` })
        if (key === 'ANTHROPIC_API_KEY') setAnthropicInput(trimmedValue)
        if (key === 'GOOGLE_API_KEY') setGoogleInput(trimmedValue)
        if (key === 'APIKEY_SEEDREAM') setSeedreamInput(trimmedValue)
      } else {
        setMessage({ type: 'error', text: `${label} 保存失败` })
      }
    },
    [saveKey],
  )

  const handleSaveCustom = useCallback(
    async (
      values: Array<{ key: string; value: string }>,
      label: string,
      onSuccess?: () => void,
    ) => {
      setSaving(true)
      setMessage(null)
      try {
        const results = await Promise.all(
          values.map(({ key, value }) => saveKey(key, value.trim())),
        )
        const ok = results.every(Boolean)
        if (ok) {
          setMessage({ type: 'success', text: `${label} 已保存` })
          onSuccess?.()
        } else {
          setMessage({ type: 'error', text: `${label} 保存失败` })
        }
      } finally {
        setSaving(false)
      }
    },
    [saveKey],
  )

  const handleProviderChange = useCallback(
    async (provider: ImageProviderName) => {
      setSaving(true)
      setMessage(null)
      const ok = await setActiveProvider(provider)
      setSaving(false)
      if (ok) {
        setMessage({ type: 'success', text: `已切换到 ${provider === 'gemini' ? 'Google Gemini' : '即梦 Seedream'}` })
      } else {
        setMessage({ type: 'error', text: '切换服务商失败' })
      }
    },
    [setActiveProvider],
  )

  const providerKeyStatus = (provider: ImageProviderName): boolean => {
    if (provider === 'gemini') return hasGoogleKey
    if (provider === 'seedream') return hasSeedreamKey
    return false
  }

  const handleTestAnthropicConnection = useCallback(async () => {
    if (!anthropicInput.trim()) {
      const nextMessage = { type: 'error' as const, text: '请先输入 Anthropic API Key 再测试连接' }
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
      return
    }

    setTestingAnthropic(true)
    setAnthropicTestMessage(null)
    setMessage(null)
    try {
      const result = await window.api.testAnthropicConnection({
        apiKey: anthropicInput,
        baseUrl: anthropicBaseUrl,
        model: anthropicModel,
      })
      const nextMessage = {
        type: result.success ? 'success' : 'error',
        text: result.success
          ? `Anthropic 连接测试成功（模型: ${anthropicModel.trim() || 'claude-sonnet-4-20250514'}）`
          : `Anthropic 连接测试失败：${result.message}`,
      } as const
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const nextMessage = { type: 'error' as const, text: `Anthropic 连接测试失败：${text}` }
      setAnthropicTestMessage(nextMessage)
      setMessage(nextMessage)
    } finally {
      setTestingAnthropic(false)
    }
  }, [anthropicInput, anthropicBaseUrl, anthropicModel])

  return (
    <div className="flex-1 p-6 space-y-8 overflow-y-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-100">设置</h1>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
              : 'bg-red-500/10 text-red-400 border border-red-500/30'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Image Provider Selection */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">图像生成服务</h2>
        <p className="text-sm text-gray-400">
          选择用于生成电商精品图的 AI 服务商。切换后新任务将使用所选服务商。
        </p>

        <div className="space-y-3">
          {/* Gemini */}
          <div
            className={`bg-gray-800/50 border rounded-xl p-4 space-y-3 cursor-pointer transition-colors ${
              activeProvider === 'gemini'
                ? 'border-blue-500/50'
                : 'border-gray-700/50 hover:border-gray-600/50'
            }`}
            onClick={() => handleProviderChange('gemini')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  activeProvider === 'gemini' ? 'border-blue-500' : 'border-gray-600'
                }`}>
                  {activeProvider === 'gemini' && (
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200">Google Gemini</h3>
                  <p className="text-xs text-gray-500 mt-0.5">gemini-2.0-flash-preview-image-generation</p>
                </div>
              </div>
              {isChecking ? (
                <span className="text-xs text-gray-500">检查中...</span>
              ) : hasGoogleKey ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                  已配置
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                  未配置
                </span>
              )}
            </div>

            {activeProvider === 'gemini' && (
              <div className="space-y-3 pt-2 border-t border-gray-700/50" onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={googleInput}
                    onChange={(e) => setGoogleInput(e.target.value)}
                    placeholder="AIza..."
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <button
                    onClick={() => handleSave('GOOGLE_API_KEY', googleInput, 'Google Key')}
                    disabled={!googleInput.trim() || saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存
                  </button>
                </div>

                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={googleCustomEnabled}
                    onChange={(e) => setGoogleCustomEnabled(e.target.checked)}
                  />
                  自定义配置
                </label>

                {googleCustomEnabled && (
                  <>
                    <input
                      value={googleBaseUrl}
                      onChange={(e) => setGoogleBaseUrl(e.target.value)}
                      placeholder="自定义 Base URL（可留空回退官方）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <input
                      value={googleImageModel}
                      onChange={(e) => setGoogleImageModel(e.target.value)}
                      placeholder="图像模型（如 gemini-2.0-flash-preview-image-generation）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <div className="flex justify-end">
                      <button
                        onClick={() =>
                          handleSaveCustom(
                            [
                              { key: 'GOOGLE_BASE_URL', value: googleBaseUrl },
                              { key: 'GOOGLE_IMAGE_MODEL', value: googleImageModel },
                            ],
                            'Google 自定义配置',
                          )
                        }
                        disabled={saving}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                      >
                        保存自定义配置
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Seedream */}
          <div
            className={`bg-gray-800/50 border rounded-xl p-4 space-y-3 cursor-pointer transition-colors ${
              activeProvider === 'seedream'
                ? 'border-blue-500/50'
                : 'border-gray-700/50 hover:border-gray-600/50'
            }`}
            onClick={() => handleProviderChange('seedream')}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  activeProvider === 'seedream' ? 'border-blue-500' : 'border-gray-600'
                }`}>
                  {activeProvider === 'seedream' && (
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200">字节即梦 Seedream 3.0</h3>
                  <p className="text-xs text-gray-500 mt-0.5">火山方舟 doubao-seedream-3-0-t2i</p>
                </div>
              </div>
              {isChecking ? (
                <span className="text-xs text-gray-500">检查中...</span>
              ) : hasSeedreamKey ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                  已配置
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                  未配置
                </span>
              )}
            </div>

            {activeProvider === 'seedream' && (
              <div className="space-y-3 pt-2 border-t border-gray-700/50" onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={seedreamInput}
                    onChange={(e) => setSeedreamInput(e.target.value)}
                    placeholder="火山方舟 API Key"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <button
                    onClick={() => handleSave('APIKEY_SEEDREAM', seedreamInput, 'Seedream Key')}
                    disabled={!seedreamInput.trim() || saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={seedreamCustomEnabled}
                    onChange={(e) => setSeedreamCustomEnabled(e.target.checked)}
                  />
                  使用自定义 Seedream API 配置
                </label>

                {seedreamCustomEnabled && (
                  <>
                    <input
                      value={seedreamBaseUrl}
                      onChange={(e) => setSeedreamBaseUrl(e.target.value)}
                      placeholder="自定义 Base URL（可留空回退官方）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <input
                      value={seedreamEndpointId}
                      onChange={(e) => setSeedreamEndpointId(e.target.value)}
                      placeholder="模型 Endpoint ID（可选，留空使用默认）"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                    />
                  </>
                )}

                {(seedreamEndpointId.trim() || seedreamBaseUrl.trim()) && (
                  <div className="flex justify-end">
                    <button
                      onClick={() =>
                        handleSaveCustom(
                          [
                            { key: 'SEEDREAM_BASE_URL', value: seedreamBaseUrl },
                            { key: 'SEEDREAM_ENDPOINT_ID', value: seedreamEndpointId },
                          ],
                          'Seedream 自定义配置',
                        )
                      }
                      disabled={saving}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                    >
                      保存自定义配置
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {!providerKeyStatus(activeProvider) && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            当前选择的服务商尚未配置 API Key，请在上方输入并保存。
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">API 密钥</h2>
        <p className="text-sm text-gray-400">
          密钥通过 Electron safeStorage 加密存储在本地数据库中，不会写入任何文件。
        </p>

        {/* Anthropic */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200">
                Anthropic API Key
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                用于 Claude Agent SDK 和 VLMEvalKit judge 模型
              </p>
            </div>
            {isChecking ? (
              <span className="text-xs text-gray-500">检查中...</span>
            ) : hasAnthropicKey ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                已配置
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                未配置
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={anthropicInput}
              onChange={(e) => setAnthropicInput(e.target.value)}
              placeholder="sk-ant-..."
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={() =>
                handleSave('ANTHROPIC_API_KEY', anthropicInput, 'Anthropic Key')
              }
              disabled={!anthropicInput.trim() || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
            <button
              onClick={handleTestAnthropicConnection}
              disabled={testingAnthropic || saving}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              {testingAnthropic ? '测试中...' : '测试连接'}
            </button>
          </div>
          {anthropicTestMessage && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                anthropicTestMessage.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-red-500/10 text-red-400 border border-red-500/30'
              }`}
            >
              {anthropicTestMessage.text}
            </div>
          )}

          <div className="pt-2 border-t border-gray-700/50 space-y-3">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={anthropicCustomEnabled}
                onChange={(e) => setAnthropicCustomEnabled(e.target.checked)}
              />
              使用自定义 Anthropic API 配置
            </label>

            {anthropicCustomEnabled && (
              <>
                <input
                  value={anthropicBaseUrl}
                  onChange={(e) => setAnthropicBaseUrl(e.target.value)}
                  placeholder="自定义 Base URL（可留空回退官方）"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                />
                <input
                  value={anthropicModel}
                  onChange={(e) => setAnthropicModel(e.target.value)}
                  placeholder="自定义模型（如 claude-sonnet-4-20250514）"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
                />
                <div className="flex justify-end">
                  <button
                    onClick={() =>
                      handleSaveCustom(
                        [
                          { key: 'ANTHROPIC_BASE_URL', value: anthropicBaseUrl },
                          { key: 'ANTHROPIC_MODEL', value: anthropicModel },
                        ],
                        'Anthropic 自定义配置',
                      )
                    }
                    disabled={saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
                  >
                    保存自定义配置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">关于</h2>
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 text-sm text-gray-400 space-y-1">
          <div>EcomAgent v1.0.0</div>
          <div>Electron + React 19 + Claude Agent SDK</div>
          <div>
            数据存储位置:{' '}
            <span className="font-mono text-gray-500">{userDataPath}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

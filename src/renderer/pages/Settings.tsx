import { useEffect, useState, useCallback } from 'react'
import { useConfigStore } from '../store/config.store'

export function Settings(): JSX.Element {
  const { hasAnthropicKey, hasGoogleKey, isChecking, checkKeys, saveKey } =
    useConfigStore()

  const [anthropicInput, setAnthropicInput] = useState('')
  const [googleInput, setGoogleInput] = useState('')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('')
  const [anthropicModel, setAnthropicModel] = useState('')
  const [googleBaseUrl, setGoogleBaseUrl] = useState('')
  const [googleImageModel, setGoogleImageModel] = useState('')
  const [anthropicCustomEnabled, setAnthropicCustomEnabled] = useState(false)
  const [googleCustomEnabled, setGoogleCustomEnabled] = useState(false)
  const [userDataPath, setUserDataPath] = useState<string>('%APPDATA%/ecom-image-agent')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)

  useEffect(() => {
    checkKeys()
  }, [checkKeys])

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
      if (!value.trim()) return
      setSaving(true)
      setMessage(null)
      const ok = await saveKey(key, value)
      setSaving(false)
      if (ok) {
        setMessage({ type: 'success', text: `${label} 已保存` })
        if (key === 'ANTHROPIC_API_KEY') setAnthropicInput('')
        if (key === 'GOOGLE_API_KEY') setGoogleInput('')
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
              type="password"
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
          </div>

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

        {/* Google */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200">
                Google API Key
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                用于 Gemini 图像生成 API
              </p>
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
          <div className="flex gap-2">
            <input
              type="password"
              value={googleInput}
              onChange={(e) => setGoogleInput(e.target.value)}
              placeholder="AIza..."
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none font-mono"
            />
            <button
              onClick={() =>
                handleSave('GOOGLE_API_KEY', googleInput, 'Google Key')
              }
              disabled={!googleInput.trim() || saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              保存
            </button>
          </div>

          <div className="pt-2 border-t border-gray-700/50 space-y-3">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={googleCustomEnabled}
                onChange={(e) => setGoogleCustomEnabled(e.target.checked)}
              />
              使用自定义 Google API 配置
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

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ImageProviderName } from '../../shared/types'

interface ConfigState {
  hasAnthropicKey: boolean
  hasGoogleKey: boolean
  hasSeedreamKey: boolean
  activeProvider: ImageProviderName
  isChecking: boolean
}

interface ConfigActions {
  checkKeys: () => Promise<void>
  saveKey: (key: string, value: string) => Promise<boolean>
  setActiveProvider: (provider: ImageProviderName) => Promise<boolean>
}

export const useConfigStore = create<ConfigState & ConfigActions>()(
  subscribeWithSelector((set) => ({
    hasAnthropicKey: false,
    hasGoogleKey: false,
    hasSeedreamKey: false,
    activeProvider: 'gemini',
    isChecking: false,

    checkKeys: async () => {
      set({ isChecking: true })
      try {
        const [anthropic, google, seedream, providerResult] = await Promise.all([
          window.api.checkConfig('ANTHROPIC_API_KEY'),
          window.api.checkConfig('GOOGLE_API_KEY'),
          window.api.checkConfig('APIKEY_SEEDREAM'),
          window.api.getConfigValue('IMAGE_PROVIDER'),
        ])
        const provider = (providerResult.value ?? 'gemini') as ImageProviderName
        set({
          hasAnthropicKey: anthropic.exists,
          hasGoogleKey: google.exists,
          hasSeedreamKey: seedream.exists,
          activeProvider: provider,
          isChecking: false,
        })
      } catch (err) {
        console.error('[ConfigStore] checkKeys failed:', err)
        set({ isChecking: false })
      }
    },

    saveKey: async (key: string, value: string): Promise<boolean> => {
      try {
        const result = await window.api.saveConfig(key, value)
        if (result.success) {
          if (key === 'ANTHROPIC_API_KEY') set({ hasAnthropicKey: true })
          if (key === 'GOOGLE_API_KEY') set({ hasGoogleKey: true })
          if (key === 'APIKEY_SEEDREAM') set({ hasSeedreamKey: true })
        }
        return result.success
      } catch (err) {
        console.error('[ConfigStore] saveKey failed:', err)
        return false
      }
    },

    setActiveProvider: async (provider: ImageProviderName): Promise<boolean> => {
      try {
        const result = await window.api.saveConfig('IMAGE_PROVIDER', provider)
        if (result.success) {
          set({ activeProvider: provider })
        }
        return result.success
      } catch (err) {
        console.error('[ConfigStore] setActiveProvider failed:', err)
        return false
      }
    },
  })),
)

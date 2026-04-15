import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

interface ConfigState {
  hasAnthropicKey: boolean
  hasGoogleKey: boolean
  isChecking: boolean
}

interface ConfigActions {
  checkKeys: () => Promise<void>
  saveKey: (key: string, value: string) => Promise<boolean>
}

export const useConfigStore = create<ConfigState & ConfigActions>()(
  subscribeWithSelector((set) => ({
    hasAnthropicKey: false,
    hasGoogleKey: false,
    isChecking: false,

    checkKeys: async () => {
      set({ isChecking: true })
      try {
        const [anthropic, google] = await Promise.all([
          window.api.checkConfig('ANTHROPIC_API_KEY'),
          window.api.checkConfig('GOOGLE_API_KEY'),
        ])
        set({
          hasAnthropicKey: anthropic.exists,
          hasGoogleKey: google.exists,
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
        }
        return result.success
      } catch (err) {
        console.error('[ConfigStore] saveKey failed:', err)
        return false
      }
    },
  })),
)

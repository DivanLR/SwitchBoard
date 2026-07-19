// Settings state (FR-021). The store owns the settings transport so components
// render state and call actions (view/transport separation).
import { defineStore } from 'pinia'
import type { Settings } from '@shared/domain'

interface SettingsState {
  settings: Settings | null
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    settings: null,
  }),

  actions: {
    async load(): Promise<void> {
      this.settings = await window.switchboard.invoke('settings.get', undefined)
    },

    async save(patch: Partial<Settings>): Promise<void> {
      this.settings = await window.switchboard.invoke('settings.set', patch)
    },
  },
})

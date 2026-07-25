// Settings state (FR-021). The store owns the settings transport so components
// render state and call actions (view/transport separation).
//
// Stores here are plain module singletons built on Vue's own reactive(): state,
// getters and actions on one object, which is all the app ever used a store
// library for. Components keep calling useXStore() and read/write the same way.
import { reactive } from 'vue'
import type { Settings } from '@shared/domain'

const store = reactive({
  settings: null as Settings | null,

  async load(): Promise<void> {
    this.settings = await window.switchboard.invoke('settings.get', undefined)
  },

  async save(patch: Partial<Settings>): Promise<void> {
    this.settings = await window.switchboard.invoke('settings.set', patch)
  },
})

export const useSettingsStore = (): typeof store => store

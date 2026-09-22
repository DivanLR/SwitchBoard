import { reactive } from 'vue'
import type { AvailableModel, Settings } from '@shared/domain'
import { invoke } from '@renderer/ipc'

let latest = 0

const store = reactive({
  settings: null as Settings | null,
  availableModels: [] as AvailableModel[],

  async load(): Promise<void> {
    latest += 1
    this.settings = await invoke('settings.get', undefined)
  },

  async loadAvailableModels(): Promise<void> {
    try {
      this.availableModels = await invoke('models.available', undefined)
    } catch {
    }
  },

  async save(patch: Partial<Settings>): Promise<void> {
    if (this.settings) this.settings = { ...this.settings, ...patch }
    const ticket = (latest += 1)
    const saved = await invoke('settings.set', patch)
    if (ticket === latest) this.settings = saved
  },

  toggleMcpActiveServer(name: string): void {
    const current = this.settings?.mcpActiveServers
    if (!current) return
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
    void this.save({ mcpActiveServers: next })
  },
})

export const useSettingsStore = (): typeof store => store

import { reactive } from 'vue'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

const store = reactive({
  items: [] as CustomSkill[],
  loading: false,
  importing: false,
  error: null as string | null,
  lastImport: null as SkillImportResult | null,

  async load(): Promise<void> {
    store.loading = true
    try {
      store.items = await invoke('skills.list', undefined)
    } finally {
      store.loading = false
    }
  },

  async import(url: string): Promise<boolean> {
    store.importing = true
    store.error = null
    store.lastImport = null
    try {
      const result = await invoke('skills.import', { url })
      store.lastImport = result
      await store.load()
      const n = result.imported.length
      if (n > 0) {
        useToastsStore().success(
          `Imported ${n} skill${n === 1 ? '' : 's'}`,
          result.skipped.length > 0
            ? `${result.skipped.length} skipped.`
            : 'Every session can use it now.',
        )
      }
      return n > 0
    } catch (e) {
      store.error = errorMessage(e)
      useToastsStore().error('That import failed', errorMessage(e))
      return false
    } finally {
      store.importing = false
    }
  },

  async setEnabled(name: string, on: boolean): Promise<void> {
    store.error = null
    try {
      store.items = await invoke('skills.setEnabled', { name, enabled: on })
    } catch (e) {
      store.error = errorMessage(e)
    }
  },

  async setGroupEnabled(names: readonly string[], on: boolean): Promise<void> {
    for (const name of names) await store.setEnabled(name, on)
  },

  async remove(name: string): Promise<void> {
    store.error = null
    try {
      store.items = await invoke('skills.remove', { name })
    } catch (e) {
      store.error = errorMessage(e)
    }
  },
})

export const useSkillsStore = (): typeof store => store

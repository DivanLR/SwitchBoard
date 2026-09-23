import { reactive } from 'vue'
import { errorMessage, invoke } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

const store = reactive({
  installed: [] as string[],
  loading: false,
  importing: false,
  error: null as string | null,

  async load(): Promise<void> {
    store.loading = true
    try {
      store.installed = await invoke('skills.list', undefined)
    } finally {
      store.loading = false
    }
  },

  async import(url: string): Promise<boolean> {
    store.importing = true
    store.error = null
    try {
      const result = await invoke('skills.import', { url })
      await store.load()
      const n = result.imported.length
      if (n > 0) {
        useToastsStore().success(
          `Imported ${n} skill${n === 1 ? '' : 's'}`,
          result.skipped.length > 0 ? `${result.skipped.length} skipped.` : "It's ready to use.",
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
})

export const useSkillsStore = (): typeof store => store

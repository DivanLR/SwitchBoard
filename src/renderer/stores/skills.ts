import { computed, reactive, toRefs } from 'vue'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

const state = reactive({
  items: [] as CustomSkill[],
  loading: false,
  importing: false,
  error: null as string | null,
  lastImport: null as SkillImportResult | null,
})

const enabled = computed(() => state.items.filter((skill) => skill.enabled))

const store = reactive({
  ...toRefs(state),
  enabled,

  async load(): Promise<void> {
    state.loading = true
    try {
      state.items = await invoke('skills.list', undefined)
    } finally {
      state.loading = false
    }
  },

  async import(url: string): Promise<boolean> {
    state.importing = true
    state.error = null
    state.lastImport = null
    try {
      const result = await invoke('skills.import', { url })
      state.lastImport = result
      await this.load()
      const toasts = useToastsStore()
      const n = result.imported.length
      if (n > 0) {
        toasts.success(
          `Imported ${n} skill${n === 1 ? '' : 's'}`,
          result.skipped.length > 0
            ? `${result.skipped.length} skipped — see the list below.`
            : 'They are switched on and ready in the Skills tab.',
        )
      }
      return result.imported.length > 0
    } catch (e) {
      state.error = errorMessage(e)
      useToastsStore().error('That import failed', errorMessage(e))
      return false
    } finally {
      state.importing = false
    }
  },

  async setEnabled(name: string, on: boolean): Promise<void> {
    state.error = null
    try {
      state.items = await invoke('skills.setEnabled', { name, enabled: on })
    } catch (e) {
      state.error = errorMessage(e)
    }
  },

  async remove(name: string): Promise<void> {
    state.error = null
    try {
      state.items = await invoke('skills.remove', { name })
    } catch (e) {
      state.error = errorMessage(e)
    }
  },

  async run(projectId: string, name: string, argument?: string): Promise<string | null> {
    state.error = null
    try {
      const { sessionId } = await invoke('skills.run', { projectId, name, argument })
      return sessionId
    } catch (e) {
      state.error = errorMessage(e)
      return null
    }
  },
})

export const useSkillsStore = (): typeof store => store

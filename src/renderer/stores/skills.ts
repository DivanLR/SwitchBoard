import { computed, reactive, toRefs } from 'vue'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

const state = reactive({
  items: [] as CustomSkill[],
  installed: [] as string[],
  loading: false,
  importing: false,
  error: null as string | null,
  lastImport: null as SkillImportResult | null,
})

const enabled = computed((): CustomSkill[] => state.items.filter((skill) => skill.enabled))

const store = reactive({
  ...toRefs(state),
  enabled,

  async load(): Promise<void> {
    state.loading = true
    try {
      ;[state.items, state.installed] = await Promise.all([
        invoke('skills.list', undefined),
        invoke('skills.installed', undefined),
      ])
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
      state.installed = await invoke('skills.installed', undefined)
    } catch (e) {
      state.error = errorMessage(e)
    }
  },

  async setGroupEnabled(names: readonly string[], on: boolean): Promise<void> {
    for (const name of names) await store.setEnabled(name, on)
  },

  async remove(name: string): Promise<void> {
    state.error = null
    try {
      state.items = await invoke('skills.remove', { name })
      state.installed = await invoke('skills.installed', undefined)
    } catch (e) {
      state.error = errorMessage(e)
    }
  },

  async run(projectId: string, name: string, argument?: string): Promise<string | null> {
    state.error = null
    try {
      return (await invoke('skills.run', { projectId, name, argument })).sessionId
    } catch (e) {
      state.error = errorMessage(e)
      return null
    }
  },
})

export const useSkillsStore = (): typeof store => store

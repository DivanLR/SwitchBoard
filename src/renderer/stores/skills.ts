// Custom skills: the ones the developer imported from a Git host, as opposed to
// the curated plugin commands the Cleanup section offers.
//
// One store for two surfaces. Settings manages them (import, switch on and off,
// remove) and the Skills section runs them, and both read this same list — a
// skill switched off in Settings has to disappear from the section immediately,
// which two copies of the list could not guarantee.
//
// Not keyed by project. The CLI reads one user-level skills directory for every
// project, so a per-project list here would be inventing a granularity the
// runtime does not have (see the skills.list contract).
import { computed, reactive, toRefs } from 'vue'
import type { CustomSkill, SkillImportResult } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useToastsStore } from '@renderer/stores/toasts'

const state = reactive({
  items: [] as CustomSkill[],
  loading: false,
  /** An import in flight. It reaches over the network, so it is worth saying. */
  importing: false,
  /** Why the last import or toggle failed, in the host's own words. */
  error: null as string | null,
  /** What the last import found, kept so the view can report skipped skills
   *  rather than silently importing eight of ten. Cleared on the next import. */
  lastImport: null as SkillImportResult | null,
})

/**
 * The skills a session can actually run right now.
 *
 * A real computed rather than a getter: it scans the list, and the section reads
 * it on every render (see the store conventions in CLAUDE.md).
 */
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

  /**
   * Import every skill under a repository URL.
   *
   * Returns whether anything landed, so the caller can clear its input only on
   * success and leave a mistyped URL in place to be corrected.
   */
  async import(url: string): Promise<boolean> {
    state.importing = true
    state.error = null
    state.lastImport = null
    try {
      const result = await invoke('skills.import', { url })
      state.lastImport = result
      await this.load()
      // Said out loud, because an import can land ten skills in a section the
      // developer is not looking at. The skipped count rides along rather than
      // being left to the panel: "imported 8" reads as complete success when it
      // was eight of ten.
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

  /** Switch one on or off. The host answers with the whole list, so the toggle
   *  reflects what actually happened on disk rather than what was asked for. */
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

  /** Run one in the project's Skills session; answers the session it went to so
   *  the section can show that session's output. */
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

// Saved session transcripts: the temp-file exports a following session can be
// seeded with. Sessions write these continuously in the main process, so this
// store only asks for the list, triggers a save on demand, and remembers the last
// path so the view can show where the file landed.
import { computed, reactive, toRefs } from 'vue'
import type { TranscriptSummary } from '@shared/domain'
import { invoke } from '@renderer/ipc'

const state = reactive({
  items: [] as TranscriptSummary[],
  /** The path of the most recent manual save, for the view to show and then drop. */
  lastSavedPath: null as string | null,
})

/** Transcripts by project, so a project's start panel can offer only its own. */
const byProject = computed((): Map<string, TranscriptSummary[]> => {
  const out = new Map<string, TranscriptSummary[]>()
  for (const item of state.items) {
    const list = out.get(item.projectId)
    if (list) list.push(item)
    else out.set(item.projectId, [item])
  }
  return out
})

const store = reactive({
  ...toRefs(state),
  byProject,

  async refresh(): Promise<void> {
    state.items = await invoke('transcripts.list', {})
  },

  /** The newest unexpired transcript for a project, or null. */
  latestFor(projectId: string): TranscriptSummary | null {
    return byProject.value.get(projectId)?.[0] ?? null
  },

  /** Write this session's transcript now and keep its path for the view. */
  async save(sessionId: string): Promise<TranscriptSummary> {
    const saved = await invoke('transcripts.save', { sessionId })
    state.lastSavedPath = saved.path
    await this.refresh()
    return saved
  },

  clearLastSaved(): void {
    state.lastSavedPath = null
  },
})

export const useTranscriptsStore = (): typeof store => store

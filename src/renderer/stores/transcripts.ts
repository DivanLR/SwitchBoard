import { reactive, toRefs } from 'vue'
import type { TranscriptSummary } from '@shared/domain'
import { invoke } from '@renderer/ipc'

const state = reactive({
  bySession: {} as Record<string, TranscriptSummary | null>,
})

const store = reactive({
  ...toRefs(state),

  async load(sessionId: string): Promise<void> {
    state.bySession[sessionId] = await invoke('transcripts.for', { sessionId })
  },
})

export const useTranscriptsStore = (): typeof store => store

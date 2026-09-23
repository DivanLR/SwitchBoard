import { reactive } from 'vue'
import type { SectionKind } from '@shared/domain'
import { invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

const store = reactive({
  async runInSession(
    projectId: string,
    text: string,
    background: boolean,
    watchDiagrams: boolean,
    kind: SectionKind,
  ): Promise<string> {
    const { sessionId } = await invoke('sections.runInSession', {
      projectId,
      text,
      background,
      watchDiagrams,
      kind,
    })
    if (background) {
      const projects = useProjectsStore()
      await projects.refresh()
      projects.focusSession(projectId, sessionId)
    }
    return sessionId
  },
})

export const useSectionsStore = (): typeof store => store

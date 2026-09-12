import { reactive } from 'vue'
import type { VerifyRun } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

async function surfaceNewSessions(): Promise<void> {
  await useProjectsStore().refresh()
}

let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, VerifyRun[]>,
  error: null as string | null,
  starting: false,

  listFor(projectId: string): VerifyRun[] {
    return this.byProject[projectId] ?? []
  },

  latestFor(projectId: string): VerifyRun | null {
    return this.listFor(projectId)[0] ?? null
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    const runs = await invoke('verify.list', { projectId })
    if (token !== requestToken) return
    this.byProject[projectId] = runs
  },

  applyPush(projectId: string, runs: VerifyRun[]): void {
    this.byProject[projectId] = runs
  },

  async start(
    projectId: string,
    stackId: string,
    suiteIds: string[],
    isolated = false,
  ): Promise<boolean> {
    this.error = null
    this.starting = true
    try {
      const { runs } = await invoke('verify.start', { projectId, stackId, suiteIds, isolated })
      this.byProject[projectId] = runs
      await surfaceNewSessions()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

  async cancel(projectId: string, runId: string): Promise<boolean> {
    this.error = null
    try {
      this.byProject[projectId] = await invoke('verify.cancel', { projectId, runId })
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },

  async captureEvidence(projectId: string, runId?: string): Promise<boolean> {
    this.error = null
    try {
      const { runs } = await invoke('verify.evidence', { projectId, runId })
      this.byProject[projectId] = runs
      await surfaceNewSessions()
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },
})

export const useVerifyStore = (): typeof store => store

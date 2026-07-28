// Verification-run state per project: the runs, their reports, and the transport
// for starting one. Mirrors the evals store (view/transport separation): every
// mutation answers with the project's full list, so there is nothing to merge.
import { reactive } from 'vue'
import type { VerifyRun } from '@shared/domain'
import { errorMessage, invoke } from '@renderer/ipc'

// Guards the shared list against a slower response from a project the developer
// has already switched away from (mirrors evals.load).
let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, VerifyRun[]>,
  error: null as string | null,
  /** True between the click and the dispatch landing, so the button can't double-fire. */
  starting: false,

  listFor(projectId: string): VerifyRun[] {
    return this.byProject[projectId] ?? []
  },

  /** The run the panels render: the newest, running or finished. */
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

  /** Start a run over the chosen suites. Resolves to true when it was dispatched. */
  async start(projectId: string, stackId: string, suiteIds: string[]): Promise<boolean> {
    this.error = null
    this.starting = true
    try {
      const { runs } = await invoke('verify.start', { projectId, stackId, suiteIds })
      this.byProject[projectId] = runs
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    } finally {
      this.starting = false
    }
  },

  /** Capture evidence against the newest run, without re-running its suites. */
  async captureEvidence(projectId: string, runId?: string): Promise<boolean> {
    this.error = null
    try {
      const { runs } = await invoke('verify.evidence', { projectId, runId })
      this.byProject[projectId] = runs
      return true
    } catch (error) {
      this.error = errorMessage(error)
      return false
    }
  },
})

export const verify = store

// Eval-loop state per project: the acceptance lines with their verdicts and
// ratings. The store owns all evals transport (view/transport separation); every
// mutation answers with the project's full list, so there is nothing to merge.
import { reactive } from 'vue'
import type { EvalCheckStatus, EvalRun, EvalVerdict } from '@shared/domain'
import type { AvailableSuites } from '@shared/test-catalog'
import { invoke } from '@renderer/ipc'

// Guards the shared list against a slower response from a project the developer
// has already switched away from (mirrors specs.loadState).
let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, EvalRun[]>,
  suitesByProject: {} as Record<string, AvailableSuites[]>,
  loading: false,
  error: null as string | null,

  listFor(projectId: string): EvalRun[] {
    return this.byProject[projectId] ?? []
  },

  suitesFor(projectId: string): AvailableSuites[] {
    return this.suitesByProject[projectId] ?? []
  },

  async load(projectId: string): Promise<void> {
    const token = ++requestToken
    this.loading = true
    try {
      const [runs, suites] = await Promise.all([
        invoke('evals.list', { projectId }),
        invoke('evals.suites', { projectId }),
      ])
      if (token !== requestToken) return
      this.byProject[projectId] = runs
      this.suitesByProject[projectId] = suites
    } finally {
      if (token === requestToken) this.loading = false
    }
  },

  /** The gate result arriving from the session while the developer watches. */
  applyPush(projectId: string, runs: EvalRun[]): void {
    this.byProject[projectId] = runs
  },

  /** Send this line's work to the session: check, attempts, or judge. */
  async dispatch(projectId: string, id: string, kind: 'check' | 'attempts' | 'judge'): Promise<void> {
    this.error = null
    try {
      const { runs } = await invoke('evals.dispatch', { projectId, id, kind })
      this.byProject[projectId] = runs
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  },

  async add(projectId: string, acceptance: string, checkCmd?: string): Promise<void> {
    this.error = null
    try {
      this.byProject[projectId] = await invoke('evals.add', {
        projectId,
        acceptance,
        checkCmd: checkCmd?.trim() || undefined,
      })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  },

  /** Record what the developer saw — check outcome, verdict, rating, or note. */
  async record(
    projectId: string,
    id: string,
    patch: {
      checkStatus?: EvalCheckStatus
      verdict?: EvalVerdict
      rating?: number | null
      note?: string | null
      attempts?: number
    },
  ): Promise<void> {
    this.error = null
    try {
      this.byProject[projectId] = await invoke('evals.record', {
        projectId,
        id,
        ...patch,
      })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  },

  async remove(projectId: string, id: string): Promise<void> {
    this.byProject[projectId] = await invoke('evals.remove', { projectId, id })
  },
})

export const evals = store

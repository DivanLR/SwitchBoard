import { reactive } from 'vue'
import type { EvalCheckStatus, EvalRun, EvalVerdict } from '@shared/domain'
import type { AvailableSuites } from '@shared/test-catalog'
import { errorMessage, invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let requestToken = 0

const store = reactive({
  byProject: {} as Record<string, EvalRun[]>,
  suitesByProject: {} as Record<string, AvailableSuites[]>,
  loading: false,
  error: null as string | null,
  adding: false,
  dispatching: [] as string[],

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

  applyPush(projectId: string, runs: EvalRun[]): void {
    this.byProject[projectId] = runs
  },

  async dispatch(projectId: string, id: string, kind: 'check' | 'attempts' | 'judge'): Promise<void> {
    if (this.dispatching.includes(id)) return
    this.dispatching = [...this.dispatching, id]
    this.error = null
    try {
      const { runs } = await invoke('evals.dispatch', { projectId, id, kind })
      this.byProject[projectId] = runs
      await useProjectsStore().refresh()
    } catch (error) {
      this.error = errorMessage(error)
    } finally {
      this.dispatching = this.dispatching.filter((x) => x !== id)
    }
  },

  async add(projectId: string, acceptance: string, checkCmd?: string): Promise<void> {
    if (this.adding) return
    this.adding = true
    this.error = null
    try {
      this.byProject[projectId] = await invoke('evals.add', {
        projectId,
        acceptance,
        checkCmd: checkCmd?.trim() || undefined,
      })
    } catch (error) {
      this.error = errorMessage(error)
    } finally {
      this.adding = false
    }
  },

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
      this.error = errorMessage(error)
    }
  },

  async remove(projectId: string, id: string): Promise<void> {
    this.byProject[projectId] = await invoke('evals.remove', { projectId, id })
  },
})

export const useEvalsStore = (): typeof store => store

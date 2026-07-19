// Spec Kit state per project: installed flag, spec summaries, and the selected
// spec's detail. The store owns all specs transport (view/transport separation).
import { defineStore } from 'pinia'
import type { SpecDetail, SpecKitState } from '@shared/domain'

interface SpecsState {
  byProject: Record<string, SpecKitState>
  detail: SpecDetail | null
  selectedSpecId: string | null
  loading: boolean
  installing: boolean
  installError: string | null
  /** The project whose phase is being implemented (null = nothing running). */
  runningProjectId: string | null
  pollTimer: ReturnType<typeof setInterval> | null
}

export const useSpecsStore = defineStore('specs', {
  state: (): SpecsState => ({
    byProject: {},
    detail: null,
    selectedSpecId: null,
    loading: false,
    installing: false,
    installError: null,
    runningProjectId: null,
    pollTimer: null,
  }),

  getters: {
    stateFor(state) {
      return (projectId: string): SpecKitState =>
        state.byProject[projectId] ?? { installed: false, specs: [] }
    },
    /** True when a phase is being implemented for the given project. */
    isRunning(state) {
      return (projectId: string): boolean => state.runningProjectId === projectId
    },
  },

  actions: {
    async loadState(projectId: string): Promise<void> {
      this.loading = true
      try {
        const state = await window.switchboard.invoke('specs.state', { projectId })
        this.byProject[projectId] = state
        // Auto-select the first spec if none chosen or the current one is gone.
        if (state.specs.length > 0) {
          if (!this.selectedSpecId || !state.specs.some((s) => s.id === this.selectedSpecId)) {
            await this.selectSpec(projectId, state.specs[0].id)
          }
        } else {
          this.selectedSpecId = null
          this.detail = null
        }
      } finally {
        this.loading = false
      }
    },

    async selectSpec(projectId: string, specId: string): Promise<void> {
      this.selectedSpecId = specId
      this.detail = await window.switchboard.invoke('specs.detail', { projectId, specId })
    },

    /** Send a spec-kit command / prompt to the project's session. */
    async runInSession(projectId: string, text: string): Promise<void> {
      await window.switchboard.invoke('specs.runInSession', { projectId, text })
    },

    /**
     * Start implementing a phase (or a whole spec): send the implement command,
     * then poll specs.detail so tasks visibly flip to done as they complete.
     */
    async startPhase(projectId: string, specId: string, text: string): Promise<void> {
      await this.selectSpec(projectId, specId)
      this.runningProjectId = projectId
      try {
        await this.runInSession(projectId, text)
      } catch (e) {
        // A failed send must not leave the view stuck in the implementing state.
        this.stopPolling()
        throw e
      }
      this.startPolling(projectId, specId)
    },

    startPolling(projectId: string, specId: string): void {
      this.clearTimer()
      let idleRounds = 0
      const progressOf = (): { done: number; total: number } => {
        // Read from the target spec's summary, not the shared `detail`, so
        // selecting a different spec mid-run can't mislead the stop condition.
        const s = this.byProject[projectId]?.specs.find((x) => x.id === specId)
        return { done: s?.tasksDone ?? 0, total: s?.tasksTotal ?? 0 }
      }
      let lastDone = progressOf().done
      this.pollTimer = setInterval(() => {
        void (async () => {
          try {
            this.byProject[projectId] = await window.switchboard.invoke('specs.state', { projectId })
            if (this.selectedSpecId === specId) {
              this.detail = await window.switchboard.invoke('specs.detail', { projectId, specId })
            }
          } catch {
            // Project/spec gone or transport hiccup — stop rather than spin.
            this.stopPolling()
            return
          }
          const { done, total } = progressOf()
          idleRounds = done === lastDone ? idleRounds + 1 : 0
          lastDone = done
          // Stop when everything is done, or after progress has stalled a while.
          if ((total > 0 && done >= total) || idleRounds >= 40) this.stopPolling()
        })()
      }, 3000)
    },

    clearTimer(): void {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    },

    stopPolling(): void {
      this.clearTimer()
      this.runningProjectId = null
    },

    async install(projectId: string): Promise<void> {
      this.installing = true
      this.installError = null
      try {
        const state = await window.switchboard.invoke('specs.install', { projectId })
        this.byProject[projectId] = state
        if (state.specs[0]) await this.selectSpec(projectId, state.specs[0].id)
      } catch (e) {
        this.installError =
          typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)
      } finally {
        this.installing = false
      }
    },
  },
})

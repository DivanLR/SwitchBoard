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
}

export const useSpecsStore = defineStore('specs', {
  state: (): SpecsState => ({
    byProject: {},
    detail: null,
    selectedSpecId: null,
    loading: false,
    installing: false,
    installError: null,
  }),

  getters: {
    stateFor(state) {
      return (projectId: string): SpecKitState =>
        state.byProject[projectId] ?? { installed: false, specs: [] }
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

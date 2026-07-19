// Sidebar state (FR-003/004/005): projects with live sessions, selection,
// suggestions, and aggregate counters.
import { defineStore } from 'pinia'
import type { Session } from '@shared/domain'
import type { Counters, ProjectListItem, ProjectSuggestion, SessionStatusPush } from '@shared/ipc-types'

interface ProjectsState {
  items: ProjectListItem[]
  suggestions: ProjectSuggestion[]
  selectedProjectId: string | null
  counters: Counters
  loaded: boolean
}

export const useProjectsStore = defineStore('projects', {
  state: (): ProjectsState => ({
    items: [],
    suggestions: [],
    selectedProjectId: null,
    counters: { running: 0, needsYou: 0, pendingInbox: 0, costTodayUsd: 0, tokensToday: 0 },
    loaded: false,
  }),

  getters: {
    selected(state): ProjectListItem | null {
      return state.items.find((p) => p.id === state.selectedProjectId) ?? null
    },
    nameCollisions(state): Set<string> {
      const seen = new Map<string, number>()
      for (const item of state.items) {
        seen.set(item.name, (seen.get(item.name) ?? 0) + 1)
      }
      return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name))
    },
  },

  actions: {
    async refresh(): Promise<void> {
      const snapshot = await window.switchboard.invoke('projects.list', undefined)
      this.items = snapshot.projects
      this.counters = snapshot.counters
      this.loaded = true
      if (!this.selectedProjectId && this.items.length > 0) {
        this.selectedProjectId = this.items[0].id
      }
    },

    async loadSuggestions(): Promise<void> {
      this.suggestions = await window.switchboard.invoke('projects.suggestions', undefined)
    },

    async register(path: string, name?: string): Promise<void> {
      await window.switchboard.invoke('projects.register', { path, name })
      await this.refresh()
      await this.loadSuggestions()
    },

    async archive(projectId: string): Promise<void> {
      await window.switchboard.invoke('projects.archive', { projectId })
      if (this.selectedProjectId === projectId) this.selectedProjectId = null
      await this.refresh()
    },

    async rename(projectId: string, name: string): Promise<void> {
      await window.switchboard.invoke('projects.rename', { projectId, name })
      const item = this.items.find((p) => p.id === projectId)
      if (item) item.name = name
    },

    async startSession(projectId: string, resume = false): Promise<Session> {
      const session = await window.switchboard.invoke('sessions.start', { projectId, resume })
      await this.refresh()
      return session
    },

    select(projectId: string): void {
      this.selectedProjectId = projectId
    },

    applyStatusPush(push: SessionStatusPush): void {
      const item = this.items.find((p) => p.id === push.projectId)
      if (!item) return
      if (!item.session || item.session.id === push.sessionId) {
        if (!item.session) return
        item.session.status = push.status
        item.session.statusDetail = push.statusDetail ?? null
        if (push.branch !== undefined) item.session.branch = push.branch
        if (push.diffAdds !== undefined) item.session.diffAdds = push.diffAdds
        if (push.diffDels !== undefined) item.session.diffDels = push.diffDels
        if (push.usageUtilization !== undefined) item.session.usageUtilization = push.usageUtilization
        if (push.usageResetsAt !== undefined) item.session.usageResetsAt = push.usageResetsAt
        if (push.usageLimitType !== undefined) item.session.usageLimitType = push.usageLimitType
        if (push.endedAt !== undefined) item.session.endedAt = push.endedAt
        if (push.endReason !== undefined) item.session.endReason = push.endReason
      }
    },

    setCounters(counters: Counters): void {
      this.counters = counters
    },
  },
})

// Sidebar state (FR-003/004/005): projects with live sessions, selection,
// suggestions, and aggregate counters.
import { defineStore } from 'pinia'
import type { Project, ProjectCommand, Session } from '@shared/domain'
import type { Counters, ProjectListItem, ProjectSuggestion, SessionStatusPush } from '@shared/ipc-types'
import { useActiveSessionStore } from './activeSession'

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
    counters: { running: 0, needsYou: 0, costTodayUsd: 0, tokensToday: 0 },
    loaded: false,
  }),

  getters: {
    selected(state): ProjectListItem | null {
      return state.items.find((p) => p.id === state.selectedProjectId) ?? null
    },
    /** Real, user-registered projects (the reserved Database row excluded). */
    visibleItems(state): ProjectListItem[] {
      return state.items.filter((p) => !p.reserved)
    },
    /** The single reserved row backing the global Database MCP session. */
    dbProject(state): ProjectListItem | null {
      return state.items.find((p) => p.reserved) ?? null
    },
    nameCollisions(state): Set<string> {
      const seen = new Map<string, number>()
      for (const item of state.items) {
        if (item.reserved) continue // never collides with a user project named "Database"
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
      // The reserved Database row must never become the default selection.
      if (!this.selectedProjectId) {
        this.selectedProjectId = this.items.find((p) => !p.reserved)?.id ?? null
      }
    },

    async loadSuggestions(): Promise<void> {
      this.suggestions = await window.switchboard.invoke('projects.suggestions', undefined)
    },

    async register(path: string, name?: string): Promise<Project> {
      const project = await window.switchboard.invoke('projects.register', { path, name })
      await this.refresh()
      await this.loadSuggestions()
      return project
    },

    /** A project's available slash commands / skills (composer + settings). */
    async commands(projectId: string): Promise<ProjectCommand[]> {
      return window.switchboard.invoke('projects.commands', { projectId })
    },

    /** Recent composer prompts for a project (command history / up-arrow recall). */
    async promptHistory(projectId: string): Promise<string[]> {
      return window.switchboard.invoke('sessions.promptHistory', { projectId })
    },

    /** Cached Database-MCP schema document for a project, or null if never scanned. */
    async readMcpSchema(projectId: string): Promise<string | null> {
      const res = await window.switchboard.invoke('mcp.readSchema', { projectId })
      return res.content
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

    async move(projectId: string, toIndex: number): Promise<void> {
      await window.switchboard.invoke('projects.move', { projectId, toIndex })
      await this.refresh()
    },

    async addRef(projectId: string, target: string): Promise<void> {
      const refs = await window.switchboard.invoke('projects.refs.add', { projectId, target })
      const item = this.items.find((p) => p.id === projectId)
      if (item) item.refs = refs
    },

    async removeRef(projectId: string, path: string): Promise<void> {
      const refs = await window.switchboard.invoke('projects.refs.remove', { projectId, path })
      const item = this.items.find((p) => p.id === projectId)
      if (item) item.refs = refs
    },

    async startSession(
      projectId: string,
      resume = false,
      bypassPermissions = false,
    ): Promise<Session> {
      const session = await window.switchboard.invoke('sessions.start', {
        projectId,
        resume,
        bypassPermissions,
      })
      await this.refresh()
      return session
    },

    select(projectId: string): void {
      this.selectedProjectId = projectId
      // Selecting a project leaves the global Database MCP view, so the chat
      // swaps to that project's session — same as switching between projects.
      // The reserved MCP session stays alive; the MCP row reopens its view.
      useActiveSessionStore().openMcp(null)
    },

    applyStatusPush(push: SessionStatusPush): void {
      const item = this.items.find((p) => p.id === push.projectId)
      if (item?.session && item.session.id === push.id) item.session = { ...push }
    },

    setCounters(counters: Counters): void {
      this.counters = counters
    },
  },
})

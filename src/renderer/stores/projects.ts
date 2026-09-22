import { computed, reactive, toRefs } from 'vue'
import type {
  Project,
  ProjectCommand,
  Session,
  SessionMode,
} from '@shared/domain'
import type { Counters, ProjectListItem, SessionStatusPush } from '@shared/ipc-types'
import { useActiveSessionStore } from './activeSession'
import { invoke } from '@renderer/ipc'

const state = reactive({
  items: [] as ProjectListItem[],
  archived: [] as Project[],
  selectedProjectId: null as string | null,
  counters: { running: 0, needsYou: 0, costTodayUsd: 0, tokensToday: 0 } as Counters,
  loaded: false,
  starting: false,
  focusedSessionIds: {} as Record<string, string>,
})

function applyFocus(): void {
  for (const item of state.items) {
    const wanted = state.focusedSessionIds[item.id]
    if (!wanted) continue
    const match = item.sessions.find((s) => s.id === wanted)
    if (match) item.session = match
    else delete state.focusedSessionIds[item.id]
  }
}

const selected = computed(
  (): ProjectListItem | null =>
    state.items.find((p) => p.id === state.selectedProjectId) ?? null,
)

const visibleItems = computed((): ProjectListItem[] => state.items.filter((p) => !p.reserved))

const dbProject = computed((): ProjectListItem | null => state.items.find((p) => p.reserved) ?? null)

const nameCollisions = computed((): Set<string> => {
  const seen = new Map<string, number>()
  for (const item of state.items) {
    if (item.reserved) continue 
    seen.set(item.name, (seen.get(item.name) ?? 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name))
})

const store = reactive({
  ...toRefs(state),
  selected,
  visibleItems,
  dbProject,
  nameCollisions,

  async refresh(): Promise<void> {
    const snapshot = await invoke('projects.list', undefined)
    state.items = snapshot.projects
    state.archived = snapshot.archived
    state.counters = snapshot.counters
    state.loaded = true
    applyFocus()
    if (!state.selectedProjectId) {
      state.selectedProjectId = state.items.find((p) => !p.reserved)?.id ?? null
    }
  },

  async endSessions(sessionIds: readonly string[]): Promise<void> {
    await Promise.allSettled(
      sessionIds.map((sessionId) => invoke('sessions.stop', { sessionId })),
    )
    await this.refresh()
  },

  async pickFolder(): Promise<string | null> {
    return (await invoke('dialog.pickFolder', undefined)).path
  },

  async register(path: string, name?: string, defaultSessionMode?: SessionMode): Promise<Project> {
    const project = await invoke('projects.register', { path, name, defaultSessionMode })
    await this.refresh()
    return project
  },

  async setSessionMode(projectId: string, mode: SessionMode): Promise<void> {
    await invoke('projects.setSessionMode', { projectId, mode })
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.defaultSessionMode = mode
  },

  async setUseContainers(projectId: string, on: boolean): Promise<void> {
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.useContainers = on
    try {
      await invoke('projects.setUseContainers', { projectId, on })
    } catch (e) {
      await this.refresh()
      throw e
    }
  },

  async renameSession(sessionId: string, label: string): Promise<void> {
    await invoke('sessions.rename', { sessionId, label })
    await this.refresh()
  },

  async commands(projectId: string): Promise<ProjectCommand[]> {
    return invoke('projects.commands', { projectId })
  },

  async installPlugin(projectId: string, marketplace: string, pkg: string): Promise<ProjectCommand[]> {
    await invoke('plugins.install', { marketplace, pkg })
    return invoke('projects.commands', { projectId })
  },

  async promptHistory(projectId: string): Promise<string[]> {
    return invoke('sessions.promptHistory', { projectId })
  },

  async readMcpSchema(projectId: string, servers?: string[]): Promise<string | null> {
    const res = await invoke('mcp.readSchema', { projectId, servers })
    return res.content
  },

  async archive(projectId: string): Promise<void> {
    await invoke('projects.archive', { projectId })
    if (state.selectedProjectId === projectId) state.selectedProjectId = null
    await this.refresh()
  },

  async unarchive(projectId: string): Promise<void> {
    await invoke('projects.unarchive', { projectId })
    await this.refresh()
    this.select(projectId)
  },

  async rename(projectId: string, name: string): Promise<void> {
    await invoke('projects.rename', { projectId, name })
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.name = name
  },

  async repoint(projectId: string, path: string): Promise<void> {
    await invoke('projects.repoint', { projectId, path })
    await this.refresh()
  },

  async move(projectId: string, toIndex: number): Promise<void> {
    await invoke('projects.move', { projectId, toIndex })
    await this.refresh()
  },

  async addRef(projectId: string, target: string): Promise<void> {
    const refs = await invoke('projects.refs.add', { projectId, target })
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.refs = refs
  },

  async removeRef(projectId: string, path: string): Promise<void> {
    const refs = await invoke('projects.refs.remove', { projectId, path })
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.refs = refs
  },

  async startSession(
    projectId: string,
    resume = false,
    mode?: SessionMode,
    carryTranscriptFrom?: string,
    containerised?: boolean,
  ): Promise<Session> {
    state.starting = true
    try {
      const session = await invoke('sessions.start', {
        projectId,
        resume,
        mode,
        carryTranscriptFrom,
        containerised:
          containerised ?? state.items.find((p) => p.id === projectId)?.useContainers ?? false,
      })
      await this.refresh()
      this.focusSession(projectId, session.id)
      return session
    } finally {
      state.starting = false
    }
  },

  select(projectId: string): void {
    state.selectedProjectId = projectId
    useActiveSessionStore().openMcp(false)
  },

  focusSession(projectId: string, sessionId: string): void {
    state.focusedSessionIds[projectId] = sessionId
    applyFocus()
  },

  applyStatusPush(push: SessionStatusPush): void {
    const item = state.items.find((p) => p.id === push.projectId)
    if (!item) return
    const index = item.sessions.findIndex((s) => s.id === push.id)
    if (index !== -1) item.sessions[index] = { ...push }
    if (item.session?.id === push.id) item.session = { ...push }
  },

  setCounters(counters: Counters): void {
    state.counters = counters
  },
})

export const useProjectsStore = (): typeof store => store

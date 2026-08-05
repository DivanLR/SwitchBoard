// Sidebar state (FR-003/004/005): projects with live sessions, selection,
// suggestions, and aggregate counters.
import { computed, reactive, toRefs } from 'vue'
import type { McpScan, Project, ProjectCommand, Session } from '@shared/domain'
import type { Counters, ProjectListItem, ProjectSuggestion, SessionStatusPush } from '@shared/ipc-types'
import { useActiveSessionStore } from './activeSession'
import { invoke } from '@renderer/ipc'

// State and derivations are declared separately so the derivations can be real
// `computed()`s. A plain `get` on a reactive object is NOT cached by Vue — it
// re-runs on every read, so `nameCollisions` rebuilt a Map and a Set, and
// `selected`/`dbProject` re-scanned the list, once per render of every template
// that touched them. Spread back in through `toRefs`, the public shape of the
// store is unchanged (reactive unwraps refs and computeds on read).
const state = reactive({
  items: [] as ProjectListItem[],
  suggestions: [] as ProjectSuggestion[],
  selectedProjectId: null as string | null,
  counters: { running: 0, needsYou: 0, costTodayUsd: 0, tokensToday: 0 } as Counters,
  loaded: false,
  // A session start is in flight. Held here rather than in the caller because
  // three places start sessions (the New session dialog, the ended-session
  // banner, the Database MCP view) and the full-page waiting state that reads
  // this is rendered once, in the shell.
  starting: false,
})

const selected = computed(
  (): ProjectListItem | null =>
    state.items.find((p) => p.id === state.selectedProjectId) ?? null,
)

/** Real, user-registered projects (the reserved Database row excluded). */
const visibleItems = computed((): ProjectListItem[] => state.items.filter((p) => !p.reserved))

/** The single reserved row backing the global Database MCP session. */
const dbProject = computed((): ProjectListItem | null => state.items.find((p) => p.reserved) ?? null)

const nameCollisions = computed((): Set<string> => {
  const seen = new Map<string, number>()
  for (const item of state.items) {
    if (item.reserved) continue // never collides with a user project named "Database"
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
    state.counters = snapshot.counters
    state.loaded = true
    // The reserved Database row must never become the default selection.
    if (!state.selectedProjectId) {
      state.selectedProjectId = state.items.find((p) => !p.reserved)?.id ?? null
    }
  },

  async loadSuggestions(): Promise<void> {
    state.suggestions = await invoke('projects.suggestions', undefined)
  },

  async register(path: string, name?: string): Promise<Project> {
    const project = await invoke('projects.register', { path, name })
    await this.refresh()
    await this.loadSuggestions()
    return project
  },

  /** A project's available slash commands / skills (composer + settings). */
  async commands(projectId: string): Promise<ProjectCommand[]> {
    return invoke('projects.commands', { projectId })
  },

  /** Recent composer prompts for a project (command history / up-arrow recall). */
  async promptHistory(projectId: string): Promise<string[]> {
    return invoke('sessions.promptHistory', { projectId })
  },

  /** Cached MCP schema doc — a combination's own scan when servers given. */
  async readMcpSchema(projectId: string, servers?: string[]): Promise<string | null> {
    const res = await invoke('mcp.readSchema', { projectId, servers })
    return res.content
  },

  /** Scanned-combination history for the MCP view, newest first. */
  async mcpScanHistory(projectId: string): Promise<McpScan[]> {
    return invoke('mcp.scanHistory', { projectId })
  },

  /** Record a finished scan for the active combination (null if no doc). */
  async mcpRecordScan(projectId: string, servers: string[]): Promise<McpScan | null> {
    return invoke('mcp.recordScan', { projectId, servers })
  },

  async archive(projectId: string): Promise<void> {
    await invoke('projects.archive', { projectId })
    if (state.selectedProjectId === projectId) state.selectedProjectId = null
    await this.refresh()
  },

  async rename(projectId: string, name: string): Promise<void> {
    await invoke('projects.rename', { projectId, name })
    const item = state.items.find((p) => p.id === projectId)
    if (item) item.name = name
  },

  /** Point a project at a different folder. Full refresh rather than a patch:
   *  the path changes gitNotice, drafts, and suggestions along with it. */
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
    bypassPermissions = false,
    planMode = false,
    /** A previous session id whose transcript seeds the new session's context. */
    carryTranscriptFrom?: string,
  ): Promise<Session> {
    state.starting = true
    try {
      const session = await invoke('sessions.start', {
        projectId,
        resume,
        bypassPermissions,
        planMode,
        carryTranscriptFrom,
      })
      // Refresh is inside the wait: the session row is what the view renders,
      // so clearing the waiting state before it lands shows an empty stream.
      await this.refresh()
      return session
    } finally {
      state.starting = false
    }
  },

  select(projectId: string): void {
    state.selectedProjectId = projectId
    // Selecting a project leaves the global Database MCP view, so the chat
    // swaps to that project's session — same as switching between projects.
    // The reserved MCP session stays alive; the MCP row reopens its view.
    useActiveSessionStore().openMcp(false)
  },

  applyStatusPush(push: SessionStatusPush): void {
    const item = state.items.find((p) => p.id === push.projectId)
    if (item?.session && item.session.id === push.id) item.session = { ...push }
  },

  setCounters(counters: Counters): void {
    state.counters = counters
  },
})

export const useProjectsStore = (): typeof store => store

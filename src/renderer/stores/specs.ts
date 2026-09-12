import { reactive } from 'vue'
import type { SectionKind, SpecDetail, SpecKitState } from '@shared/domain'
import { invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

let specRequestToken = 0
let watchTimer: ReturnType<typeof setInterval> | null = null
const watched = new Map<string, { sessionId: string; awaited?: ReadonlySet<string> }>()

export const NEW_SPEC_KEY = 'new-spec'

const busyKey = (projectId: string, key: string): string => `${projectId}|${key}`

const store = reactive({
  byProject: {} as Record<string, SpecKitState>,
  detail: null as SpecDetail | null,
  selectedSpecId: null as string | null,
  loading: false,
  installing: false,
  installError: null as string | null,
  busy: {} as Record<
    string,
    {
      projectId: string
      key: string
      label: string
      phase: 'starting' | 'running'
      implement: boolean
      sessionId?: string
    }
  >,

  stateFor(projectId: string): SpecKitState {
    return this.byProject[projectId] ?? { installed: false, specs: [] }
  },

  isRunning(projectId: string): boolean {
    return Object.values(this.busy).some((b) => b.projectId === projectId && b.implement)
  },

  runningIn(projectId: string): { key: string; label: string; sessionId: string }[] {
    return Object.values(this.busy)
      .filter((b) => b.projectId === projectId && b.sessionId)
      .map((b) => ({ key: b.key, label: b.label, sessionId: b.sessionId as string }))
  },

  phaseOf(projectId: string, key: string): 'starting' | 'running' | null {
    return this.busy[busyKey(projectId, key)]?.phase ?? null
  },

  runningLabel(projectId: string): string | null {
    const busy = Object.values(this.busy).find((b) => b.projectId === projectId)
    if (!busy) return null
    return busy.phase === 'starting' ? 'Starting a session' : busy.label
  },

  async loadState(projectId: string): Promise<void> {
    const token = ++specRequestToken
    this.loading = true
    try {
      const state = await invoke('specs.state', { projectId })
      if (token !== specRequestToken) return 
      this.byProject[projectId] = state
      if (state.specs.length > 0) {
        if (!this.selectedSpecId || !state.specs.some((s) => s.id === this.selectedSpecId)) {
          this.selectedSpecId = state.specs[0].id
          const detail = await invoke('specs.detail', {
            projectId,
            specId: state.specs[0].id,
          })
          if (token !== specRequestToken) return
          this.detail = detail
        }
      } else {
        this.selectedSpecId = null
        this.detail = null
      }
    } finally {
      if (token === specRequestToken) this.loading = false
    }
  },

  async selectSpec(projectId: string, specId: string): Promise<void> {
    const token = ++specRequestToken
    this.selectedSpecId = specId
    const detail = await invoke('specs.detail', { projectId, specId })
    if (token !== specRequestToken) return 
    this.detail = detail
  },

  async runInSession(
    projectId: string,
    text: string,
    background = false,
    watchDiagrams = false,
    kind: SectionKind = 'spec',
  ): Promise<string> {
    const { sessionId } = await invoke('specs.runInSession', {
      projectId,
      text,
      background,
      watchDiagrams,
      kind,
    })
    if (background) {
      const projects = useProjectsStore()
      await projects.refresh()
      projects.focusSession(projectId, sessionId)
    }
    return sessionId
  },

  async createSpec(projectId: string, description: string): Promise<void> {
    const before = new Set(this.stateFor(projectId).specs.map((s) => s.id))
    await this.runSpecCommand(
      projectId,
      `/speckit-specify ${description}`,
      NEW_SPEC_KEY,
      'Scaffolding the spec',
      { awaited: before },
    )
  },

  async startPhase(projectId: string, specId: string, text: string, key: string): Promise<void> {
    await this.selectSpec(projectId, specId)
    await this.runSpecCommand(projectId, text, key, 'Implementing', { implement: true })
  },

  async runSpecCommand(
    projectId: string,
    text: string,
    key: string,
    label: string,
    opts: {
      awaited?: ReadonlySet<string>
      implement?: boolean
    } = {},
  ): Promise<void> {
    const k = busyKey(projectId, key)
    this.busy[k] = { projectId, key, label, phase: 'starting', implement: !!opts.implement }
    let sessionId: string
    try {
      sessionId = await this.runInSession(projectId, text, true)
    } catch (e) {
      delete this.busy[k]
      throw e
    }
    this.busy[k] = { ...this.busy[k], phase: 'running', sessionId }
    watched.set(k, { sessionId, awaited: opts.awaited })
    this.startWatch()
  },

  startWatch(): void {
    if (watchTimer) return
    let rounds = 0
    watchTimer = setInterval(() => {
      void (async () => {
        rounds += 1
        const entries = Object.entries(this.busy).filter(([, b]) => b.phase === 'running')
        if (entries.length === 0) return this.stopSpecWatch()
        for (const projectId of new Set(entries.map(([, b]) => b.projectId))) {
          if (!(await this.reloadSpec(projectId))) {
            for (const [k, b] of entries) if (b.projectId === projectId) this.finish(k)
            continue
          }
        }
        for (const [k] of entries) {
          const sessionId = watched.get(k)?.sessionId
          if (!sessionId) {
            this.finish(k)
            continue
          }
          const fate = await invoke('sessions.fate', { sessionId }).catch(() => null)
          if (!fate || fate.endedAt) {
            const projectId = this.busy[k]?.projectId
            this.finish(k)
            if (projectId) await this.reloadSpec(projectId)
          }
        }
        if (rounds >= 2400) this.stopSpecWatch()
      })()
    }, 3000)
  },

  async reloadSpec(projectId: string): Promise<boolean> {
    try {
      this.byProject[projectId] = await invoke('specs.state', { projectId })
    } catch {
      return false
    }
    for (const [k, entry] of watched) {
      if (!entry.awaited || this.busy[k]?.projectId !== projectId) continue
      const fresh = this.stateFor(projectId).specs.find((s) => !entry.awaited?.has(s.id))
      if (fresh) {
        watched.set(k, { sessionId: entry.sessionId }) 
        await this.selectSpec(projectId, fresh.id)
        return true
      }
    }
    if (!this.selectedSpecId) return true
    try {
      this.detail = await invoke('specs.detail', { projectId, specId: this.selectedSpecId })
    } catch {
      return false
    }
    return true
  },

  finish(k: string): void {
    delete this.busy[k]
    watched.delete(k)
    if (Object.keys(this.busy).length === 0) this.stopSpecWatch()
  },

  stopSpecWatch(): void {
    if (watchTimer) {
      clearInterval(watchTimer)
      watchTimer = null
    }
    for (const k of Object.keys(this.busy)) delete this.busy[k]
    watched.clear()
  },

  async install(projectId: string): Promise<void> {
    this.installing = true
    this.installError = null
    try {
      const state = await invoke('specs.install', { projectId })
      this.byProject[projectId] = state
      if (state.specs[0]) await this.selectSpec(projectId, state.specs[0].id)
    } catch (e) {
      this.installError =
        typeof e === 'object' && e && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e)
    } finally {
      this.installing = false
    }
  },
})

export const useSpecsStore = (): typeof store => store

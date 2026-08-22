// Spec Kit state per project: installed flag, spec summaries, and the selected
// spec's detail. The store owns all specs transport (view/transport separation).
import { reactive } from 'vue'
import type { SectionKind, SpecDetail, SpecKitState } from '@shared/domain'
import { invoke } from '@renderer/ipc'
import { useProjectsStore } from '@renderer/stores/projects'

// Monotonic token guarding the shared, un-keyed detail/selectedSpecId state:
// switching projects while a load is in flight must not let the older response
// overwrite the newer project's spec detail (mirrors activeSession.open).
let specRequestToken = 0
// The poll handle is machinery, not view state, so it stays out of the store.
let pollTimer: ReturnType<typeof setInterval> | null = null
// Its own handle, not pollTimer's: a scaffold watch and an implement poll are
// started by different actions and either may be running when the other begins.
let scaffoldTimer: ReturnType<typeof setInterval> | null = null

const store = reactive({
  byProject: {} as Record<string, SpecKitState>,
  detail: null as SpecDetail | null,
  selectedSpecId: null as string | null,
  loading: false,
  installing: false,
  installError: null as string | null,
  /** The project whose phase is being implemented (null = nothing running). */
  runningProjectId: null as string | null,
  /** The Spec Kit command still running for a project, and what to call it on
   *  screen (null = none). Separate from runningProjectId, which means an
   *  implement phase and drives the "Implementing" chrome. */
  running: null as { projectId: string; label: string } | null,

  stateFor(projectId: string): SpecKitState {
    return this.byProject[projectId] ?? { installed: false, specs: [] }
  },

  /** True when a phase is being implemented for the given project. */
  isRunning(projectId: string): boolean {
    return this.runningProjectId === projectId
  },

  /** What a Spec Kit command running for this project should be called on
   *  screen, or null when nothing of the kind is running. */
  runningLabel(projectId: string): string | null {
    return this.running?.projectId === projectId ? this.running.label : null
  },

  async loadState(projectId: string): Promise<void> {
    const token = ++specRequestToken
    this.loading = true
    try {
      const state = await invoke('specs.state', { projectId })
      if (token !== specRequestToken) return // a newer project load superseded this
      this.byProject[projectId] = state
      // Auto-select the first spec if none chosen or the current one is gone.
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
    if (token !== specRequestToken) return // a newer selection superseded this
    this.detail = detail
  },

  /**
   * Send a spec-kit command or prompt to one of the project's sessions.
   *
   * `background` is the section default: the work runs beside the conversation.
   * The follow-up refresh exists so a spawned session gets a sidebar row — see
   * verify.ts's surfaceNewSessions for why — and re-applies focus so it doesn't
   * steal the centre pane.
   */
  /** Returns the session it went to, so a section can show that session's output
   *  while it works instead of a static word. */
  async runInSession(
    projectId: string,
    text: string,
    background = false,
    /** This dispatch may draw a diagram: have the main process announce the
     *  folder when the turn ends, so the section updates without polling. */
    watchDiagrams = false,
    /** Which section this belongs to, and so which of the project's own
     *  sessions it lands in. Only read when `background` is set. */
    kind: SectionKind = 'spec',
  ): Promise<string> {
    const { sessionId } = await invoke('specs.runInSession', {
      projectId,
      text,
      background,
      watchDiagrams,
      kind,
    })
    if (background) await useProjectsStore().refresh()
    return sessionId
  },

  /**
   * Create a spec: dispatch /speckit-specify, then watch the session that runs it.
   *
   * The dispatch on its own was the whole of this before, and the section that
   * sent it never learned anything afterwards: spec state is read on mount and
   * on a project switch only, so a spec scaffolded two or three minutes later
   * showed up whenever the view next happened to be remounted. From the
   * developer's chair that is indistinguishable from the button doing nothing,
   * which is exactly how it was reported.
   */
  async createSpec(projectId: string, description: string): Promise<void> {
    const before = new Set(this.stateFor(projectId).specs.map((s) => s.id))
    const sessionId = await this.runInSession(
      projectId,
      `/speckit-specify ${description}`,
      true,
    )
    this.watchSpecCommand(projectId, sessionId, 'Scaffolding the spec', before)
  },

  /**
   * Run a Spec Kit command and watch the session that runs it.
   *
   * The same gap as createSpec, one stage later and reported the same way: a
   * plan written by /speckit-plan sat on disk while the panel, loaded before the
   * command ran, went on saying "No plan.md content parsed". Every artefact
   * these commands write — plan.md, tasks.md, a resolved clarification — is read
   * by specs.state and specs.detail, so re-reading both while the command runs
   * is the whole fix.
   */
  async runSpecCommand(projectId: string, text: string, label: string): Promise<void> {
    const sessionId = await this.runInSession(projectId, text, true)
    this.watchSpecCommand(projectId, sessionId, label)
  },

  /**
   * Re-read spec state while a command runs, and stop when its session ends.
   *
   * Keyed on the SESSION rather than on a flat timeout, which is possible
   * because every Spec Kit command now takes a session of its own and that
   * session closes itself when its turn ends (SessionManager.NEVER_REUSED). The
   * ending is therefore the exact moment the command's files are final, and one
   * last read after it is what puts them on screen.
   *
   * `awaited` is the set of spec ids that existed before, present only for a
   * create: selecting the spec that just appeared is the one thing a create
   * wants beyond a refresh.
   */
  watchSpecCommand(
    projectId: string,
    sessionId: string,
    label: string,
    awaited?: ReadonlySet<string>,
  ): void {
    // Unconditional: one watch at a time, and a second command supersedes the
    // first rather than leaving its interval behind.
    this.stopScaffoldWatch()
    this.running = { projectId, label }
    let rounds = 0
    const reload = async (): Promise<boolean> => {
      try {
        this.byProject[projectId] = await invoke('specs.state', { projectId })
      } catch {
        return false // project gone or a transport hiccup — stop rather than spin
      }
      const fresh = awaited
        ? this.stateFor(projectId).specs.find((s) => !awaited.has(s.id))
        : undefined
      if (fresh) {
        await this.selectSpec(projectId, fresh.id)
      } else if (this.selectedSpecId) {
        // The command may have rewritten the spec it was given — plan.md,
        // tasks.md, an answered clarification all live in the detail.
        try {
          this.detail = await invoke('specs.detail', {
            projectId,
            specId: this.selectedSpecId,
          })
        } catch {
          return false
        }
      }
      return true
    }
    scaffoldTimer = setInterval(() => {
      void (async () => {
        rounds += 1
        // A newer watch (or a stop) took over: this round belongs to nobody.
        if (this.running?.projectId !== projectId) return
        if (!(await reload())) return this.stopScaffoldWatch()
        const fate = await invoke('sessions.fate', { sessionId }).catch(() => null)
        // A session the app has forgotten counts as ended: the alternative is
        // polling for ever over a session row that will never come back.
        if (!fate || fate.endedAt) {
          await reload() // the files are final only once the turn is over
          return this.stopScaffoldWatch()
        }
        // ponytail: a ceiling for a session that never ends — 2400 rounds is two
        // hours, past the longest implement run seen. The section still refreshes
        // on its next mount after that, which is the behaviour this replaced.
        if (rounds >= 2400) this.stopScaffoldWatch()
      })()
    }, 3000)
  },

  /** Stop the command watch, whichever project it belonged to. */
  stopScaffoldWatch(): void {
    if (scaffoldTimer) {
      clearInterval(scaffoldTimer)
      scaffoldTimer = null
    }
    this.running = null
  },

  /**
   * Start implementing a phase (or a whole spec): send the implement command,
   * then poll specs.detail so tasks visibly flip to done as they complete.
   */
  async startPhase(projectId: string, specId: string, text: string): Promise<void> {
    await this.selectSpec(projectId, specId)
    this.runningProjectId = projectId
    try {
      await this.runInSession(projectId, text, true)
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
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          this.byProject[projectId] = await invoke('specs.state', { projectId })
          if (this.selectedSpecId === specId) {
            this.detail = await invoke('specs.detail', { projectId, specId })
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
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
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

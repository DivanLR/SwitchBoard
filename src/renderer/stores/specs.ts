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
// The watch handle is machinery, not view state, so it stays out of the store,
// and so does the session each running command belongs to: a session id is not
// something a view renders, and keeping it here means one interval can serve
// every command in flight.
let watchTimer: ReturnType<typeof setInterval> | null = null
const watched = new Map<string, { sessionId: string; awaited?: ReadonlySet<string> }>()

/** The control that a create belongs to. Named because two places start one. */
export const NEW_SPEC_KEY = 'new-spec'

const busyKey = (projectId: string, key: string): string => `${projectId}|${key}`

const store = reactive({
  byProject: {} as Record<string, SpecKitState>,
  detail: null as SpecDetail | null,
  selectedSpecId: null as string | null,
  loading: false,
  installing: false,
  installError: null as string | null,
  /**
   * Spec Kit commands in flight, keyed by project and by the control that
   * started each one.
   *
   * A map rather than one slot because every command takes a session of its own
   * and several may run at once; a single slot would make the second click erase
   * the first button's state. `starting` is the window between the click and the
   * session existing, which on a containerised project is long enough to read as
   * a click that missed.
   */
  busy: {} as Record<
    string,
    {
      projectId: string
      key: string
      label: string
      phase: 'starting' | 'running'
      implement: boolean
      /** The session it runs in, once there is one. The section shows this
       *  session's tail, which is the only place a question it asks can be
       *  answered: the command has a session of its own and the conversation's
       *  composer does not address it. */
      sessionId?: string
    }
  >,

  stateFor(projectId: string): SpecKitState {
    return this.byProject[projectId] ?? { installed: false, specs: [] }
  },

  /** True when a phase is being implemented for the given project, which is
   *  what the "Implementing" chrome and the per-phase rows read. */
  isRunning(projectId: string): boolean {
    return Object.values(this.busy).some((b) => b.projectId === projectId && b.implement)
  },

  /** The commands in flight for this project that have a session to show. */
  runningIn(projectId: string): { key: string; label: string; sessionId: string }[] {
    return Object.values(this.busy)
      .filter((b) => b.projectId === projectId && b.sessionId)
      .map((b) => ({ key: b.key, label: b.label, sessionId: b.sessionId as string }))
  },

  /** Where one control has got to: null, waiting for its session, or running. */
  phaseOf(projectId: string, key: string): 'starting' | 'running' | null {
    return this.busy[busyKey(projectId, key)]?.phase ?? null
  },

  /** What to call whatever is in flight for this project, for the panel's own
   *  line. The first is enough: the controls each say their own state. It says
   *  starting while the session is being made, so the line cannot claim a run
   *  the control beside it is still waiting for. */
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
   * Create a spec: dispatch /speckit-specify and watch the session that runs it.
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
    await this.runSpecCommand(
      projectId,
      `/speckit-specify ${description}`,
      NEW_SPEC_KEY,
      'Scaffolding the spec',
      { awaited: before },
    )
  },

  /**
   * Start implementing a phase (or a whole spec).
   *
   * Nothing here polls any more: the same watch every other command uses
   * re-reads the spec each round, which is what made tasks tick off, and it now
   * stops on the session ending rather than on progress appearing to stall.
   */
  async startPhase(projectId: string, specId: string, text: string, key: string): Promise<void> {
    await this.selectSpec(projectId, specId)
    await this.runSpecCommand(projectId, text, key, 'Implementing', { implement: true })
  },

  /**
   * Run one Spec Kit command: dispatch it, then watch the session it runs in.
   *
   * `key` names the CONTROL that started it, so the panel can show that control
   * as starting and then as running while every other control stays live. Two
   * commands may be in flight at once — each has its own session, which is the
   * point — so the state is a map rather than a single slot.
   *
   * The two phases are worth separating on screen: starting a session takes a
   * moment (longer on a containerised project, where an image may have to come
   * up), and a button that does not change until the first output arrives reads
   * as a click that missed.
   */
  async runSpecCommand(
    projectId: string,
    text: string,
    key: string,
    label: string,
    opts: {
      /** Spec ids present before a create, so the one that appears is selected. */
      awaited?: ReadonlySet<string>
      /** Drives the "Implementing" chrome, which is about tasks rather than
       *  about any one control. */
      implement?: boolean
    } = {},
  ): Promise<void> {
    const k = busyKey(projectId, key)
    this.busy[k] = { projectId, key, label, phase: 'starting', implement: !!opts.implement }
    let sessionId: string
    try {
      sessionId = await this.runInSession(projectId, text, true)
    } catch (e) {
      // A dispatch that never started must not leave a control stuck mid-click.
      delete this.busy[k]
      throw e
    }
    this.busy[k] = { ...this.busy[k], phase: 'running', sessionId }
    watched.set(k, { sessionId, awaited: opts.awaited })
    this.startWatch()
  },

  /**
   * Re-read spec state while commands run, and drop each one when its own
   * session ends.
   *
   * Keyed on the SESSION rather than on a timeout, which is possible because
   * every Spec Kit command takes a session of its own and that session closes
   * itself when its turn ends (SessionManager.NEVER_REUSED). The ending is the
   * exact moment that command's files are final, and one last read after it is
   * what puts them on screen.
   *
   * One interval for all of them: the reads are per project, not per command, so
   * two commands running against one project cost one pair of reads a round.
   */
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
            // Project gone or a transport hiccup: drop its commands rather than
            // spin, and leave any other project's alone.
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
          // A session the app has forgotten counts as ended: the alternative is
          // polling for ever over a row that will never come back.
          if (!fate || fate.endedAt) {
            const projectId = this.busy[k]?.projectId
            this.finish(k)
            // The files are final only once the turn is over, so read once more.
            if (projectId) await this.reloadSpec(projectId)
          }
        }
        // ponytail: a ceiling for a session that never ends — 2400 rounds is two
        // hours, past the longest implement run seen. The section still refreshes
        // on its next mount after that, which is the behaviour this replaced.
        if (rounds >= 2400) this.stopSpecWatch()
      })()
    }, 3000)
  },

  /** Re-read a project's specs and, if one is selected, its detail. False when
   *  the read failed, which is the caller's signal to stop watching it. */
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
        watched.set(k, { sessionId: entry.sessionId }) // selected once, not every round
        await this.selectSpec(projectId, fresh.id)
        return true
      }
    }
    if (!this.selectedSpecId) return true
    try {
      // A command rewrites the spec it was given: plan.md, tasks.md and an
      // answered clarification all live in the detail.
      this.detail = await invoke('specs.detail', { projectId, specId: this.selectedSpecId })
    } catch {
      return false
    }
    return true
  },

  /** One command is over. */
  finish(k: string): void {
    delete this.busy[k]
    watched.delete(k)
    if (Object.keys(this.busy).length === 0) this.stopSpecWatch()
  },

  /** Stop watching everything. Clears the controls too, so nothing is left
   *  showing as running with nothing behind it. */
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

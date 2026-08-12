// T017: mock session host for Playwright. `installMockHost` is injected into
// the page via addInitScript BEFORE the renderer loads and implements the
// full `window.switchboard` surface from src/shared/ipc-types.ts, plus a
// `window.__mock` test-driver API for scripting sessions and permissions.
// The function must stay self-contained: it is serialised into the browser
// context, so it may not reference imports at runtime. Anything it needs from
// the real contract therefore arrives as scenario DATA, which is how the
// settings shape below stays tied to the app's own defaults instead of being a
// hand-copied duplicate that silently drifts.
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/domain'
import { detectStacks, type AvailableSuites } from '../../src/shared/test-catalog'
// Type-only, so nothing is referenced at runtime inside the serialised function.
// This is what keeps the mock's method table honest: see invokeHandlers below.
import type { InvokeMethod } from '../../src/shared/ipc-types'

export interface MockSessionSeed {
  id: string
  status: 'working' | 'needs_you' | 'done' | 'error'
  branch?: string
  startedAt?: string
  // No usage fields here: every spec that exercises the usage meter sets it at
  // runtime through __mock.setUsage(), so seed-time versions only ever resolved
  // to null. The runtime MockSession below still carries them.
  mcpServers?: { name: string; status: string }[]
  /** A bypass session runs inside the sandbox container, which ships node and
   *  nothing else — the Tests section reads this to say what cannot run there. */
  bypassPermissions?: boolean
  /** Started read-only, planning before acting. */
  planMode?: boolean
}

export interface MockProjectSeed {
  id: string
  name: string
  path: string
  session?: MockSessionSeed
  /** The reserved, project-less row backing the global Database MCP session. */
  reserved?: boolean
  /** The project's session mode. Omit for 'auto', which is what migration 022
   *  backfilled onto every project that predates the setting. */
  defaultSessionMode?: string
  /** Diff tab (specs/003-diff-tab) seed data — set at scenario construction so
   *  it is in place before the app's own initial load, rather than racing it
   *  the way a later __mock.setDiff() call would for a project already
   *  selected on page load. */
  diff?: { gitNotice: string | null; files: Record<string, unknown>[] }
}

export interface MockScenario {
  projects: MockProjectSeed[]
  /** Starting settings. Pass DEFAULT_SETTINGS so the mock cannot drift from the
   *  real defaults; override individual fields for a specific test. */
  settings: Settings
  /**
   * What `evals.suites` answers. Built from the real catalog by the scenario, for
   * the same reason `settings` is: the Tests section now takes its suite list from
   * this answer, so a hand-written subset here silently hides suites the real app
   * offers, and the tests would be asserting against the mock's imagination.
   *
   * Omit it only in a scenario that never opens the Tests section: the picker then
   * has nothing to offer, which is the honest answer for a project with no stack.
   */
  suites?: AvailableSuites[]
}

export interface MockDriver {
  /** What the next native folder pick answers; null is the cancel case. */
  setNextFolderPick: (path: string | null) => void
  emitEvent: (sessionId: string, kind: string, payload: Record<string, unknown>) => string
  setCommands: (
    projectId: string,
    commands: (string | { name: string; description?: string })[],
  ) => void
  endSession: (sessionId: string) => void
  setSpecKit: (projectId: string, state: Record<string, unknown>) => void
  /** Diff tab (specs/003-diff-tab): seeds what 'diff.list' answers for a
   *  project — there is no real git repo behind this in-browser mock. */
  setDiff: (projectId: string, result: { gitNotice: string | null; files: Record<string, unknown>[] }) => void
  /** Seeds what 'diff.file' answers for one path within a project. */
  setFileDiff: (projectId: string, path: string, content: Record<string, unknown>) => void
  setMcpSchema: (projectId: string, content: string, servers?: string[]) => void
  setUsage: (sessionId: string, utilization: number, resetsInMinutes: number, limitType: string) => void
  setAvailableModels: (models: { id: string; label: string; description: string }[]) => void
  setBackgroundTasks: (sessionId: string, tasks: { taskId: string; description: string }[]) => void
  emitLines: (sessionId: string, lines: string[]) => void
  raisePermission: (options: {
    projectId: string
    toolName?: string
    title: string
    explanation?: string
    detail?: string
    risk?: 'low' | 'medium' | 'high'
    type?: 'tool_permission' | 'plan_approval'
  }) => string
  askQuestion: (sessionId: string, text: string, options: string[]) => string
  completeTurn: (sessionId: string, costUsd?: number) => void
  setStatus: (sessionId: string, status: string) => void
  /** Stand in for the main process reading a check/judge marker off the session:
   *  writes the result onto the line and pushes it, like the real gate does. */
  reportEvalResult: (
    projectId: string,
    id: string,
    result: { checkStatus?: string; judge?: string },
  ) => void
  /** Stand in for the main process reading a verification report off the session:
   *  finishes the running run with that report and pushes it. */
  reportVerifyResult: (projectId: string, status: string, report: unknown) => void
  /** Finish the running API eval set the way the main process does: the app has
   *  made the calls, so the driver supplies the calls and the verdict. */
  reportApiResult: (
    projectId: string,
    status: string,
    calls: unknown[],
    note?: string | null,
  ) => void
  startFlood: (intervalMs: number, perTick: number) => void
  stopFlood: () => void
  state: () => {
    sends: { sessionId: string; text: string }[]
    interrupts: string[]
    answers: { eventId: string; choice: string }[]
    decisions: { requestId: string; decision: string }[]
    starts: {
      projectId: string
      deniedMcpServers?: string[]
      /** The one resolved mode the start asked for (request override or project default). */
      mode?: string
      bypassPermissions?: boolean
      planMode?: boolean
      /** Whether the start asked to resume the previous conversation. */
      resume?: boolean
      /** The session id whose transcript was carried in as context, if any. */
      carryTranscriptFrom?: string
    }[]
    /** Every live plan-mode switch asked for, in order. */
    planModeChanges: { sessionId: string; enabled: boolean }[]
  }
}

declare global {
  interface Window {
    __mock: MockDriver
  }
}

export function installMockHost(scenario: MockScenario): void {
  type AnyRecord = Record<string, unknown>

  interface MockSession {
    id: string
    projectId: string
    sdkSessionId: string | null
    status: string
    statusDetail: string | null
    branch: string | null
    diffAdds: number | null
    diffDels: number | null
    usageUtilization: number | null
    usageResetsAt: number | null
    usageLimitType: string | null
    bypassPermissions: boolean
    /** How it started (persisted in the real host) vs where it is now (in-memory). */
    planMode: boolean
    inPlanMode: boolean
    mcpServers: { name: string; status: string }[]
    startedAt: string
    endedAt: string | null
    endReason: string | null
  }

  interface MockRequest extends AnyRecord {
    id: string
    sessionId: string
    projectId: string
    type: string
    toolName: string | null
    title: string
    explanation: string
    detail: string
    risk: string
    status: string
    createdAt: string
    resolvedAt: string | null
    deliveryFailed: boolean
  }

  const now = (): string => new Date().toISOString()
  let idCounter = 0
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`

  // Diff tab (specs/003-diff-tab): seeded from the scenario, like mcpServers
  // above, or set later via __mock.setDiff/setFileDiff — there is no real
  // git repo behind this in-browser mock.
  const diffByProject = new Map<string, AnyRecord>()
  const fileDiffByProject = new Map<string, AnyRecord>()
  for (const p of scenario.projects) {
    if (p.diff) diffByProject.set(p.id, p.diff)
  }

  const sessions = new Map<string, MockSession>()
  /** Transcripts the mock has "written", newest first. Never touches disk. */
  let transcripts: AnyRecord[] = []
  const projects = scenario.projects.map((p) => {
    let session: MockSession | null = null
    if (p.session) {
      session = {
        id: p.session.id,
        projectId: p.id,
        sdkSessionId: `sdk-${p.session.id}`,
        status: p.session.status,
        statusDetail: null,
        branch: p.session.branch ?? 'main',
        diffAdds: 12,
        diffDels: 4,
        usageUtilization: null,
        usageResetsAt: null,
        usageLimitType: null,
        bypassPermissions: p.session.bypassPermissions ?? false,
        planMode: p.session.planMode ?? false,
        inPlanMode: p.session.planMode ?? false,
        mcpServers: p.session.mcpServers ?? [],
        startedAt: p.session.startedAt ?? now(),
        endedAt: null,
        endReason: null,
      }
      sessions.set(session.id, session)
    }
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      source: 'manual',
      createdAt: now(),
      archivedAt: null as string | null,
      refs: [] as { path: string; label: string }[],
      reserved: !!p.reserved,
      // NOT NULL with a DEFAULT of 'auto' in the real schema (migration 022), so a
      // scenario that says nothing gets what an existing project got.
      defaultSessionMode: p.defaultSessionMode ?? 'auto',
      session,
      // A project runs as many sessions as it is asked to. "session" stays the most
      // recently started one, which is what the real host's activeForProject returns
      // and what this file's own internal checks read; "sessions" is the whole list.
      sessions: session ? [session] : [],
    }
  })

  const eventsBySession = new Map<string, AnyRecord[]>()
  const seqBySession = new Map<string, number>()
  const pending: MockRequest[] = []
  const decisions: MockRequest[] = []
  const markerByRequest = new Map<string, AnyRecord>()
  const projectCommands = new Map<string, { name: string; description?: string }[]>()
  const specKitByProject = new Map<string, AnyRecord>()
  // Keyed by projectId (legacy single doc) or `projectId|comboKey` (per-combination).
  const mcpSchemaByProject = new Map<string, string>()
  const mcpScans: { id: string; projectId: string; comboKey: string; servers: string[]; scannedAt: string }[] = []
  // Models the "subscription" can select, as the real host reports them (it reads
  // them from the CLI). Drives the settings picker entirely — there is no
  // hardcoded catalogue behind it. A test can replace the set via
  // __mock.setAvailableModels to exercise a model release.
  let availableModels: { id: string; label: string; description: string }[] = [
    { id: 'claude-fable-5', label: 'Fable', description: 'Most capable for the hardest tasks' },
    { id: 'claude-opus-5[1m]', label: 'Opus (1M context)', description: 'Best for everyday, complex tasks' },
    { id: 'claude-sonnet-5', label: 'Sonnet', description: 'Efficient for routine tasks' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku', description: 'Fastest for quick answers' },
  ]
  const standingRules: AnyRecord[] = []
  let costToday = 0
  let tokensToday = 0

  const swallowRules: AnyRecord[] = [
    {
      id: 'sw-1',
      position: 0,
      eventKindMatcher: 'raw_output',
      pattern: '(Compiling|Building|Bundling|webpack|vite v|added \\d+ packages)',
      noiseKind: 'build output',
      enabled: true,
    },
    {
      id: 'sw-2',
      position: 1,
      eventKindMatcher: '*',
      pattern: '(\\d{1,3}\\s?%|Downloading|Installing)',
      noiseKind: 'progress',
      enabled: true,
    },
    {
      id: 'sw-3',
      position: 2,
      eventKindMatcher: 'tool_activity',
      pattern: '^(Read|Glob|Grep|LS)\\b',
      noiseKind: 'file inspection',
      enabled: true,
    },
  ]
  /**
   * The rules editor's data.
   *
   * A small representative set rather than the app's real shipped defaults, which
   * is the one place this file cannot follow its own no-hand-copied-data rule: the
   * defaults and the merge live in src/main, and tsconfig.web.json deliberately
   * keeps main-process code out of this project.
   *
   * The trade is sound because the split is clean. Which rules ship, and how an
   * override merges over them, is covered against the real code by
   * tests/unit/rule-prefs.spec.ts and rule-prefs-repo.spec.ts. What the e2e specs
   * need from here is only that the editor lists rows, toggles them, and adds and
   * removes a rule — behaviour that does not depend on which rules are real.
   */
  const rules: { risk: AnyRecord[]; swallow: AnyRecord[] } = {
    risk: [
      {
        id: 'builtin:bash-destructive',
        builtin: true,
        label: 'Destructive shell commands',
        toolMatcher: 'Bash',
        pattern: '\\b(rm|rmdir|del)\\b',
        risk: 'high',
        overridden: false,
        disabled: false,
      },
      {
        id: 'builtin:tool-read',
        builtin: true,
        label: 'Read a file',
        toolMatcher: 'Read',
        pattern: null,
        risk: 'low',
        overridden: false,
        disabled: false,
      },
    ],
    swallow: [
      {
        id: 'builtin:build-output',
        builtin: true,
        eventKindMatcher: 'raw_output',
        pattern: '(Compiling|Building)',
        noiseKind: 'build output',
        disabled: false,
      },
      {
        id: 'builtin:progress',
        builtin: true,
        eventKindMatcher: 'raw_output',
        pattern: '(Downloading|Installing)',
        noiseKind: 'progress',
        disabled: false,
      },
    ],
  }

  const rulesView = (): AnyRecord => ({
    risk: rules.risk.map((r) => ({ ...r })),
    swallow: rules.swallow.map((r) => ({ ...r })),
  })

  /** Mirrors the real host: a shipped rule resets, a custom rule is deleted. */
  const findRule = (id: string, kind: string): AnyRecord | undefined =>
    (kind === 'risk' ? rules.risk : rules.swallow).find((r) => r.id === id)

  // The real DEFAULT_SETTINGS, handed in as data by the scenario.
  let settings: AnyRecord = { ...(scenario.settings as unknown as AnyRecord) }
  /** API eval sets per project, newest first (mirrors verifyByProject). */
  const apiRunsByProject = new Map<string, AnyRecord[]>()

  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  function push(channel: string, payload: unknown): void {
    const set = listeners.get(channel)
    if (!set) return
    for (const listener of set) listener(payload)
  }

  const SWALLOWABLE = ['tool_activity', 'raw_output', 'assistant_text']
  function classify(kind: string, payload: AnyRecord): string | null {
    if (!SWALLOWABLE.includes(kind)) return null
    const text =
      kind === 'tool_activity'
        ? `${payload.toolName ?? ''} ${payload.inputPreview ?? ''} ${payload.resultPreview ?? ''}`
        : String(payload.text ?? '')
    for (const rule of swallowRules) {
      if (!rule.enabled) continue
      const matcher = String(rule.eventKindMatcher)
      if (matcher !== '*' && matcher !== kind) continue
      try {
        if (new RegExp(String(rule.pattern), 'im').test(text)) return String(rule.noiseKind)
      } catch {
        // Invalid pattern never matches.
      }
    }
    return null
  }

  function appendEvent(sessionId: string, kind: string, payload: AnyRecord): AnyRecord {
    const seq = (seqBySession.get(sessionId) ?? 0) + 1
    seqBySession.set(sessionId, seq)
    const event = {
      id: nextId('evt'),
      sessionId,
      seq,
      kind,
      payload,
      noiseKind: classify(kind, payload),
      createdAt: now(),
    }
    const list = eventsBySession.get(sessionId) ?? []
    list.push(event)
    eventsBySession.set(sessionId, list)
    push('push.event', event)
    return event
  }

  function updateEvent(sessionId: string, eventId: string, payload: AnyRecord): void {
    const list = eventsBySession.get(sessionId) ?? []
    const event = list.find((e) => e.id === eventId)
    if (!event) return
    event.payload = payload
    push('push.event', { ...event })
  }

  function counters(): AnyRecord {
    const all = [...sessions.values()].filter((s) => !s.endedAt)
    return {
      running: all.filter((s) => s.status === 'working').length,
      needsYou: all.filter((s) => s.status === 'needs_you').length,
      costTodayUsd: costToday,
      tokensToday: tokensToday,
    }
  }

  function pushCounters(): void {
    push('push.counters', counters())
  }

  function setStatus(sessionId: string, status: string, detail?: string): void {
    const session = sessions.get(sessionId)
    if (!session) return
    session.status = status
    session.statusDetail = detail ?? null
    push('push.sessionStatus', { ...session })
    pushCounters()
  }

  const sends: { sessionId: string; text: string }[] = []
  const interrupts: string[] = []
  const starts: {
    projectId: string
    deniedMcpServers?: string[]
    /** The one resolved mode the start asked for (request override or project default). */
    mode?: string
    bypassPermissions?: boolean
    planMode?: boolean
    /** Whether the start asked to resume the previous conversation. */
    resume?: boolean
    carryTranscriptFrom?: string
  }[] = []
  const planModeChanges: { sessionId: string; enabled: boolean }[] = []
  const answers: { eventId: string; choice: string }[] = []
  const decisionLog: { requestId: string; decision: string }[] = []
  const queuedBySession = new Map<string, { eventId: string; text: string }[]>()
  const taskQueueByProject = new Map<string, AnyRecord[]>()
  const evalsByProject = new Map<string, AnyRecord[]>()
  const verifyByProject = new Map<string, AnyRecord[]>()

  function deliver(sessionId: string, text: string): void {
    sends.push({ sessionId, text })
    appendEvent(sessionId, 'prompt', { text, pending: false })
    setStatus(sessionId, 'working')
  }

  // Runs the front-of-queue task when the project's session is live and idle
  // (mirrors SessionManager.maybeDrainQueue in the real host).
  function maybeDrainQueue(projectId: string): void {
    const list = taskQueueByProject.get(projectId) ?? []
    const project = projects.find((p) => p.id === projectId)
    const session = project?.session && !project.session.endedAt ? project.session : null
    if (!session || session.status !== 'done' || list.length === 0) return
    const next = list.shift() as AnyRecord
    push('push.queueChanged', { projectId, items: [...list] })
    deliver(session.id, String(next.text))
  }

  function resolveRequest(request: MockRequest, status: string): void {
    request.status = status
    request.resolvedAt = now()
    const index = pending.indexOf(request)
    if (index !== -1) pending.splice(index, 1)
    decisions.unshift(request)
    const marker = markerByRequest.get(request.id)
    if (marker) {
      const payload = { ...(marker.payload as AnyRecord), status }
      updateEvent(request.sessionId, String(marker.id), payload)
    }
    const stillBlocked = pending.some((p) => p.sessionId === request.sessionId)
    setStatus(request.sessionId, stillBlocked ? 'needs_you' : 'working')
    push('push.inboxChanged', { resolved: { requestId: request.id, status } })
    pushCounters()
  }

  function decide(requestId: string, decision: string, confirmHighRisk: boolean): AnyRecord {
    const request = pending.find((p) => p.id === requestId)
    if (!request) throw { code: 'NOT_FOUND', message: 'Permission request not found' }
    if (
      decision === 'approve' &&
      request.risk === 'high' &&
      request.type === 'tool_permission' &&
      !confirmHighRisk
    ) {
      throw { code: 'CONFIRM_REQUIRED', message: 'High-risk approval requires confirmation' }
    }
    decisionLog.push({ requestId, decision })
    resolveRequest(request, decision === 'approve' ? 'approved' : 'denied')
    // Approving an ExitPlanMode IS leaving plan mode, which is what the real
    // broker does through SessionManager.planExited. Denying keeps it, so the
    // model revises and proposes again.
    if (decision === 'approve' && request.type === 'plan_approval') {
      const session = sessions.get(String(request.sessionId))
      if (session?.inPlanMode) {
        session.inPlanMode = false
        push('push.sessionStatus', { ...session })
      }
    }
    return { delivered: true }
  }

  /**
   * Every real IPC method, checked by the compiler.
   *
   * Keyed on `InvokeMethod` rather than `string`: as a loose Record this table
   * could silently fall behind the real bridge, and it had — three methods the
   * app ships were missing entirely, so those flows had no e2e coverage at all
   * and nothing failed to say so. A method added to InvokeMap now breaks this
   * build until the mock answers it too.
   *
   * Responses stay `unknown` on purpose. The specs assert on rendered UI, so
   * pinning each mock's return shape to InvokeMap[M]['res'] would force every
   * fixture to spell out fields no assertion reads, for no extra safety.
   */
  /**
   * The Tests section's own session, mirroring SessionManager.testsSessionFor:
   * reuse whatever session the newest verify or API run recorded while it is
   * still alive, otherwise start a NEW one. Deliberately never the chat session
   * — the whole point of the production change is that a run does not queue
   * behind the developer's conversation, and a mock that quietly reused it would
   * leave the e2e suite exercising the behaviour that was removed.
   *
   * A plain function rather than an invoke handler: it is not an IPC endpoint,
   * and invokeHandlers is keyed to InvokeMap so it cannot hold one that is not.
   */
  async function testsSession(projectId: string): Promise<MockSession> {
    const ids = [
      verifyByProject.get(projectId)?.[0]?.sessionId,
      apiRunsByProject.get(projectId)?.[0]?.sessionId,
    ]
    for (const id of ids) {
      const existing = id ? sessions.get(String(id)) : undefined
      if (existing && !existing.endedAt) return existing
    }
    return (await invokeHandlers['sessions.start']({ projectId })) as MockSession
  }

  const invokeHandlers: Record<InvokeMethod, (req: AnyRecord) => unknown> = {
    'projects.list': () => ({
      projects: projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          ...p,
          reserved: !!p.reserved,
          // Mirrors handlers.ts's projectList exactly: every live session oldest
          // first, or the most recent ended one when the project is running nothing.
          ...(() => {
            const live = p.sessions.filter((s) => !s.endedAt)
            const latest = p.sessions[p.sessions.length - 1]
            const listed = live.length > 0 ? live : latest ? [latest] : []
            return {
              sessions: listed.map((s) => ({ ...s })),
              session: listed[0] ? { ...listed[0] } : null,
            }
          })(),
          drafts: [],
        })),
      counters: counters(),
    }),
    // The real picker is an OS dialogue Playwright cannot drive, so the test
    // says in advance what it returns. null is the cancel case.
    'dialog.pickFolder': () => ({ path: nextFolderPick }),
    'projects.register': (req) => {
      const path = String(req.path)
      if (path.includes('missing')) throw { code: 'INVALID_PATH', message: 'The folder does not exist' }
      const existing = projects.find((p) => p.path === path)
      if (existing) {
        // Mirrors the real host: an archived row is restored, an active one is a duplicate.
        if (!existing.archivedAt) throw { code: 'DUPLICATE', message: 'The folder is already registered' }
        existing.archivedAt = null
        // Mirrors discovery.ts: re-adding through the dialogue is a mode choice,
        // so a mode in the request wins over the archived row's own.
        if (req.defaultSessionMode) existing.defaultSessionMode = String(req.defaultSessionMode)
        return { ...existing, session: undefined }
      }
      const project = {
        id: nextId('proj'),
        name: String(req.name ?? path.split(/[\\/]/).pop()),
        path,
        source: 'manual',
        createdAt: now(),
        archivedAt: null as string | null,
        refs: [] as { path: string; label: string }[],
        reserved: false,
        // NOT NULL with a DEFAULT of 'auto' in the real schema (migration 022).
        defaultSessionMode: String(req.defaultSessionMode ?? 'auto'),
        session: null as MockSession | null,
        sessions: [] as MockSession[],
      }
      projects.push(project)
      return { ...project, session: undefined }
    },
    'projects.setSessionMode': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      project.defaultSessionMode = String(req.mode)
    },
    'projects.rename': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (project) project.name = String(req.name).trim()
    },
    // Same four refusals as the real host, in the same order (discovery.ts):
    // live session, missing folder, no change, another project's folder.
    'projects.repoint': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      if (project.session && !project.session.endedAt) {
        throw { code: 'ALREADY_ACTIVE', message: 'Stop the session before changing the folder' }
      }
      const path = String(req.path).trim()
      if (path.includes('missing')) {
        throw { code: 'INVALID_PATH', message: 'The folder does not exist' }
      }
      if (path === project.path) return { ...project, session: undefined }
      if (projects.some((p) => p.id !== project.id && p.path === path)) {
        throw { code: 'DUPLICATE', message: 'The folder is already registered' }
      }
      project.path = path
      return { ...project, session: undefined }
    },
    'projects.move': (req) => {
      const from = projects.findIndex((p) => p.id === req.projectId)
      if (from === -1) return
      const [item] = projects.splice(from, 1)
      const to = Math.max(0, Math.min(Number(req.toIndex), projects.length))
      projects.splice(to, 0, item)
    },
    'projects.refs.add': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      const target = String(req.target).trim()
      const named = projects.find(
        (p) => p.id !== project.id && (p.name === target || p.path === target),
      )
      if (!named && !/[\\/]/.test(target)) {
        throw { code: 'INVALID_PATH', message: 'The folder does not exist' }
      }
      const path = named ? named.path : target
      if (path === project.path) {
        throw { code: 'DUPLICATE', message: 'The project already reads its own folder' }
      }
      project.refs = project.refs.filter((r) => r.path !== path)
      project.refs.push({ path, label: named ? named.name : (path.split(/[\\/]/).pop() ?? path) })
      return [...project.refs]
    },
    'projects.refs.remove': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) return []
      project.refs = project.refs.filter((r) => r.path !== req.path)
      return [...project.refs]
    },
    'projects.archive': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (project?.session && !project.session.endedAt) {
        throw { code: 'ALREADY_ACTIVE', message: 'Stop the session before archiving the project' }
      }
      if (project) project.archivedAt = now()
    },
    'projects.commands': (req) => projectCommands.get(String(req.projectId)) ?? [],
    'specs.state': (req) =>
      specKitByProject.get(String(req.projectId)) ?? { installed: false, specs: [] },
    'specs.detail': (req) => {
      const state = specKitByProject.get(String(req.projectId)) as
        | { details?: Record<string, AnyRecord> }
        | undefined
      return state?.details?.[String(req.specId)] ?? null
    },
    'diff.list': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      if (!project.session || project.session.endedAt) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' }
      }
      return diffByProject.get(String(req.projectId)) ?? { gitNotice: null, files: [] }
    },
    'diff.file': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      if (!project.session || project.session.endedAt) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' }
      }
      return fileDiffByProject.get(`${String(req.projectId)}|${String(req.path)}`) ?? null
    },
    'specs.install': (req) => {
      const installed = {
        installed: true,
        specs: [{ id: '001-example', title: 'Example', status: 'draft', tasksTotal: 0, tasksDone: 0 }],
      }
      specKitByProject.set(String(req.projectId), installed)
      return installed
    },
    'mcp.readSchema': (req) => {
      const servers = req.servers as string[] | undefined
      const key = servers?.length
        ? `${String(req.projectId)}|${[...servers].sort().join(' + ')}`
        : String(req.projectId)
      return { content: mcpSchemaByProject.get(key) ?? null }
    },
    'mcp.scanHistory': (req) => mcpScans.filter((s) => s.projectId === String(req.projectId)),
    'mcp.recordScan': (req) => {
      const servers = [...(req.servers as string[])].sort()
      const comboKey = servers.join(' + ')
      // Mirror main: only record when the combination's doc exists.
      if (!mcpSchemaByProject.has(`${String(req.projectId)}|${comboKey}`)) return null
      let row = mcpScans.find((s) => s.projectId === String(req.projectId) && s.comboKey === comboKey)
      if (!row) {
        row = { id: `scan-${mcpScans.length + 1}`, projectId: String(req.projectId), comboKey, servers, scannedAt: '' }
        mcpScans.unshift(row)
      }
      row.scannedAt = new Date().toISOString()
      return row
    },
    'specs.runInSession': async (req) => {
      let session = [...sessions.values()].find(
        (s) => s.projectId === req.projectId && !s.endedAt,
      )
      // sessions.start is async (it simulates spawn latency), so this must await
      // it — the un-awaited Promise used to be cast straight to a session.
      if (!session) session = (await invokeHandlers['sessions.start']({ projectId: req.projectId })) as MockSession
      sends.push({ sessionId: session.id, text: String(req.text) })
      appendEvent(session.id, 'prompt', { text: String(req.text), pending: false })
      return { sessionId: session.id }
    },
    'updates.check': () => ({ status: 'none' }),
    'updates.install': () => undefined,
    'sessions.start': async (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      // No refusal here any more: starting a second session alongside a live one is
      // the point, and the real manager dropped the same guard.
      // A real start spawns the CLI (and builds a container for a bypass
      // session); the delay keeps the full-window waiting state observable
      // instead of resolving inside a single frame. Same reason as stop.
      await new Promise((resolve) => setTimeout(resolve, 250))
      // One resolved mode, exactly as the real manager does it: the request may
      // override for a single session, and otherwise the project's own setting
      // applies. The two session booleans are projections of that one value, so
      // bypass-and-plan-at-once is no longer expressible.
      const mode = String(req.mode ?? project.defaultSessionMode ?? 'auto')
      const planMode = mode === 'plan'
      starts.push({
        projectId: String(req.projectId),
        deniedMcpServers: req.deniedMcpServers as string[] | undefined,
        // Recorded so a test can assert which mode a start actually asked for.
        mode,
        bypassPermissions: mode === 'bypass',
        planMode,
        // Recorded so a test can prove Resume actually asked for a resume, rather
        // than that the switch merely looked on.
        resume: req.resume === true,
        // Recorded so a test can prove the previous session's transcript was
        // actually asked for, rather than that a toggle merely looked on.
        carryTranscriptFrom: req.carryTranscriptFrom as string | undefined,
      })
      const session: MockSession = {
        id: nextId('sess'),
        projectId: project.id,
        sdkSessionId: null,
        status: 'done',
        statusDetail: null,
        branch: 'main',
        diffAdds: null,
        diffDels: null,
        usageUtilization: null,
        usageResetsAt: null,
        usageLimitType: null,
        bypassPermissions: mode === 'bypass',
        planMode,
        inPlanMode: planMode,
        mcpServers: [],
        startedAt: now(),
        endedAt: null,
        endReason: null,
      }
      sessions.set(session.id, session)
      project.sessions.push(session)
      project.session = session
      pushCounters()
      return { ...session }
    },
    'sessions.stop': async (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'NOT_FOUND', message: 'Session not found' }
      // Real teardown takes a moment (SDK drain, container stop); the delay
      // keeps the UI's ending bar observable instead of resolving instantly.
      await new Promise((resolve) => setTimeout(resolve, 250))
      session.endedAt = now()
      session.endReason = 'stopped'
      setStatus(session.id, 'done')
    },
    'sessions.interrupt': (req) => {
      interrupts.push(String(req.sessionId))
      setStatus(String(req.sessionId), 'done')
      return { stillQueued: (queuedBySession.get(String(req.sessionId)) ?? []).length }
    },
    'sessions.setPlanMode': (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'SESSION_ENDED', message: 'Session has ended' }
      if (session.bypassPermissions) {
        throw {
          code: 'RULE_NOT_ALLOWED',
          message: 'A bypass session approves everything, so it has nothing to plan against.',
        }
      }
      planModeChanges.push({ sessionId: session.id, enabled: req.enabled === true })
      session.inPlanMode = req.enabled === true
      push('push.sessionStatus', { ...session })
    },
    'sessions.send': (req) => {
      const sessionId = String(req.sessionId)
      const session = sessions.get(sessionId)
      if (!session || session.endedAt) throw { code: 'SESSION_ENDED', message: 'Session has ended' }
      sends.push({ sessionId, text: String(req.text) })
      const queued = session.status === 'working'
      const event = appendEvent(sessionId, 'prompt', { text: String(req.text), pending: queued })
      if (queued) {
        const list = queuedBySession.get(sessionId) ?? []
        list.push({ eventId: String(event.id), text: String(req.text) })
        queuedBySession.set(sessionId, list)
      } else {
        setStatus(sessionId, 'working')
      }
      return { eventId: event.id, queued }
    },
    // Mirrors the real host including its refusal: once completeTurn has flushed
    // the queue the message has gone, and saying otherwise would let a spec pass
    // against behaviour the app does not have.
    'sessions.editQueued': (req) => {
      const sessionId = String(req.sessionId)
      const list = queuedBySession.get(sessionId) ?? []
      const at = list.findIndex((q) => q.eventId === req.eventId)
      if (at === -1) {
        throw {
          code: 'NOT_FOUND',
          message: 'That message has already been sent, so it can no longer be changed.',
        }
      }
      const text = String(req.text).trim()
      if (!text) {
        const [gone] = list.splice(at, 1)
        updateEvent(sessionId, gone.eventId, { text: gone.text, pending: false, withdrawn: true })
      } else {
        list[at] = { eventId: list[at].eventId, text }
        updateEvent(sessionId, list[at].eventId, { text, pending: true })
      }
      queuedBySession.set(sessionId, list)
    },
    'sessions.answerQuestion': (req) => {
      const sessionId = String(req.sessionId)
      const list = eventsBySession.get(sessionId) ?? []
      const event = list.find((e) => e.id === req.eventId)
      if (!event) throw { code: 'NOT_FOUND', message: 'Question not found' }
      const payload = event.payload as AnyRecord
      if (payload.answered) throw { code: 'NOT_FOUND', message: 'Already answered' }
      answers.push({ eventId: String(req.eventId), choice: String(req.choice) })
      updateEvent(sessionId, String(req.eventId), { ...payload, answered: true, answer: req.choice })
      setStatus(sessionId, 'working')
    },
    'sessions.events': (req) => [...(eventsBySession.get(String(req.sessionId)) ?? [])],
    // Transcripts: the real host writes a markdown file into the OS temp
    // directory, continuously and on demand. Here the file is only ever named,
    // never written — the app's contract is the summary it gets back and the list
    // it can offer, and a test that touched the real temp directory would leak.
    'transcripts.save': (req) => {
      const sessionId = String(req.sessionId)
      const session = sessions.get(sessionId)
      if (!session) throw { code: 'NOT_FOUND', message: 'Session not found' }
      const project = projects.find((p) => p.id === session.projectId)
      const own = eventsBySession.get(sessionId) ?? []
      const payloadOf = (e: AnyRecord): AnyRecord => (e.payload as AnyRecord | undefined) ?? {}
      const prompts = own.filter((e) => e.kind === 'prompt' && !payloadOf(e).pending)
      const replies = own.filter((e) => e.kind === 'assistant_text' || e.kind === 'summary')
      const savedAt = now()
      const summary = {
        sessionId,
        projectId: session.projectId,
        projectName: project?.name ?? session.projectId,
        savedAt,
        expiresAt: new Date(Date.parse(savedAt) + 12 * 60 * 60 * 1000).toISOString(),
        path: `/tmp/switchboard-transcripts/${sessionId}.md`,
        prompts: prompts.length,
        replies: replies.length,
        lastPrompt: prompts.length > 0 ? String(payloadOf(prompts[prompts.length - 1]).text ?? '') : null,
        digest: `Previous session on ${project?.name ?? session.projectId} (${sessionId}).`,
      }
      transcripts = [summary, ...transcripts.filter((t) => t.sessionId !== sessionId)]
      return { ...summary }
    },
    'transcripts.list': () => transcripts.map((t) => ({ ...t })),
    'sessions.promptHistory': (req) => {
      const seen = new Set<string>()
      const out: string[] = []
      // Iterate most-recent-first so the newest occurrence sets the order.
      for (let i = sends.length - 1; i >= 0; i -= 1) {
        const s = sends[i]
        const session = sessions.get(s.sessionId)
        if (!session || session.projectId !== req.projectId) continue
        if (seen.has(s.text)) continue
        seen.add(s.text)
        out.push(s.text)
      }
      return out
    },
    // Eval loop: newest first, and every mutation answers with the full list.
    'evals.list': (req) => [...(evalsByProject.get(String(req.projectId)) ?? [])],
    'evals.add': (req) => {
      const projectId = String(req.projectId)
      const acceptance = String(req.acceptance).trim()
      if (!acceptance) throw { code: 'INVALID_PATH', message: 'Write what is observably true when it works.' }
      const list = evalsByProject.get(projectId) ?? []
      list.unshift({
        id: nextId('eval'),
        projectId,
        acceptance,
        checkCmd: String(req.checkCmd ?? '').trim() || null,
        checkStatus: 'not_run',
        verdict: 'pending',
        rating: null,
        note: null,
        attempts: 1,
        judge: null,
        createdAt: now(),
      })
      evalsByProject.set(projectId, list)
      return [...list]
    },
    'evals.record': (req) => {
      const projectId = String(req.projectId)
      const list = evalsByProject.get(projectId) ?? []
      const row = list.find((r) => r.id === req.id)
      if (!row) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' }
      // The gate, same rule as the main process: no pass while the check has not.
      if (req.verdict === 'pass' && row.checkCmd && row.checkStatus !== 'pass') {
        throw { code: 'CONFIRM_REQUIRED', message: 'The check has not passed yet.' }
      }
      for (const key of ['checkStatus', 'verdict', 'rating', 'note', 'attempts'] as const) {
        if (req[key] !== undefined) row[key] = req[key] as never
      }
      return [...list]
    },
    // The real catalog's answer for this project, carried in as scenario data.
    'evals.suites': () =>
      (scenario.suites ?? []).map((stack) => ({ ...stack, suites: [...stack.suites] })),
    'evals.dispatch': async (req) => {
      const projectId = String(req.projectId)
      const list = evalsByProject.get(projectId) ?? []
      const row = list.find((r) => r.id === req.id)
      if (!row) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' }
      if (req.kind === 'check' && !row.checkCmd) {
        throw { code: 'INVALID_PATH', message: 'This line has no check — use the manual pass.' }
      }
      // The real prompts live in main; the mock records enough to assert intent.
      const text =
        req.kind === 'check'
          ? `Verify this acceptance line: "${row.acceptance}"\nRun exactly: ${row.checkCmd}\nEVAL_CHECK`
          : req.kind === 'attempts'
            ? `Acceptance line: "${row.acceptance}"\nProduce ${row.attempts} INDEPENDENT attempts, git worktree each`
            : `Judge the current diff against this acceptance line: "${row.acceptance}"\nEVAL_JUDGE`
      if (req.kind === 'check') row.checkStatus = 'not_run'
      if (req.kind === 'judge') row.judge = null
      const session = await testsSession(projectId)
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      return { sessionId: session.id, runs: [...list] }
    },
    'evals.remove': (req) => {
      const projectId = String(req.projectId)
      const list = (evalsByProject.get(projectId) ?? []).filter((r) => r.id !== req.id)
      evalsByProject.set(projectId, list)
      return [...list]
    },
    'verify.list': (req) => [...(verifyByProject.get(String(req.projectId)) ?? [])],
    // A run occupies the session and stays 'running' until the session reports —
    // exactly like the real host, where the report is read off session output.
    'verify.start': async (req) => {
      const projectId = String(req.projectId)
      const suiteIds = (req.suiteIds ?? []) as string[]
      if (suiteIds.length === 0) throw { code: 'INVALID_PATH', message: 'Choose at least one suite to run.' }
      const text = `Verify the working tree of this project.\n${suiteIds.join('\n')}\nSWB_VERIFY`
      // The Tests section's own session, not whichever one is open. Awaited
      // because starting one is async here exactly as it is in the real host.
      const session = await testsSession(projectId)
      const result = { sessionId: session.id }
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      const list = verifyByProject.get(projectId) ?? []
      list.unshift({
        id: `verify-${list.length + 1}`,
        projectId,
        stackId: String(req.stackId),
        sessionId: result.sessionId,
        branch: sessions.get(result.sessionId)?.branch ?? null,
        requested: suiteIds,
        status: 'running',
        report: null,
        note: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      })
      verifyByProject.set(projectId, list)
      return { sessionId: result.sessionId, runs: [...list] }
    },
    'verify.evidence': async (req) => {
      const projectId = String(req.projectId)
      const list = verifyByProject.get(projectId) ?? []
      if (list.length === 0) throw { code: 'NOT_FOUND', message: 'Run a verification pass first — evidence attaches to a run.' }
      // Back to the session that produced the run while it is alive, like the
      // real handler; otherwise a fresh tests session.
      const ran = list[0]?.sessionId ? sessions.get(String(list[0].sessionId)) : undefined
      const session =
        ran && !ran.endedAt ? ran : (await testsSession(projectId))
      const text = 'Capture evidence that the change in this working tree actually works.\nSWB_VERIFY'
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      return { sessionId: session.id, runs: [...list] }
    },
    // Cancelling closes the row the way the real host does: inconclusive, with a
    // note saying the developer stopped it. A finished run is left alone.
    'verify.cancel': (req) => {
      const projectId = String(req.projectId)
      const list = verifyByProject.get(projectId) ?? []
      const at = list.findIndex((r) => r.id === req.runId)
      if (at < 0) throw { code: 'NOT_FOUND', message: 'Run not found' }
      // Replaced, never mutated in place, for the reason reportVerifyResult below
      // states: the real host rebuilds the run from its row, and mutating here
      // hands the renderer an identity it already holds and hides a stale view.
      if (list[at].status === 'running') {
        list[at] = {
          ...list[at],
          status: 'inconclusive',
          note: 'You stopped this run before it reported, so nothing it measured is known.',
          finishedAt: new Date().toISOString(),
        }
        verifyByProject.set(projectId, list)
      }
      return [...list]
    },
    // The API eval set. The real host scans the project's source for routes and
    // then makes the calls itself; the mock supplies a fixed catalogue and leaves
    // a started run 'running', which is what the panel shows until the app's own
    // calls finish and arrive on push.apiChanged.
    'api.endpoints': () => ({
      endpoints: [
        { method: 'GET', template: '/api/customers', source: 'Api/CustomersController.cs:12' },
        { method: 'GET', template: '/api/customers/{id}', source: 'Api/CustomersController.cs:20' },
        { method: 'POST', template: '/api/customers/search', source: 'Api/CustomersController.cs:31' },
      ],
      recent: [{ method: 'GET', template: '/api/customers/{id}' }],
      filesRead: 42,
      truncated: false,
      host: {
        baseUrl: 'http://localhost:5057',
        startCmd: 'dotnet run --project "src/Sample.Api"',
        from: 'src/Sample.Api/Properties/launchSettings.json (profile https)',
        error: null,
      },
    }),
    'api.runs': (req) => [...(apiRunsByProject.get(String(req.projectId)) ?? [])],
    'api.cancel': (req) => {
      const projectId = String(req.projectId)
      const runs = apiRunsByProject.get(projectId) ?? []
      const at = runs.findIndex((r) => r.id === req.runId)
      if (at < 0) throw { code: 'NOT_FOUND', message: 'Run not found' }
      if (runs[at].status === 'running') {
        runs[at] = {
          ...runs[at],
          status: 'error',
          note: 'You stopped this run before it reported, so nothing it measured is known.',
          finishedAt: new Date().toISOString(),
        }
        apiRunsByProject.set(projectId, runs)
      }
      return [...runs]
    },
    // The real host writes a markdown file under .switchboard/reports and returns
    // its path. There is no filesystem here, so this reports the path it would
    // have written and refuses in the same two cases: no run, or one still going.
    'api.report': (req) => {
      const runs = apiRunsByProject.get(String(req.projectId)) ?? []
      const run = req.runId ? runs.find((r) => r.id === req.runId) : runs[0]
      if (!run) {
        throw {
          code: 'NOT_FOUND',
          message: 'Run an API eval set first — a report is written from a run.',
        }
      }
      if (run.status === 'running') {
        throw {
          code: 'INVALID_PATH',
          message: 'That run is still going. Its report is written once the calls are in.',
        }
      }
      return { path: `C:\\mock\\.switchboard\\reports\\api-${run.id}.md` }
    },
    'api.start': async (req) => {
      const projectId = String(req.projectId)
      const endpoints = (req.endpoints ?? []) as { method: string; template: string }[]
      if (endpoints.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Choose at least one endpoint to test.' }
      }
      // The Tests section's own session, shared with verification runs.
      const session = await testsSession(projectId)
      const result = { sessionId: session.id }
      const text = `Produce the request data for an automated API test.\n${endpoints
        .map((e) => `- ${e.method} ${e.template}`)
        .join('\n')}\nSWB_APIDATA`
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      const list = apiRunsByProject.get(projectId) ?? []
      list.unshift({
        id: `api-${list.length + 1}`,
        projectId,
        baseUrl: 'http://localhost:5057',
        launched: false,
        sessionId: result.sessionId,
        status: 'running',
        note: null,
        calls: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      })
      apiRunsByProject.set(projectId, list)
      return { sessionId: result.sessionId, runs: [...list] }
    },
    'api.setHost': (req) => {
      const base = { ...((settings.projectApiBase ?? {}) as AnyRecord) }
      const start = { ...((settings.projectApiStart ?? {}) as AnyRecord) }
      if (req.baseUrl !== undefined) {
        if (String(req.baseUrl).trim()) base[String(req.projectId)] = String(req.baseUrl).trim()
        else delete base[String(req.projectId)]
      }
      if (req.startCmd !== undefined) {
        if (String(req.startCmd).trim()) start[String(req.projectId)] = String(req.startCmd).trim()
        else delete start[String(req.projectId)]
      }
      settings = { ...settings, projectApiBase: base, projectApiStart: start }
      return { ...settings }
    },
    'queue.list': (req) => [...(taskQueueByProject.get(String(req.projectId)) ?? [])],
    'queue.add': (req) => {
      const projectId = String(req.projectId)
      const text = String(req.text).trim()
      const list = taskQueueByProject.get(projectId) ?? []
      if (text.length > 0) {
        list.push({
          id: nextId('task'),
          projectId,
          text,
          position: list.length + 1,
          createdAt: now(),
        })
        taskQueueByProject.set(projectId, list)
        push('push.queueChanged', { projectId, items: [...list] })
        maybeDrainQueue(projectId)
      }
      return [...(taskQueueByProject.get(projectId) ?? [])]
    },
    'queue.edit': (req) => {
      const projectId = String(req.projectId)
      const text = String(req.text).trim()
      const list = taskQueueByProject.get(projectId) ?? []
      // Empty text is a no-op, matching the real manager: an edit never deletes.
      if (text.length > 0) {
        const task = list.find((t) => t.id === req.id)
        if (task) task.text = text
      }
      taskQueueByProject.set(projectId, list)
      push('push.queueChanged', { projectId, items: [...list] })
      return [...list]
    },
    'queue.remove': (req) => {
      const projectId = String(req.projectId)
      const list = (taskQueueByProject.get(projectId) ?? []).filter((t) => t.id !== req.id)
      taskQueueByProject.set(projectId, list)
      push('push.queueChanged', { projectId, items: [...list] })
      return [...list]
    },
    'inbox.pending': () => [...pending],
    'inbox.decide': (req) =>
      decide(String(req.requestId), String(req.decision), Boolean(req.confirmHighRisk)),
    'inbox.alwaysAllow': (req) => {
      // History-based (design): a decided Bash entry creates a command rule.
      const request = decisions.find((d) => d.id === req.requestId)
      if (!request) throw { code: 'NOT_FOUND', message: 'Not found' }
      // Mirrors @shared/domain isDangerousCommand — inlined because this host is
      // serialised into the page (addInitScript), so it can't call an import.
      const dangerous = /\b(rm|rmdir|del|rd|format|mkfs|dd|sudo|doas)\b|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i
      if (
        request.type === 'plan_approval' ||
        request.toolName !== 'Bash' ||
        dangerous.test(String(request.detail ?? ''))
      ) {
        throw { code: 'RULE_NOT_ALLOWED', message: 'Not eligible' }
      }
      // Flag-aware two-token base, as the real host derives server-side.
      const words = String(request.detail ?? '').trim().split(/\s+/)
      const base = words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : (words[0] ?? '')
      if (!base) throw { code: 'RULE_NOT_ALLOWED', message: 'No command' }
      const rule = {
        id: nextId('rule'),
        projectId: request.projectId,
        toolName: 'Bash',
        matcher: { kind: 'command_prefix', value: base },
        createdFromRequestId: request.id,
        createdAt: now(),
        revokedAt: null,
      }
      standingRules.push(rule)
      return { rule }
    },
    'inbox.approveAlways': (req) => {
      // Pending-based: derive+insert the rule, then approve in one step.
      const request = pending.find((p) => p.id === req.requestId)
      if (!request) throw { code: 'NOT_FOUND', message: 'Not found' }
      const dangerous = /\b(rm|rmdir|del|rd|format|mkfs|dd|sudo|doas)\b|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i
      if (
        request.type !== 'tool_permission' ||
        request.toolName !== 'Bash' ||
        request.risk === 'high' ||
        dangerous.test(String(request.detail ?? ''))
      ) {
        throw { code: 'RULE_NOT_ALLOWED', message: 'Not eligible' }
      }
      const words = String(request.detail ?? '').trim().split(/\s+/)
      const base = words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : (words[0] ?? '')
      if (!base) throw { code: 'RULE_NOT_ALLOWED', message: 'No command' }
      const rule = {
        id: nextId('rule'),
        projectId: request.projectId,
        toolName: 'Bash',
        matcher: { kind: 'command_prefix', value: base },
        createdFromRequestId: request.id,
        createdAt: now(),
        revokedAt: null,
      }
      standingRules.push(rule)
      return { ...decide(String(req.requestId), 'approve', false), rule }
    },
    'inbox.deleteHistory': (req) => {
      const index = decisions.findIndex((d) => d.id === req.requestId)
      if (index !== -1) decisions.splice(index, 1)
    },
    'inbox.clearHistory': () => {
      decisions.length = 0
    },
    'inbox.approveAllForProject': (req) => {
      const group = pending.filter((p) => p.projectId === req.projectId)
      let approved = 0
      let skippedHighRisk = 0
      for (const item of group) {
        if (item.risk === 'high' && item.type === 'tool_permission') {
          skippedHighRisk += 1
        } else {
          decide(item.id, 'approve', false)
          approved += 1
        }
      }
      return { approved, skippedHighRisk }
    },
    'inbox.history': (req) =>
      decisions.filter((d) => !req?.projectId || d.projectId === req.projectId),
    'rules.list': () => rulesView(),
    'rules.setDisabled': (req) => {
      const rule = findRule(String(req.id), String(req.kind))
      if (rule) rule.disabled = Boolean(req.disabled)
      return rulesView()
    },
    'rules.setRisk': (req) => {
      const rule = findRule(String(req.id), 'risk')
      if (rule) {
        // null restores the shipped level; the mock has no separate copy of it, so
        // it only clears the marker the editor reads.
        rule.risk = req.risk === null ? rule.risk : String(req.risk)
        rule.overridden = req.risk !== null
      }
      return rulesView()
    },
    'rules.addRisk': (req) => {
      const toolMatcher = String(req.toolMatcher).trim()
      if (!toolMatcher) throw { code: 'INVALID_PATH', message: 'Name a tool, or * for every tool' }
      const pattern = req.pattern ? String(req.pattern).trim() : null
      rules.risk.unshift({
        id: nextId('rule'),
        builtin: false,
        label: `${toolMatcher}${pattern ? ` matching ${pattern}` : ''}`,
        toolMatcher,
        pattern,
        risk: String(req.risk),
        overridden: false,
        disabled: false,
      })
      return rulesView()
    },
    'rules.addSwallow': (req) => {
      const pattern = String(req.pattern).trim()
      const noiseKind = String(req.noiseKind).trim()
      if (!pattern) throw { code: 'INVALID_PATH', message: 'Enter a pattern' }
      if (!noiseKind) {
        throw { code: 'INVALID_PATH', message: 'Name what this hides, e.g. "build output"' }
      }
      rules.swallow.unshift({
        id: nextId('rule'),
        builtin: false,
        eventKindMatcher: String(req.eventKindMatcher),
        pattern,
        noiseKind,
        disabled: false,
      })
      return rulesView()
    },
    'rules.remove': (req) => {
      const id = String(req.id)
      const list = String(req.kind) === 'risk' ? rules.risk : rules.swallow
      const at = list.findIndex((r) => r.id === id)
      if (at !== -1) {
        // A shipped rule cannot be deleted, only reset: clear its override markers.
        if (list[at].builtin) {
          list[at].disabled = false
          list[at].overridden = false
        } else {
          list.splice(at, 1)
        }
      }
      return rulesView()
    },
    'rules.standing.list': (req) =>
      standingRules.filter((r) => r.projectId === req.projectId && (req.includeRevoked || !r.revokedAt)),
    'rules.standing.revoke': (req) => {
      const rule = standingRules.find((r) => r.id === req.ruleId)
      if (rule) rule.revokedAt = now()
    },
    'rules.standing.restore': (req) => {
      const rule = standingRules.find((r) => r.id === req.ruleId)
      if (rule) rule.revokedAt = null
    },
    'rules.standing.add': (req) => {
      const rule = {
        id: nextId('rule'),
        projectId: String(req.projectId),
        toolName: 'Bash',
        matcher: { kind: 'command_prefix', value: String(req.pattern).trim() },
        createdFromRequestId: 'manual',
        createdAt: now(),
        revokedAt: null as string | null,
      }
      standingRules.push(rule)
      return { ...rule }
    },
    // The rules.* editing channels are above. `swallowRules` here is separate and
    // stays: classify() reads it to drive the clean-view behaviour the other specs
    // assert on, which is about how tagged output renders rather than about which
    // rules did the tagging.
    'settings.get': () => ({ ...settings }),
    'settings.set': (req) => {
      settings = { ...settings, ...req }
      return { ...settings }
    },
    // The real host probes the CLI for this list; the panel renders it as-is.
    'models.available': () => availableModels,
  }

  window.switchboard = {
    invoke: (method: string, req: unknown) => {
      const handler = invokeHandlers[method as InvokeMethod]
      if (!handler) return Promise.reject({ code: 'NOT_FOUND', message: `Unknown method ${method}` })
      // The real boundary is structuredClone, and it rejects a Proxy — which is
      // what Vue wraps every array and object in. A store handing its own
      // reactive state to invoke fails with "An object could not be cloned",
      // naming neither the field nor the call. Cloning here holds every renderer
      // call in the whole suite to the same rule the packaged app enforces,
      // rather than letting the mock accept what Electron would reject.
      let cloned: unknown
      try {
        cloned = structuredClone(req ?? {})
      } catch {
        return Promise.reject({
          code: 'INTERNAL',
          message:
            `An object could not be cloned. ${method} was called with reactive state; ` +
            'renderer code must go through invoke() in src/renderer/ipc.ts.',
        })
      }
      try {
        return Promise.resolve(handler(cloned as AnyRecord) ?? null)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
  } as unknown as typeof window.switchboard

  let floodTimer: number | null = null
  let nextFolderPick: string | null = null

  window.__mock = {
    setNextFolderPick: (path) => {
      nextFolderPick = path
    },
    emitEvent: (sessionId, kind, payload) => String(appendEvent(sessionId, kind, payload).id),
    setCommands: (projectId, commands) => {
      // Mirrors the real host: a session's init message stores the commands AND
      // pushes them so a live composer picks them up without a project switch.
      // String entries mirror description-less init names.
      const shaped = commands.map((c) => (typeof c === 'string' ? { name: c } : c))
      projectCommands.set(projectId, shaped)
      push('push.projectCommands', { projectId, commands: shaped })
    },
    setAvailableModels: (models) => {
      availableModels = models
    },
    setSpecKit: (projectId, state) => specKitByProject.set(projectId, state),
    setDiff: (projectId, result) => diffByProject.set(projectId, result),
    setFileDiff: (projectId, path, content) => fileDiffByProject.set(`${projectId}|${path}`, content),
    setMcpSchema: (projectId, content, servers) =>
      mcpSchemaByProject.set(
        servers?.length ? `${projectId}|${[...servers].sort().join(' + ')}` : projectId,
        content,
      ),
    setUsage: (sessionId, utilization, resetsInMinutes, limitType) => {
      const s = sessions.get(sessionId)
      if (!s) return
      s.usageUtilization = utilization
      s.usageResetsAt = Math.floor(Date.now() / 1000) + resetsInMinutes * 60
      s.usageLimitType = limitType
      push('push.sessionStatus', { ...s })
    },
    setBackgroundTasks: (sessionId, tasks) => {
      const s = sessions.get(sessionId)
      if (!s) return
      ;(s as unknown as AnyRecord).backgroundTasks = tasks
      push('push.sessionStatus', { ...s })
    },
    endSession: (sessionId) => {
      const s = sessions.get(sessionId)
      if (s) {
        s.endedAt = now()
        s.endReason = 'stopped'
        setStatus(sessionId, 'done')
      }
    },
    emitLines: (sessionId, lines) => {
      for (const line of lines) appendEvent(sessionId, 'raw_output', { text: line })
    },
    raisePermission: (options) => {
      const project = projects.find((p) => p.id === options.projectId)
      const sessionId = project?.session?.id ?? ''
      const request: MockRequest = {
        id: nextId('req'),
        sessionId,
        projectId: options.projectId,
        type: options.type ?? 'tool_permission',
        toolName: options.toolName ?? 'Bash',
        title: options.title,
        explanation: options.explanation ?? 'The session wants to run a command.',
        detail: options.detail ?? options.title,
        risk: options.risk ?? 'medium',
        status: 'pending',
        createdAt: now(),
        resolvedAt: null,
        deliveryFailed: false,
      }
      pending.push(request)
      const markerKind = request.type === 'plan_approval' ? 'plan_marker' : 'permission_marker'
      const marker = appendEvent(sessionId, markerKind, {
        requestId: request.id,
        title: request.title,
        risk: request.risk,
        status: 'pending',
        toolName: request.toolName,
      })
      markerByRequest.set(request.id, marker)
      setStatus(sessionId, 'needs_you')
      push('push.inboxChanged', { added: { ...request } })
      pushCounters()
      return request.id
    },
    askQuestion: (sessionId, text, options) => {
      const event = appendEvent(sessionId, 'question', {
        text,
        options: options.map((label) => ({ label })),
        answered: false,
      })
      setStatus(sessionId, 'needs_you')
      return String(event.id)
    },
    completeTurn: (sessionId, costUsd = 0.01) => {
      costToday += costUsd
      tokensToday += 140
      appendEvent(sessionId, 'result', {
        totalCostUsd: costUsd,
        usage: { inputTokens: 100, outputTokens: 40 },
        durationMs: 1200,
      })
      // Deliver queued composer messages (FR-019).
      const queue = queuedBySession.get(sessionId) ?? []
      const hadComposerQueue = queue.length > 0
      for (const item of queue.splice(0)) {
        updateEvent(sessionId, item.eventId, { text: item.text, pending: false })
      }
      setStatus(sessionId, 'done')
      pushCounters()
      // A turn that left the session idle pulls the next planned task (FR-023).
      const session = sessions.get(sessionId)
      if (!hadComposerQueue && session) maybeDrainQueue(session.projectId)
    },
    setStatus: (sessionId, status) => setStatus(sessionId, status),
    reportEvalResult: (projectId, id, result) => {
      const list = evalsByProject.get(projectId) ?? []
      const row = list.find((r) => r.id === id)
      if (!row) return
      if (result.checkStatus !== undefined) row.checkStatus = result.checkStatus
      if (result.judge !== undefined) row.judge = result.judge
      push('push.evalsChanged', { projectId, runs: [...list] })
    },
    reportVerifyResult: (projectId, status, report) => {
      const list = verifyByProject.get(projectId) ?? []
      const index = list.findIndex((r) => r.status === 'running')
      const at = index >= 0 ? index : 0
      if (!list[at]) return
      // Replaced, never mutated in place: the real host rebuilds each run from
      // its SQLite row, so every push carries fresh objects. Mutating here would
      // hand the renderer the identity it already holds and hide a stale view.
      list[at] = { ...list[at], status, report, finishedAt: new Date().toISOString() }
      verifyByProject.set(projectId, list)
      push('push.verifyChanged', { projectId, runs: [...list] })
    },
    reportApiResult: (projectId, status, calls, note) => {
      const list = apiRunsByProject.get(projectId) ?? []
      const index = list.findIndex((r) => r.status === 'running')
      const at = index >= 0 ? index : 0
      if (!list[at]) return
      list[at] = {
        ...list[at],
        status,
        calls,
        note: note ?? null,
        finishedAt: new Date().toISOString(),
      }
      apiRunsByProject.set(projectId, list)
      push('push.apiChanged', { projectId, runs: [...list] })
    },
    startFlood: (intervalMs, perTick) => {
      const ids = [...sessions.keys()]
      floodTimer = window.setInterval(() => {
        for (const sessionId of ids) {
          for (let i = 0; i < perTick; i += 1) {
            appendEvent(sessionId, 'raw_output', { text: `Compiling flood line ${Math.random()}` })
          }
        }
      }, intervalMs)
    },
    stopFlood: () => {
      if (floodTimer !== null) window.clearInterval(floodTimer)
      floodTimer = null
    },
    state: () => ({
      sends: [...sends],
      interrupts: [...interrupts],
      answers: [...answers],
      decisions: [...decisionLog],
      starts: [...starts],
      planModeChanges: [...planModeChanges],
    }),
  }
}

/** Convenience: a two-project scenario used by several specs. */
export function twoProjectScenario(): MockScenario {
  return {
    settings: DEFAULT_SETTINGS,
    // A node project, detected by the real catalog rather than described here, so
    // the picker shows exactly the suites the real app would offer.
    suites: detectStacks(['package.json']),
    projects: [
      {
        id: 'p-alpha',
        name: 'alpha',
        path: 'C:\\work\\alpha',
        session: {
          id: 's-alpha',
          status: 'working',
          branch: 'main',
          mcpServers: [
            { name: 'postgres — production', status: 'connected' },
            { name: 'github', status: 'connected' },
            { name: 'filesystem', status: 'connected' },
            { name: 'playwright', status: 'connected' },
            { name: 'context7', status: 'connected' },
          ],
        },
      },
      {
        id: 'p-beta',
        name: 'beta',
        path: 'C:\\work\\beta',
        session: { id: 's-beta', status: 'working', branch: 'feature/x' },
      },
    ],
  }
}

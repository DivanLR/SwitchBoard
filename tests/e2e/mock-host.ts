// T017: mock session host for Playwright. `installMockHost` is injected into
// the page via addInitScript BEFORE the renderer loads and implements the
// full `window.switchboard` surface from src/shared/ipc-types.ts, plus a
// `window.__mock` test-driver API for scripting sessions and permissions.
// The function must stay self-contained: it is serialised into the browser
// context, so it may not reference imports at runtime.
import type { SessionEvent } from '../../src/shared/domain'

export interface MockSessionSeed {
  id: string
  status: 'working' | 'needs_you' | 'done' | 'error'
  branch?: string
  startedAt?: string
}

export interface MockProjectSeed {
  id: string
  name: string
  path: string
  session?: MockSessionSeed
}

export interface MockScenario {
  projects: MockProjectSeed[]
  suggestions?: { path: string; name: string }[]
}

export interface MockDriver {
  emitEvent: (sessionId: string, kind: string, payload: Record<string, unknown>) => string
  setCommands: (projectId: string, commands: string[]) => void
  endSession: (sessionId: string) => void
  setSpecKit: (projectId: string, state: Record<string, unknown>) => void
  setUsage: (sessionId: string, utilization: number, resetsInMinutes: number, limitType: string) => void
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
  startFlood: (intervalMs: number, perTick: number) => void
  stopFlood: () => void
  state: () => {
    sends: { sessionId: string; text: string }[]
    interrupts: string[]
    answers: { eventId: string; choice: string }[]
    decisions: { requestId: string; decision: string }[]
    eventCounts: Record<string, number>
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

  const sessions = new Map<string, MockSession>()
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
      session,
    }
  })

  const eventsBySession = new Map<string, AnyRecord[]>()
  const seqBySession = new Map<string, number>()
  const pending: MockRequest[] = []
  const decisions: MockRequest[] = []
  const markerByRequest = new Map<string, AnyRecord>()
  const projectCommands = new Map<string, string[]>()
  const specKitByProject = new Map<string, AnyRecord>()
  const standingRules: AnyRecord[] = []
  let costToday = 0
  let tokensToday = 0

  const swallowRules: AnyRecord[] = [
    {
      id: 'sw-1',
      scope: 'global',
      projectId: null,
      position: 0,
      eventKindMatcher: 'raw_output',
      pattern: '(Compiling|Building|Bundling|webpack|vite v|added \\d+ packages)',
      noiseKind: 'build output',
      enabled: true,
    },
    {
      id: 'sw-2',
      scope: 'global',
      projectId: null,
      position: 1,
      eventKindMatcher: '*',
      pattern: '(\\d{1,3}\\s?%|Downloading|Installing)',
      noiseKind: 'progress',
      enabled: true,
    },
    {
      id: 'sw-3',
      scope: 'global',
      projectId: null,
      position: 2,
      eventKindMatcher: 'tool_activity',
      pattern: '^(Read|Glob|Grep|LS)\\b',
      noiseKind: 'file inspection',
      enabled: true,
    },
  ]
  const riskRules: AnyRecord[] = [
    {
      id: 'rr-1',
      scope: 'global',
      position: 0,
      toolMatcher: 'Read',
      inputMatcher: null,
      risk: 'low',
      builtin: true,
    },
  ]
  let settings: AnyRecord = {
    defaultView: 'clean',
    notificationsEnabled: true,
    retentionDecisionDays: 30,
    retentionSessionsPerProject: 2,
    lastFocusedProjectId: null,
  }

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
      pendingInbox: pending.length,
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
    push('push.sessionStatus', {
      sessionId,
      projectId: session.projectId,
      status,
      statusDetail: session.statusDetail,
      branch: session.branch,
      endedAt: session.endedAt,
      endReason: session.endReason,
    })
    pushCounters()
  }

  const sends: { sessionId: string; text: string }[] = []
  const interrupts: string[] = []
  const answers: { eventId: string; choice: string }[] = []
  const decisionLog: { requestId: string; decision: string }[] = []
  const queuedBySession = new Map<string, { eventId: string; text: string }[]>()

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
    return { delivered: true }
  }

  const invokeHandlers: Record<string, (req: AnyRecord) => unknown> = {
    'projects.list': () => ({
      projects: projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({ ...p, session: p.session ? { ...p.session } : null, drafts: [] })),
      counters: counters(),
    }),
    'projects.suggestions': () => scenario.suggestions ?? [],
    'projects.register': (req) => {
      const path = String(req.path)
      if (path.includes('missing')) throw { code: 'INVALID_PATH', message: 'The folder does not exist' }
      if (projects.some((p) => p.path === path)) {
        throw { code: 'DUPLICATE', message: 'The folder is already registered' }
      }
      const project = {
        id: nextId('proj'),
        name: String(req.name ?? path.split(/[\\/]/).pop()),
        path,
        source: 'manual',
        createdAt: now(),
        archivedAt: null as string | null,
        session: null,
      }
      projects.push(project)
      return { ...project, session: undefined }
    },
    'projects.rename': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (project) project.name = String(req.name).trim()
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
    'specs.install': (req) => {
      const installed = {
        installed: true,
        specs: [{ id: '001-example', title: 'Example', status: 'draft', tasksTotal: 0, tasksDone: 0 }],
      }
      specKitByProject.set(String(req.projectId), installed)
      return installed
    },
    'sessions.start': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      if (project.session && !project.session.endedAt) {
        throw { code: 'ALREADY_ACTIVE', message: 'Already active' }
      }
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
        startedAt: now(),
        endedAt: null,
        endReason: null,
      }
      sessions.set(session.id, session)
      project.session = session
      pushCounters()
      return { ...session }
    },
    'sessions.stop': (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'NOT_FOUND', message: 'Session not found' }
      session.endedAt = now()
      session.endReason = 'stopped'
      setStatus(session.id, 'done')
    },
    'sessions.interrupt': (req) => {
      interrupts.push(String(req.sessionId))
      setStatus(String(req.sessionId), 'done')
      return { stillQueued: (queuedBySession.get(String(req.sessionId)) ?? []).length }
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
    'inbox.pending': () => [...pending],
    'inbox.decide': (req) =>
      decide(String(req.requestId), String(req.decision), Boolean(req.confirmHighRisk)),
    'inbox.alwaysAllow': (req) => {
      const request = pending.find((p) => p.id === req.requestId)
      if (!request) throw { code: 'NOT_FOUND', message: 'Not found' }
      if (request.risk === 'high' || request.type === 'plan_approval') {
        throw { code: 'RULE_NOT_ALLOWED', message: 'Not eligible' }
      }
      const rule = {
        id: nextId('rule'),
        projectId: request.projectId,
        toolName: request.toolName ?? '',
        matcher: req.matcher,
        createdFromRequestId: request.id,
        createdAt: now(),
        revokedAt: null,
      }
      standingRules.push(rule)
      decide(String(req.requestId), 'approve', false)
      return { rule }
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
    'rules.standing.list': (req) =>
      standingRules.filter((r) => r.projectId === req.projectId && !r.revokedAt),
    'rules.standing.revoke': (req) => {
      const rule = standingRules.find((r) => r.id === req.ruleId)
      if (rule) rule.revokedAt = now()
    },
    'rules.risk.list': () => [...riskRules],
    'rules.risk.save': (req) => {
      riskRules.splice(0, riskRules.length, ...(req.rules as AnyRecord[]))
      return [...riskRules]
    },
    'rules.risk.restoreDefaults': () => [...riskRules],
    'rules.swallow.list': () => [...swallowRules],
    'rules.swallow.save': (req) => {
      swallowRules.splice(0, swallowRules.length, ...(req.rules as AnyRecord[]))
      return [...swallowRules]
    },
    'rules.swallow.restoreDefaults': () => [...swallowRules],
    'settings.get': () => ({ ...settings }),
    'settings.set': (req) => {
      settings = { ...settings, ...req }
      return { ...settings }
    },
  }

  window.switchboard = {
    invoke: (method: string, req: unknown) => {
      const handler = invokeHandlers[method]
      if (!handler) return Promise.reject({ code: 'NOT_FOUND', message: `Unknown method ${method}` })
      try {
        return Promise.resolve(handler((req ?? {}) as AnyRecord) ?? null)
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

  window.__mock = {
    emitEvent: (sessionId, kind, payload) => String(appendEvent(sessionId, kind, payload).id),
    setCommands: (projectId, commands) => projectCommands.set(projectId, commands),
    setSpecKit: (projectId, state) => specKitByProject.set(projectId, state),
    setUsage: (sessionId, utilization, resetsInMinutes, limitType) => {
      const s = sessions.get(sessionId)
      if (!s) return
      s.usageUtilization = utilization
      s.usageResetsAt = Math.floor(Date.now() / 1000) + resetsInMinutes * 60
      s.usageLimitType = limitType
      push('push.sessionStatus', {
        sessionId,
        projectId: s.projectId,
        status: s.status,
        usageUtilization: utilization,
        usageResetsAt: s.usageResetsAt,
        usageLimitType: limitType,
      })
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
      for (const item of queue.splice(0)) {
        updateEvent(sessionId, item.eventId, { text: item.text, pending: false })
      }
      setStatus(sessionId, 'done')
      pushCounters()
    },
    setStatus: (sessionId, status) => setStatus(sessionId, status),
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
      eventCounts: Object.fromEntries(
        [...eventsBySession.entries()].map(([id, list]) => [id, list.length]),
      ),
    }),
  }
}

/** Convenience: a two-project scenario used by several specs. */
export function twoProjectScenario(): MockScenario {
  return {
    projects: [
      {
        id: 'p-alpha',
        name: 'alpha',
        path: 'C:\\work\\alpha',
        session: { id: 's-alpha', status: 'working', branch: 'main' },
      },
      {
        id: 'p-beta',
        name: 'beta',
        path: 'C:\\work\\beta',
        session: { id: 's-beta', status: 'working', branch: 'feature/x' },
      },
    ],
    suggestions: [{ path: 'C:\\work\\gamma', name: 'gamma' }],
  }
}

// Type-only usage keeps the SessionEvent import from being dead code in strict builds.
export type MockEvent = SessionEvent

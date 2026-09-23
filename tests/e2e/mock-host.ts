import {
  DEFAULT_SETTINGS,
  type DiagramEntry,
  type SectionKind,
  type Settings,
} from '../../src/shared/domain'
import { detectStacks, type AvailableSuites } from '../../src/shared/test-catalog'
import type { InvokeMethod } from '../../src/shared/ipc-types'

export interface MockSessionSeed {
  id: string
  status: 'working' | 'needs_you' | 'done' | 'error'
  branch?: string
  startedAt?: string
  mcpServers?: { name: string; status: string }[]
  planMode?: boolean
}

export interface MockProjectSeed {
  drafts?: string[]
  id: string
  name: string
  path: string
  session?: MockSessionSeed
  reserved?: boolean
  defaultSessionMode?: string
  diff?: { gitNotice: string | null; files: Record<string, unknown>[] }
}

export interface MockScenario {
  projects: MockProjectSeed[]
  skills?: string[]
  settings: Settings
  suites?: AvailableSuites[]
}

export interface MockDriver {
  setDrafts: (projectId: string, texts: string[]) => void
  setNextFolderPick: (path: string | null) => void
  setNextFilePick: (path: string | null) => void
  emitEvent: (sessionId: string, kind: string, payload: Record<string, unknown>) => string
  updateEvent: (sessionId: string, eventId: string, payload: Record<string, unknown>) => void
  focusSession: (sessionId: string) => void
  setCommands: (
    projectId: string,
    commands: (string | { name: string; description?: string })[],
  ) => void
  endSession: (sessionId: string) => void
  crashSession: (sessionId: string, detail: string) => void
  setSpecKit: (projectId: string, state: Record<string, unknown>) => void
  setStartDelay: (ms: number) => void
  setDiff: (projectId: string, result: { gitNotice: string | null; files: Record<string, unknown>[] }) => void
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
  reportVerifyResult: (projectId: string, status: string, report: unknown) => void
  setAdoFeatures: (features: { id: string; title: string; state?: string | null }[]) => void
  setAdoConnected: (on: boolean) => void
  reportFlowStage: (
    runId: string,
    stage: string,
    patch: { status?: string; summary?: string; report?: Record<string, unknown> },
  ) => void
  askFlowQuestion: (runId: string, text: string, options: string[]) => string
  reportFlowVerify: (runId: string, report: Record<string, unknown> | null) => void
  reportFlowShip: (runId: string, prUrl: string, prId: string) => void
  setFlowStacks: (projectId: string, stacks: string[]) => void
  addDiagram: (projectId: string, entry: DiagramEntry) => void
  startFlood: (intervalMs: number, perTick: number) => void
  stopFlood: () => void
  setClipboardFails: (fails: boolean) => void
  state: () => {
    sends: { sessionId: string; text: string }[]
    interrupts: string[]
    answers: { eventId: string; choice: string }[]
    decisions: { requestId: string; decision: string }[]
    starts: {
      projectId: string
      deniedMcpServers?: string[]
      mode?: string
      planMode?: boolean
      resume?: boolean
      carryTranscriptFrom?: string
    }[]
    planModeChanges: { sessionId: string; enabled: boolean }[]
    diagramOpens: { projectId: string; file: string }[]
    prOpens: string[]
    pluginInstalls: { marketplace: string; pkg: string }[]
    diffApplies: { projectId: string; path: string; lines: string[]; instruction: string }[]
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
    planMode: boolean
    inPlanMode: boolean
    mcpServers: { name: string; status: string }[]
    startedAt: string
    endedAt: string | null
    endReason: string | null
    label: string | null
    name?: string | null
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

  const diffByProject = new Map<string, AnyRecord>()
  const fileDiffByProject = new Map<string, AnyRecord>()
  for (const p of scenario.projects) {
    if (p.diff) diffByProject.set(p.id, p.diff)
  }

  const diagramsByProject = new Map<string, DiagramEntry[]>()
  const diagramRequestedFiles = new Map<string, Set<string>>()
  const diagramOpens: { projectId: string; file: string }[] = []
  const prOpens: string[] = []
  const pluginInstalls: { marketplace: string; pkg: string }[] = []
  const diffApplies: { projectId: string; path: string; lines: string[]; instruction: string }[] = []
  const DIAGRAMS_DIR = 'docs/diagrams'
  function pickDiagramFileName(
    description: string,
    taken: readonly string[],
    words = 6,
  ): string {
    const slug =
      description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .split('-')
        .filter(Boolean)
        .slice(0, words)
        .join('-') || 'diagram'
    const used = new Set(taken)
    if (!used.has(`${slug}.html`)) return `${slug}.html`
    for (let n = 2; n < 1000; n++) {
      const candidate = `${slug}-${n}.html`
      if (!used.has(candidate)) return candidate
    }
    return `${slug}-${Date.now()}.html`
  }
  function archifyPromptText(
    description: string,
    file: string,
    options: { type: string; quality: string; motion: boolean; reference?: string },
  ): string {
    const base = file.replace(/\.html$/, '')
    const spec = `${DIAGRAMS_DIR}/${base}.${options.type}.json`
    return [
      `Create a diagram: ${description}`,
      '',
      ...(options.reference
        ? [
            'Draw it FROM this file, which the developer chose as the reference:',
            `    "${options.reference}"`,
            'Read it first. Carry over its actual nodes, edges, labels and grouping',
            'so and stop rather than drawing from the sentence alone.',
            '',
          ]
        : []),
      'Use the archify skill for this, and follow its own fast authoring path:',
      `Use the ${options.type} type. Do not substitute another one.`,
      `1. Write the specification to ${spec}, creating the folder if it does not exist.`,
      `   Set meta.quality_profile to "${options.quality}".`,
      options.motion
        ? '   Turn the viewer extras on: set meta.animation to "trace", and add at most'
        : '   Leave motion off: no meta.animation and no meta.views. Static is the default.',
      `       node ~/.claude/skills/archify/bin/archify.mjs deliver ${options.type} ${spec} ${DIAGRAMS_DIR}/${file} --quality ${options.quality} --json`,
      'NEVER run `archify preview`. It watches the file on a loopback port and returns',
      `When it is delivered, reply with the one line: wrote ${DIAGRAMS_DIR}/${file}`,
    ].join('\n')
  }

  function diagramPromptText(description: string, file: string): string {
    return [
      `Create a diagram: ${description}`,
      '',
      `Save it to ${DIAGRAMS_DIR}/${file}, creating the folder if it does not exist.`,
      'Use the default editorial skin. Do not ask about brand colours, fonts or a',
      'website to sample; generate the diagram now with the neutral defaults.',
      'Choose the diagram type that fits the request.',
      '',
      'A DIAGRAM, not a document. The page is a short title, the drawing, and a',
      'legend. Every label belongs inside the drawing. Do not add an introductory',
      'paragraph above it, and do not add prose sections, resource tables, numbered',
      'walkthroughs or a reading order below it. One caption line under the drawing',
      'is the whole of the prose budget; if something needs explaining, label it in',
      'the picture instead.',
      '',
      `When it is written, reply with the one line: wrote ${DIAGRAMS_DIR}/${file}`,
    ].join('\n')
  }

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
        planMode: p.session.planMode ?? false,
        inPlanMode: p.session.planMode ?? false,
        mcpServers: p.session.mcpServers ?? [],
        startedAt: p.session.startedAt ?? now(),
        endedAt: null,
        endReason: null,
        label: null,
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
      defaultSessionMode: p.defaultSessionMode ?? 'auto',
      session,
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
  const mcpSchemaByProject = new Map<string, string>()
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
  let settings: AnyRecord = { ...(scenario.settings as unknown as AnyRecord) }

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
    mode?: string
    planMode?: boolean
    resume?: boolean
    carryTranscriptFrom?: string
  }[] = []
  const planModeChanges: { sessionId: string; enabled: boolean }[] = []
  const answers: { eventId: string; choice: string }[] = []
  const decisionLog: { requestId: string; decision: string }[] = []
  const queuedBySession = new Map<string, { eventId: string; text: string }[]>()
  const taskQueueByProject = new Map<string, AnyRecord[]>()
  const verifyByProject = new Map<string, AnyRecord[]>()
  const flowRunsByProject = new Map<string, AnyRecord[]>()
  const flowStagesByRun = new Map<string, AnyRecord[]>()
  const flowStacksByProject = new Map<string, string[]>()
  let adoFeatures: AnyRecord[] = []
  let adoConnected = true

  const FLOW_STAGE_ORDER = ['spec', 'plan', 'build', 'clean', 'test', 'review', 'ship'] as const
  const MAX_FLOW_FIX_ROUNDS = 2

  function emptyFlowReport(): AnyRecord {
    return { tasksDone: null, tasksTotal: null, verdict: null, findings: [], unmet: [], prUrl: null, prId: null, verify: null }
  }

  const flowSnapshot = (projectId: string): { runs: AnyRecord[]; stages: AnyRecord[] } => {
    const runs = flowRunsByProject.get(projectId) ?? []
    return {
      runs: [...runs],
      stages: runs.flatMap((run) => [...(flowStagesByRun.get(String(run.id)) ?? [])]),
    }
  }

  const pushFlow = (projectId: string): void => {
    push('push.flowChanged', { projectId, ...flowSnapshot(projectId) })
  }

  function flowRun(runId: string): AnyRecord | undefined {
    for (const runs of flowRunsByProject.values()) {
      const found = runs.find((run) => run.id === runId)
      if (found) return found
    }
    return undefined
  }

  function flowStage(runId: string, stage: string): AnyRecord | undefined {
    return (flowStagesByRun.get(runId) ?? []).find((row) => row.stage === stage)
  }

  function updateRun(runId: string, patch: AnyRecord): AnyRecord | undefined {
    for (const runs of flowRunsByProject.values()) {
      const at = runs.findIndex((run) => run.id === runId)
      if (at === -1) continue
      runs[at] = { ...runs[at], ...patch }
      return runs[at]
    }
    return undefined
  }

  function updateStage(runId: string, stage: string, patch: AnyRecord): AnyRecord | undefined {
    const list = flowStagesByRun.get(runId)
    if (!list) return undefined
    const at = list.findIndex((row) => row.stage === stage)
    if (at === -1) return undefined
    list[at] = { ...list[at], ...patch }
    return list[at]
  }

  async function freshFlowSession(projectId: string): Promise<MockSession> {
    return (await invokeHandlers['sessions.start']({ projectId })) as MockSession
  }

  function beginFlowStage(projectId: string, runId: string, stage: string): void {
    void freshFlowSession(projectId).then((session) => {
      const row = flowStage(runId, stage)
      updateStage(runId, stage, {
        status: 'running',
        sessionId: session.id,
        attempts: Number(row?.attempts ?? 0) + 1,
        feedback: null,
      })
      updateRun(runId, { stage, status: 'running' })
      deliver(session.id, `Working on the ${stage} stage.\nSWB_FLOW`)
      pushFlow(projectId)
    })
  }

  function continueFlowStage(runId: string, stage: string, text: string): void {
    void freshFlowSession(String(flowRun(runId)?.projectId)).then((session) => {
      const row = flowStage(runId, stage)
      updateStage(runId, stage, { status: 'running', sessionId: session.id, attempts: Number(row?.attempts ?? 0) + 1 })
      updateRun(runId, { status: 'running' })
      deliver(session.id, text)
      const run = flowRun(runId)
      if (run) pushFlow(run.projectId as string)
    })
  }

  function advanceFlow(projectId: string, runId: string): void {
    const run = flowRun(runId)
    if (!run) return
    const index = FLOW_STAGE_ORDER.indexOf(run.stage as (typeof FLOW_STAGE_ORDER)[number])
    const next = FLOW_STAGE_ORDER[index + 1]
    if (!next) {
      updateRun(runId, { status: 'done', finishedAt: new Date().toISOString() })
      pushFlow(projectId)
      return
    }
    updateRun(runId, { stage: next, status: 'waiting' })
    pushFlow(projectId)
    if (next !== 'ship' || (run.autopilot && run.autoShip)) beginFlowStage(projectId, runId, next)
  }

  function approveFlow(runId: string): void {
    const run = flowRun(runId)
    if (!run) return
    updateStage(runId, run.stage as string, { status: 'approved' })
    advanceFlow(run.projectId as string, runId)
  }

  function maybeAutopilotAdvance(runId: string, stage: string): void {
    const run = flowRun(runId)
    if (!run?.autopilot) return
    const row = flowStage(runId, stage)
    if (!row || row.status !== 'review') return
    if (stage === 'review' && (row.report as AnyRecord | undefined)?.verdict === 'needs_fixes') {
      if (Number(row.attempts ?? 0) <= MAX_FLOW_FIX_ROUNDS) continueFlowStage(runId, 'review', fixText(row))
      return
    }
    approveFlow(runId)
  }

  function fixText(row: AnyRecord): string {
    const report = (row.report ?? {}) as { findings?: AnyRecord[]; unmet?: string[] }
    const mustFix = (report.findings ?? []).filter((f) => f.severity === 'must_fix').map((f) => `- ${String(f.what)}`)
    const unmet = (report.unmet ?? []).map((line) => `- ${line}`)
    return [
      'Fix every must_fix finding and every unmet acceptance criterion listed here, keep the tests green, and commit.',
      ...mustFix,
      ...unmet,
      'SWB_FLOW',
    ].join('\n')
  }

  function deliver(sessionId: string, text: string): void {
    sends.push({ sessionId, text })
    appendEvent(sessionId, 'prompt', { text, pending: false })
    setStatus(sessionId, 'working')
  }

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
    if (decision === 'approve' && request.type === 'plan_approval') {
      const session = sessions.get(String(request.sessionId))
      if (session?.inPlanMode) {
        session.inPlanMode = false
        push('push.sessionStatus', { ...session })
      }
    }
    return { delivered: true }
  }

  const installedSkills: string[] = [...(scenario.skills ?? [])]

  let clipboardFails = false

  let startDelayMs = 250

  const sectionSessions = new Map<string, MockSession>()
  const neverReused: ReadonlySet<SectionKind> = new Set(['diagram'])
  async function sectionSession(projectId: string, kind: SectionKind): Promise<MockSession> {
    const key = `${projectId}|${kind}`
    const live = neverReused.has(kind) ? undefined : sectionSessions.get(key)
    if (live && !live.endedAt) return live
    const started = (await invokeHandlers['sessions.start']({ projectId })) as MockSession
    sectionSessions.set(key, started)
    return started
  }

  const invokeHandlers: Record<InvokeMethod, (req: AnyRecord) => unknown> = {
    'projects.list': () => ({
      projects: projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          ...p,
          reserved: !!p.reserved,
          ...(() => {
            const live = p.sessions.filter((s) => !s.endedAt)
            const latest = p.sessions[p.sessions.length - 1]
            const listed = live.length > 0 ? live : latest ? [latest] : []
            return {
              sessions: listed.map((s) => ({ ...s })),
              session: listed[0] ? { ...listed[0] } : null,
            }
          })(),
          drafts: (draftsByProject.get(p.id) ?? []).map((text, i) => ({ id: String(i), projectId: p.id, text })),
        })),
      archived: projects.filter((p) => p.archivedAt).map((p) => ({ ...p, session: undefined })),
      counters: counters(),
    }),
    'dialog.pickFolder': () => ({ path: nextFolderPick }),
    'dialog.pickFile': () => ({ path: nextFilePick }),
    'projects.register': (req) => {
      const path = String(req.path)
      if (path.includes('missing')) throw { code: 'INVALID_PATH', message: 'The folder does not exist' }
      const existing = projects.find((p) => p.path === path)
      if (existing) {
        if (!existing.archivedAt) throw { code: 'DUPLICATE', message: 'The folder is already registered' }
        existing.archivedAt = null
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
    'skills.list': () => [...installedSkills],
    'skills.import': () => {
      if (!installedSkills.includes('archify')) installedSkills.push('archify')
      return { imported: ['archify'], skipped: [] }
    },
    'sessions.rename': (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'NOT_FOUND', message: 'Session not found' }
      const typed = String(req.label).trim()
      session.label = typed === '' ? null : typed.slice(0, 60)
      session.name = session.label
    },
    'projects.rename': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (project) project.name = String(req.name).trim()
    },
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
    'projects.unarchive': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (project) project.archivedAt = null
    },
    'projects.commands': (req) => projectCommands.get(String(req.projectId)) ?? [],
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
    'diff.apply': (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      if (!project.session || project.session.endedAt) {
        throw { code: 'NOT_LIVE', message: 'No live session for this project' }
      }
      diffApplies.push({
        projectId: String(req.projectId),
        path: String(req.path),
        lines: req.lines as string[],
        instruction: String(req.instruction),
      })
      return { sessionId: project.session.id }
    },
    'diagrams.list': (req) => {
      const list = diagramsByProject.get(String(req.projectId)) ?? []
      return [...list].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
    },
    'diagrams.generate': async (req) => {
      const projectId = String(req.projectId)
      const description = String(req.description)
      await new Promise((resolve) => setTimeout(resolve, startDelayMs))
      const requested = diagramRequestedFiles.get(projectId) ?? new Set<string>()
      const taken = [...(diagramsByProject.get(projectId) ?? []).map((d) => d.file), ...requested]
      const typed = (req.name as string | undefined)?.trim()
      const file = typed
        ? pickDiagramFileName(typed, taken, 12)
        : pickDiagramFileName(description, taken)
      requested.add(file)
      diagramRequestedFiles.set(projectId, requested)
      const session = await sectionSession(projectId, 'diagram')
      const archify = req.archify as
        | { type: string; quality: string; motion: boolean; reference?: string }
        | undefined
      const text = archify
        ? archifyPromptText(description, file, archify)
        : diagramPromptText(description, file)
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      return { sessionId: session.id, file }
    },
    'diagrams.open': (req) => {
      diagramOpens.push({ projectId: String(req.projectId), file: String(req.file) })
    },
    'plugins.install': (req) => {
      const pkg = String(req.pkg)
      pluginInstalls.push({ marketplace: String(req.marketplace), pkg })
      const shipped: Record<string, string[]> = {
        'diagram-design@diagram-design': ['export-diagram'],
        'dotnet-claude-kit@dotnet-claude-kit': [
          'dotnet-claude-kit:code-review',
          'dotnet-claude-kit:de-sloppify',
          'dotnet-claude-kit:security-scan',
          'dotnet-claude-kit:verify',
          'dotnet-claude-kit:health-check',
          'dotnet-claude-kit:migrate',
        ],
        'ponytail@ponytail': [
          'ponytail:ponytail-review',
          'ponytail:ponytail-audit',
          'ponytail:ponytail-debt',
        ],
      }
      const added = shipped[pkg] ?? []
      if (added.length === 0) return
      for (const project of projects) {
        const existing = (projectCommands.get(project.id) ?? []).map((c) => c.name)
        const shaped = [...new Set([...existing, ...added])].map((name) => ({ name }))
        projectCommands.set(project.id, shaped)
        push('push.projectCommands', { projectId: project.id, commands: shaped })
      }
    },
    'diagrams.read': (req) => ({
      html: `<!doctype html><title>${String(req.file)}</title><body><svg role="img" aria-label="${String(req.file)}"><text x="4" y="16">${String(req.file)}</text></svg></body>`,
    }),
    'mcp.readSchema': (req) => {
      const servers = req.servers as string[] | undefined
      const key = servers?.length
        ? `${String(req.projectId)}|${[...servers].sort().join(' + ')}`
        : String(req.projectId)
      return { content: mcpSchemaByProject.get(key) ?? null }
    },
    'sections.runInSession': async (req) => {
      const projectId = String(req.projectId)
      let session = req.background
        ? await sectionSession(projectId, req.kind as SectionKind)
        : [...sessions.values()].find((s) => s.projectId === projectId && !s.endedAt)
      if (!session) session = (await invokeHandlers['sessions.start']({ projectId })) as MockSession
      sends.push({ sessionId: session.id, text: String(req.text) })
      appendEvent(session.id, 'prompt', { text: String(req.text), pending: false })
      return { sessionId: session.id }
    },
    'updates.check': () => ({ status: 'none' }),
    'updates.install': () => undefined,
    'terminal.open': () => ({ scrollback: '', reused: false }),
    'terminal.write': () => undefined,
    'terminal.resize': () => undefined,
    'terminal.close': () => undefined,
    'sessions.start': async (req) => {
      const project = projects.find((p) => p.id === req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      await new Promise((resolve) => setTimeout(resolve, 250))
      const mode = String(req.mode ?? project.defaultSessionMode ?? 'auto')
      const planMode = mode === 'plan'
      starts.push({
        projectId: String(req.projectId),
        deniedMcpServers: req.deniedMcpServers as string[] | undefined,
        mode,
        planMode,
        resume: req.resume === true,
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
        planMode,
        inPlanMode: planMode,
        mcpServers: [],
        startedAt: now(),
        endedAt: null,
        endReason: null,
        label: null,
      }
      sessions.set(session.id, session)
      project.sessions.push(session)
      project.session = session
      pushCounters()
      return { ...session }
    },
    'sessions.fate': (req) => {
      const s = sessions.get(String(req.sessionId))
      if (!s) return null
      return {
        endedAt: s.endedAt ?? null,
        endReason: s.endReason ?? null,
        statusDetail: s.statusDetail ?? null,
      }
    },
    'sessions.stop': async (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'NOT_FOUND', message: 'Session not found' }
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
    'sessions.clearBackgroundTasks': (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'SESSION_ENDED', message: 'Session has ended' }
      ;(session as unknown as AnyRecord).backgroundTasks = []
      setStatus(session.id, 'done')
    },
    'sessions.setPlanMode': (req) => {
      const session = sessions.get(String(req.sessionId))
      if (!session) throw { code: 'SESSION_ENDED', message: 'Session has ended' }
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
    'clipboard.write': async (req) => {
      if (clipboardFails) throw { code: 'INTERNAL', message: 'Clipboard unavailable.' }
      try {
        await navigator.clipboard.writeText(String(req.text))
      } catch {
      }
    },
    'clipboard.read': async () => {
      if (clipboardFails) throw { code: 'INTERNAL', message: 'Clipboard unavailable.' }
      try {
        return { text: await navigator.clipboard.readText() }
      } catch {
        return { text: '' }
      }
    },
    'sessions.promptHistory': (req) => {
      const seen = new Set<string>()
      const out: string[] = []
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
    'flow.list': (req) => flowSnapshot(String(req.projectId)),
    'flow.features': async (req) => {
      const projectId = String(req.projectId)
      if (!adoConnected) {
        throw {
          code: 'NOT_LIVE',
          message:
            'The Azure DevOps MCP server is not connected for this session, so Flow cannot read or write the board. Check the ado server in your Claude Code configuration and try again.',
        }
      }
      const session = await sectionSession(projectId, 'flow')
      const text = `List the Features I could work on next in Azure DevOps.\n${String(req.query ?? '')}\nSWB_FLOW`
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      return [...adoFeatures]
    },
    'flow.existingSpecs': (req) => {
      const state = specKitByProject.get(String(req.projectId)) as { specs?: AnyRecord[] } | undefined
      return (state?.specs ?? []).map((spec) => ({ id: spec.id, title: spec.title }))
    },
    'flow.detectStacks': (req) => [...(flowStacksByProject.get(String(req.projectId)) ?? ['dotnet'])],
    'flow.start': async (req) => {
      const projectId = String(req.projectId)
      const source = req.source as AnyRecord
      if (source.kind === 'ado' && !adoConnected) {
        throw {
          code: 'NOT_LIVE',
          message: 'The Azure DevOps MCP server is not connected for this session, so Flow cannot read or write the board.',
        }
      }
      const stacks = [...(flowStacksByProject.get(projectId) ?? ['dotnet'])]
      if (stacks.length === 0) {
        throw { code: 'UNSUPPORTED', message: 'Flow supports .NET and Angular projects.' }
      }
      const runs = flowRunsByProject.get(projectId) ?? []
      const id = `flow-${runs.length + 1}`
      const now = new Date().toISOString()
      const run: AnyRecord = {
        id,
        projectId,
        title:
          source.kind === 'ado'
            ? String(source.featureTitle)
            : source.kind === 'text'
              ? String(source.title)
              : String(source.specId),
        source: source.kind,
        sourceRef: source.kind === 'ado' ? String(source.featureId) : source.kind === 'spec' ? String(source.specId) : null,
        sourceUrl: source.kind === 'ado' ? (source.url ?? null) : null,
        description: source.kind === 'text' ? String(source.description ?? '') : '',
        stacks,
        stage: 'spec',
        status: 'running',
        autopilot: req.autopilot === true,
        autoShip: req.autoShip === true,
        baseBranch: (req.baseBranch as string | undefined) ?? 'main',
        branch: `feature/${id}`,
        worktreePath: `C:\\work\\${id}`,
        specDir: null,
        prUrl: null,
        prId: null,
        note: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }
      runs.unshift(run)
      flowRunsByProject.set(projectId, runs)
      flowStagesByRun.set(
        id,
        FLOW_STAGE_ORDER.map((stage) => ({
          runId: id,
          stage,
          status: 'pending',
          sessionId: null,
          attempts: 0,
          summary: null,
          report: null,
          feedback: null,
          startedAt: null,
          finishedAt: null,
        })),
      )
      beginFlowStage(projectId, id, 'spec')
      return { runId: id, ...flowSnapshot(projectId) }
    },
    'flow.approve': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      const stage = flowStage(runId, run.stage as string)
      if (!stage || stage.status !== 'review') {
        throw { code: 'RULE_NOT_ALLOWED', message: 'This stage is not waiting for approval.' }
      }
      approveFlow(runId)
      return flowSnapshot(run.projectId as string)
    },
    'flow.retry': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      beginFlowStage(run.projectId as string, runId, run.stage as string)
      return flowSnapshot(run.projectId as string)
    },
    'flow.skip': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      updateStage(runId, run.stage as string, { status: 'skipped', finishedAt: new Date().toISOString() })
      if (run.stage === 'ship') {
        updateRun(runId, { status: 'done', finishedAt: new Date().toISOString() })
        pushFlow(run.projectId as string)
      } else {
        advanceFlow(run.projectId as string, runId)
      }
      return flowSnapshot(run.projectId as string)
    },
    'flow.fix': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      const row = run ? flowStage(runId, 'review') : undefined
      if (!run || run.stage !== 'review' || !row || (row.report as AnyRecord | null)?.verdict !== 'needs_fixes') {
        throw { code: 'RULE_NOT_ALLOWED', message: 'Fix only applies to a review that found something to fix.' }
      }
      continueFlowStage(runId, 'review', fixText(row))
      return flowSnapshot(run.projectId as string)
    },
    'flow.ship': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run || run.stage !== 'ship') {
        throw { code: 'RULE_NOT_ALLOWED', message: 'This run has not reached the ship stage yet.' }
      }
      beginFlowStage(run.projectId as string, runId, 'ship')
      return flowSnapshot(run.projectId as string)
    },
    'flow.cancel': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      const stage = flowStage(runId, run.stage as string)
      if (stage?.status === 'running' && stage.sessionId) {
        interrupts.push(String(stage.sessionId))
        setStatus(String(stage.sessionId), 'done')
        updateStage(runId, run.stage as string, { status: 'failed', summary: 'Cancelled.', finishedAt: new Date().toISOString() })
      }
      updateRun(runId, { status: 'cancelled', note: 'You stopped this flow.', finishedAt: new Date().toISOString() })
      pushFlow(run.projectId as string)
      return flowSnapshot(run.projectId as string)
    },
    'flow.revise': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      const feedback = String(req.feedback)
      updateStage(runId, run.stage as string, { feedback })
      continueFlowStage(runId, run.stage as string, `Revise per this feedback: ${feedback}\nSWB_FLOW`)
      return flowSnapshot(run.projectId as string)
    },
    'flow.setAutopilot': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      updateRun(runId, { autopilot: req.autopilot === true })
      return flowSnapshot(run.projectId as string)
    },
    'flow.removeWorktree': (req) => {
      const runId = String(req.runId)
      const run = flowRun(runId)
      if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' }
      if (!run.finishedAt) {
        throw { code: 'RULE_NOT_ALLOWED', message: 'This run still uses its worktree. Cancel the run or let it finish first.' }
      }
      updateRun(runId, { worktreePath: null })
      return flowSnapshot(run.projectId as string)
    },
    'flow.openPullRequest': (req) => {
      const run = flowRun(String(req.runId))
      if (!run?.prUrl) throw { code: 'NOT_FOUND', message: 'This run has no pull request yet.' }
      prOpens.push(String(run.prUrl))
    },
    'flow.artefact': (req) => {
      const run = flowRun(String(req.runId))
      if (!run) return null
      const stageName = String(req.stage)
      const kind = String(req.kind ?? (stageName === 'spec' ? 'spec' : stageName === 'test' ? 'report' : 'tasks'))
      if (kind === 'report') {
        const stage = flowStage(run.id as string, stageName)
        return { path: null, content: JSON.stringify(stage?.report ?? {}, null, 2) }
      }
      const specDir = String(run.specDir ?? 'specs/mock')
      if (kind === 'spec') return { path: `${specDir}/spec.md`, content: `# ${String(run.title)}\n\n## Summary\nMock spec body.\n` }
      if (kind === 'plan') return { path: `${specDir}/plan.md`, content: '# Plan\n\n## Approach\nMock plan body.\n' }
      if (kind === 'tasks') {
        return {
          path: `${specDir}/tasks.md`,
          content: '## Phase 1\n- [x] T001 Scaffold the slice\n- [ ] T002 Wire the endpoint\n- [ ] T003 Write tests\n',
        }
      }
      return null
    },
    'verify.list': (req) => [...(verifyByProject.get(String(req.projectId)) ?? [])],
    'verify.suites': () =>
      (scenario.suites ?? []).map((stack) => ({ ...stack, suites: [...stack.suites] })),
    'verify.start': async (req) => {
      const projectId = String(req.projectId)
      const suiteIds = (req.suiteIds ?? []) as string[]
      if (suiteIds.length === 0) throw { code: 'INVALID_PATH', message: 'Choose at least one suite to run.' }
      const text = `Verify the working tree of this project.\n${suiteIds.join('\n')}\nSWB_VERIFY`
      const session = await sectionSession(projectId, 'tests')
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
      const ran = list[0]?.sessionId ? sessions.get(String(list[0].sessionId)) : undefined
      const session =
        ran && !ran.endedAt ? ran : (await sectionSession(projectId, 'tests'))
      const text = 'Capture evidence that the change in this working tree actually works.\nSWB_VERIFY'
      sends.push({ sessionId: session.id, text })
      appendEvent(session.id, 'prompt', { text, pending: false })
      return { sessionId: session.id, runs: [...list] }
    },
    'verify.cancel': (req) => {
      const projectId = String(req.projectId)
      const list = verifyByProject.get(projectId) ?? []
      const at = list.findIndex((r) => r.id === req.runId)
      if (at < 0) throw { code: 'NOT_FOUND', message: 'Run not found' }
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
      const request = decisions.find((d) => d.id === req.requestId)
      if (!request) throw { code: 'NOT_FOUND', message: 'Not found' }
      const dangerous = /\b(rm|rmdir|del|rd|mkfs|dd|sudo|doas)\b|\bformat\s+[a-z]:|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i
      if (
        request.type === 'plan_approval' ||
        request.toolName !== 'Bash' ||
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
      return { rule }
    },
    'inbox.approveAlways': (req) => {
      const request = pending.find((p) => p.id === req.requestId)
      if (!request) throw { code: 'NOT_FOUND', message: 'Not found' }
      const dangerous = /\b(rm|rmdir|del|rd|mkfs|dd|sudo|doas)\b|\bformat\s+[a-z]:|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i
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
        const isHighRisk = item.risk === 'high' && item.type === 'tool_permission'
        if (isHighRisk && !req.includeHighRisk) {
          skippedHighRisk += 1
          continue
        }
        decide(item.id, 'approve', isHighRisk)
        approved += 1
      }
      return { approved, skippedHighRisk }
    },
    'inbox.history': (req) =>
      decisions.filter((d) => !req?.projectId || d.projectId === req.projectId),
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
    'settings.get': () => ({ ...settings }),
    'settings.set': (req) => {
      settings = { ...settings, ...req }
      return { ...settings }
    },
    'models.available': () => availableModels,
  }

  window.switchboard = {
    invoke: (method: string, req: unknown) => {
      const handler = invokeHandlers[method as InvokeMethod]
      if (!handler) return Promise.reject({ code: 'NOT_FOUND', message: `Unknown method ${method}` })
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
  let nextFilePick: string | null = null
  const draftsByProject = new Map<string, string[]>(
    scenario.projects.filter((p) => p.drafts?.length).map((p) => [p.id, p.drafts as string[]]),
  )

  window.__mock = {
    setDrafts: (projectId, texts) => {
      draftsByProject.set(projectId, texts)
    },
    setNextFolderPick: (path) => {
      nextFolderPick = path
    },
    setNextFilePick: (path) => {
      nextFilePick = path
    },
    emitEvent: (sessionId, kind, payload) => String(appendEvent(sessionId, kind, payload).id),
    updateEvent: (sessionId, eventId, payload) => updateEvent(sessionId, eventId, payload),
    focusSession: (sessionId) => push('push.focusRequest', { target: 'session', sessionId }),
    setCommands: (projectId, commands) => {
      const shaped = commands.map((c) => (typeof c === 'string' ? { name: c } : c))
      projectCommands.set(projectId, shaped)
      push('push.projectCommands', { projectId, commands: shaped })
    },
    setAvailableModels: (models) => {
      availableModels = models
    },
    setSpecKit: (projectId, state) => specKitByProject.set(projectId, state),
    setStartDelay: (ms) => {
      startDelayMs = ms
    },
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
    crashSession: (sessionId, detail) => {
      const s = sessions.get(sessionId)
      if (s) {
        s.endedAt = now()
        s.endReason = 'crashed'
        setStatus(sessionId, 'error', detail)
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
      const queue = queuedBySession.get(sessionId) ?? []
      const hadComposerQueue = queue.length > 0
      for (const item of queue.splice(0)) {
        updateEvent(sessionId, item.eventId, { text: item.text, pending: false })
      }
      setStatus(sessionId, 'done')
      pushCounters()
      const session = sessions.get(sessionId)
      if (!hadComposerQueue && session) maybeDrainQueue(session.projectId)
    },
    setStatus: (sessionId, status) => setStatus(sessionId, status),
    setAdoFeatures: (features) => {
      adoFeatures = features.map((feature) => ({
        id: feature.id,
        title: feature.title,
        state: feature.state ?? 'Active',
        url: null,
      }))
    },
    setAdoConnected: (on) => {
      adoConnected = on
    },
    reportFlowStage: (runId, stage, patch) => {
      const run = flowRun(runId)
      const row = flowStage(runId, stage)
      if (!run || !row) return
      const stagePatch: AnyRecord = {}
      if (patch.status !== undefined) stagePatch.status = patch.status
      if (patch.summary !== undefined) stagePatch.summary = patch.summary
      if (patch.report !== undefined) stagePatch.report = patch.report
      if (patch.status === 'review' || patch.status === 'failed') {
        stagePatch.finishedAt = new Date().toISOString()
        updateRun(runId, { status: 'waiting' })
      }
      updateStage(runId, stage, stagePatch)
      pushFlow(run.projectId as string)
      if (patch.status === 'review') maybeAutopilotAdvance(runId, stage)
    },
    askFlowQuestion: (runId, text, options) => {
      const run = flowRun(runId)
      if (!run) throw new Error('Run not found')
      const row = flowStage(runId, run.stage as string)
      const sessionId = row?.sessionId as string | undefined
      if (!sessionId) throw new Error('That stage has no live session')
      const event = appendEvent(sessionId, 'question', {
        text,
        options: options.map((label) => ({ label })),
        answered: false,
      })
      setStatus(sessionId, 'needs_you')
      return String(event.id)
    },
    reportFlowVerify: (runId, report) => {
      const run = flowRun(runId)
      const row = flowStage(runId, 'test')
      if (!run || !row) return
      const suites = (report as { suites?: { status: string }[] } | null)?.suites ?? []
      const failed = suites.some((s) => s.status === 'fail')
      updateStage(runId, 'test', {
        status: failed ? 'failed' : 'review',
        report: { ...emptyFlowReport(), verify: report },
        finishedAt: new Date().toISOString(),
      })
      updateRun(runId, { status: 'waiting' })
      pushFlow(run.projectId as string)
      if (!failed) maybeAutopilotAdvance(runId, 'test')
    },
    reportFlowShip: (runId, prUrl, prId) => {
      const run = flowRun(runId)
      const row = flowStage(runId, 'ship')
      if (!run || !row) return
      updateStage(runId, 'ship', {
        status: 'review',
        summary: 'Pull request opened.',
        report: { ...emptyFlowReport(), prUrl, prId },
        finishedAt: new Date().toISOString(),
      })
      updateRun(runId, { prUrl, prId, status: 'waiting' })
      pushFlow(run.projectId as string)
      maybeAutopilotAdvance(runId, 'ship')
    },
    setFlowStacks: (projectId, stacks) => {
      flowStacksByProject.set(projectId, stacks)
    },
    reportVerifyResult: (projectId, status, report) => {
      const list = verifyByProject.get(projectId) ?? []
      const index = list.findIndex((r) => r.status === 'running')
      const at = index >= 0 ? index : 0
      if (!list[at]) return
      list[at] = { ...list[at], status, report, finishedAt: new Date().toISOString() }
      verifyByProject.set(projectId, list)
      push('push.verifyChanged', { projectId, runs: [...list] })
    },
    addDiagram: (projectId, entry) => {
      const list = diagramsByProject.get(projectId) ?? []
      list.push({ ...entry })
      diagramsByProject.set(projectId, list)
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
    setClipboardFails: (fails: boolean) => {
      clipboardFails = fails
    },
    state: () => ({
      sends: [...sends],
      interrupts: [...interrupts],
      answers: [...answers],
      decisions: [...decisionLog],
      starts: [...starts],
      planModeChanges: [...planModeChanges],
      diagramOpens: [...diagramOpens],
      prOpens: [...prOpens],
      pluginInstalls: [...pluginInstalls],
      diffApplies: [...diffApplies],
    }),
  }
}

export function twoProjectScenario(): MockScenario {
  return {
    settings: DEFAULT_SETTINGS,
    suites: detectStacks(['MyApi.sln']),
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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const GIT_EXEC_OPTS = { timeout: 8000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const
import type {
  AvailableModel,
  DiffFileEntry,
  DiffFileStatus,
  DiffListResult,
  EventKind,
  EffortLevel,
  EventPayloadMap,
  FileDiffContent,
  ModelMode,
  Project,
  ProjectCommand,
  QueuedTask,
  SectionKind,
  Session,
  SessionEndReason,
  SessionEvent,
  SessionEngine,
  SessionMode,
  SessionStatus,
  SuiteResult,
  TranscriptSummary,
  VerifyReport,
} from '@shared/domain'
import {
  DEFAULT_SESSION_ENGINE,
  SWALLOWABLE_KINDS,
  emptyVerifyReport,
  subagentsAllowed,
  verifyVerdict,
} from '@shared/domain'
import type { IpcError, SessionStatusPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import { readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { HostedSession, type PermissionGate, type SessionHost } from './session'
import { switchboardMcp } from './inter-session'
import { probeAvailableModels } from './model-catalog'
import { CODEX_MISSING_MESSAGE, codexInstalled } from './codex-executable'
import { probeCodexModels } from './codex-catalog'
import { CodexSession } from './codex-session'
import { foldModelTotals, type EventSink } from './message-mapper'
import {
  heavySubagentSystemPromptAppend,
  heavySubagentModelMode,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
} from './session-shaping'
import {
  TRANSCRIPT_EVENT_CAP,
  transcriptContextAppend,
  transcriptFor,
  writeTranscript,
} from './transcript'
import { auditDone, readAuditReport } from '@main/security/audit-dispatch'
import { parseFlowMarker, type FlowMarker } from '@main/flow/flow-markers'
import { parseEvalMarker } from '@main/evals/eval-dispatch'
import {
  parseSuiteProgress,
  parseVerifyReport,
  verifyMarkerBroken,
  verifyPrompt,
  type PlannedSuite,
} from '@main/evals/verify-dispatch'
import { parseDiagramPlan } from '@shared/diagram'
import { reconcile } from '@main/evals/artefacts'
import { scanArtefacts } from '@main/evals/artefact-scan'
import { parseApiRequests } from '@main/evals/api-dispatch'
import type { ApiRequestPlan } from '@shared/api-endpoints'
import type { SandboxEnv, TestSuite } from '@shared/test-catalog'
import { mainLoopModel } from './model-routing'
import { resolveClaudeExecutable } from './claude-executable'
import {
  ensureSandboxImage,
  ensureSandboxVolumes,
  gitNotice,
  gitRoot,
  hasNodeModulesVolume,
  refMounts,
  removeNodeModulesVolume,
  sandboxVolumeNames,
  sweepOrphanedContainers,
  sweepStaleVolumes,
} from './wslc-sandbox'

type NoiseClassifier = (event: SessionEvent) => string | null

interface SessionManagerCallbacks {
  onEvent: (event: SessionEvent) => void
  onSessionStatus: (push: SessionStatusPush) => void
  onCountersChanged: () => void
  onSessionExit: (sessionId: string) => void
  onQueueChanged: (projectId: string) => void
  onEvalsChanged: (projectId: string) => void
  onVerifyChanged: (projectId: string) => void
  onSecurityChanged: (projectId: string) => void
  onDiagramsChanged: (projectId: string) => void
  onApiRequests: (projectId: string, runId: string, requests: ApiRequestPlan[]) => void
  onApiChanged: (projectId: string) => void
  onProjectCommands: (projectId: string, commands: ProjectCommand[]) => void
  gate: PermissionGate
}

interface LiveEventEntry {
  event: SessionEvent
  persisted: boolean
}

interface HostedEntry {
  session: SessionHost
  row: Session
  projectPath: string
  seq: number
  live: Map<string, LiveEventEntry>
  containerised: boolean
  background: boolean
  sectionKind?: SectionKind
  ranATurn: boolean
  nodeModulesVolumeKey?: string
}

const MAX_CONTAINERS = 2

const RUN_DEADLINE_MS = 45 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

const REVIVE_COOLDOWN_MS = 10 * 60_000

const CANCEL_NOTE = 'You stopped this run before it reported, so nothing it measured is known.'

const MODELS_TTL_MS = 10 * 60_000

const NEVER_REUSED: ReadonlySet<SectionKind> = new Set(['diagram'])

const WORKER_KINDS: ReadonlySet<SectionKind> = new Set(['diff'])

const UPDATABLE_KINDS: ReadonlySet<EventKind> = new Set([
  'prompt',
  'assistant_text',
  'tool_activity',
  'question',
  'permission_marker',
  'plan_marker',
])

const STREAM_LOCAL_KINDS: ReadonlySet<EventKind> = new Set([
  'prompt',
  'assistant_text',
  'tool_activity',
])

const MAX_LIVE_STREAM_EVENTS = 200

const TRANSCRIBED_KINDS: ReadonlySet<EventKind> = new Set(['prompt', 'assistant_text', 'summary'])

const TRANSCRIPT_DEBOUNCE_MS = 3000

function evictStaleLive(entry: HostedEntry): void {
  let streamLocal = 0
  for (const { event } of entry.live.values()) {
    if (STREAM_LOCAL_KINDS.has(event.kind)) streamLocal++
  }
  if (streamLocal <= MAX_LIVE_STREAM_EVENTS) return
  let toDrop = streamLocal - MAX_LIVE_STREAM_EVENTS
  for (const [id, { event }] of entry.live) {
    if (toDrop === 0) break
    if (!STREAM_LOCAL_KINDS.has(event.kind)) continue
    entry.live.delete(id)
    toDrop--
  }
}

async function readGitBranch(projectPath: string): Promise<string | null> {
  try {
    const root = gitRoot(projectPath) ?? projectPath
    const { stdout } = await execFileAsync('git', ['-C', root, 'branch', '--show-current'], {
      timeout: 4000,
      windowsHide: true,
    })
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

function isBinaryContent(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

type NumstatEntry = { adds: number | null; dels: number | null; binary: boolean }

async function readNumstat(projectPath: string): Promise<{
  totals: { adds: number; dels: number } | null
  byPath: Map<string, NumstatEntry>
}> {
  const byPath = new Map<string, NumstatEntry>()
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'git',
      ['-C', projectPath, 'diff', '--numstat'],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { totals: null, byPath }
  }
  let adds = 0
  let dels = 0
  for (const line of stdout.split('\n')) {
    const [a, d, path] = line.split('\t')
    if (path === undefined) continue
    const binary = a === '-' && d === '-'
    const fileAdds = binary ? null : Number.parseInt(a, 10) || 0
    const fileDels = binary ? null : Number.parseInt(d, 10) || 0
    byPath.set(path, { adds: fileAdds, dels: fileDels, binary })
    adds += fileAdds ?? 0
    dels += fileDels ?? 0
  }
  return { totals: { adds, dels }, byPath }
}

async function readUntrackedEntry(projectPath: string, path: string): Promise<DiffFileEntry> {
  try {
    const content = await readFile(join(projectPath, path))
    if (isBinaryContent(content)) {
      return { path, status: 'untracked', addedLines: null, removedLines: null, binary: true }
    }
    const text = content.toString('utf8')
    const lineCount = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { path, status: 'untracked', addedLines: lineCount, removedLines: 0, binary: false }
  } catch {
    return { path, status: 'untracked', addedLines: null, removedLines: null, binary: false }
  }
}

export async function readDiffList(projectPath: string): Promise<DiffListResult> {
  const root = gitRoot(projectPath)
  if (!root) {
    return { gitNotice: 'The project is not a git repository — there is no git history to diff.', files: [] }
  }

  let statusOut: string
  try {
    ;({ stdout: statusOut } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z'],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { gitNotice: 'Unable to read this project’s working tree.', files: [] }
  }

  const { byPath: numstat } = await readNumstat(root)
  const tokens = statusOut.split('\0').filter((t) => t.length > 0)
  const files: DiffFileEntry[] = []
  const untrackedPaths: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const code = token.slice(0, 2)
    const path = token.slice(3)
    if (code[0] === 'R' || code[0] === 'C') i++
    const status: DiffFileStatus =
      code === '??'
        ? 'untracked'
        : code.includes('D')
          ? 'deleted'
          : code[0] === 'R'
            ? 'renamed'
            : code.includes('A')
              ? 'added'
              : 'modified'

    if (status === 'untracked') {
      untrackedPaths.push(path)
      continue
    }
    const counts = numstat.get(path)
    files.push({
      path,
      status,
      addedLines: counts?.adds ?? null,
      removedLines: counts?.dels ?? null,
      binary: counts?.binary ?? false,
    })
  }
  const BATCH = 32
  for (let i = 0; i < untrackedPaths.length; i += BATCH) {
    const batch = untrackedPaths.slice(i, i + BATCH)
    files.push(...(await Promise.all(batch.map((p) => readUntrackedEntry(root, p)))))
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { gitNotice: null, files }
}

const WHOLE_FILE_CONTEXT = 100_000

function parseUnifiedDiff(diffText: string): FileDiffContent {
  if (/^Binary files /m.test(diffText)) return { binary: true, lines: [] }
  const lines: FileDiffContent['lines'] = []
  for (const raw of diffText.split('\n')) {
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('@@') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename from') ||
      raw.startsWith('rename to')
    ) {
      continue
    }
    if (raw.startsWith('+')) lines.push({ type: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ type: 'del', text: raw.slice(1) })
    else if (raw.startsWith(' ')) lines.push({ type: 'context', text: raw.slice(1) })
  }
  return { binary: false, lines }
}

export async function readFileDiff(projectPath: string, path: string): Promise<FileDiffContent | null> {
  const root = gitRoot(projectPath) ?? projectPath
  let statusOut: string
  try {
    ;({ stdout: statusOut } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '--', path],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return null
  }
  if (statusOut.trim().length === 0) return null 

  if (statusOut.startsWith('??')) {
    const entry = await readUntrackedEntry(root, path)
    if (entry.binary) return { binary: true, lines: [] }
    if (entry.addedLines === null) return null 
    const content = await readFile(join(root, path), 'utf8')
    const rawLines = content.length === 0 ? [] : content.split('\n')
    if (content.endsWith('\n')) rawLines.pop()
    return { binary: false, lines: rawLines.map((text) => ({ type: 'add', text })) }
  }

  let diffOut: string
  try {
    ;({ stdout: diffOut } = await execFileAsync(
      'git',
      ['-C', root, 'diff', `--unified=${WHOLE_FILE_CONTEXT}`, '--', path],
      GIT_EXEC_OPTS,
    ))
  } catch {
    return { binary: false, lines: [] }
  }
  return parseUnifiedDiff(diffOut)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export class SessionManager {
  private hosted = new Map<string, HostedEntry>()
  private reservedContainerIds = new Set<string>()
  private classifier: NoiseClassifier | null = null
  private revivedAt = new Map<string, number>()
  private quitting = false
  private transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>()
  availableModels: AvailableModel[] = []
  private probingModels: Promise<AvailableModel[]> | null = null
  private modelsProbedAt = 0
  private codexModels: AvailableModel[] = []
  private probingCodexModels: Promise<AvailableModel[]> | null = null
  private codexModelsProbedAt = 0

  constructor(
    private repos: Repositories,
    private callbacks: SessionManagerCallbacks,
  ) {}

  async models(): Promise<AvailableModel[]> {
    const [claude, codex] = await Promise.all([this.claudeModels(), this.codexModelList()])
    return [...claude, ...codex]
  }

  private async codexModelList(): Promise<AvailableModel[]> {
    const fresh = Date.now() - this.codexModelsProbedAt < MODELS_TTL_MS
    if (fresh) return this.codexModels
    this.probingCodexModels ??= probeCodexModels()
    try {
      const models = await this.probingCodexModels
      this.codexModels = models
      this.codexModelsProbedAt = Date.now()
    } finally {
      this.probingCodexModels = null
    }
    return this.codexModels
  }

  private async claudeModels(): Promise<AvailableModel[]> {
    const fresh = Date.now() - this.modelsProbedAt < MODELS_TTL_MS
    if (this.availableModels.length > 0 && fresh) return this.availableModels
    this.probingModels ??= probeAvailableModels(
      this.repos.projects.listActive()[0]?.path ?? process.cwd(),
    )
    try {
      const models = await this.probingModels
      if (models.length > 0) {
        this.availableModels = models
        this.modelsProbedAt = Date.now()
      }
    } finally {
      this.probingModels = null
    }
    return this.availableModels
  }

  setNoiseClassifier(classifier: NoiseClassifier): void {
    this.classifier = classifier
  }

  reconcileOnStartup(): void {
    const leftOpen = this.repos.sessions.listUnended().map((s) => s.id)
    this.repos.sessions.reconcileAllEnded(
      'app_exit',
      'Switchboard stopped without closing this session, so it was closed on the next launch. The conversation can be resumed.',
    )
    for (const request of this.repos.requests.pending()) {
      this.repos.requests.resolve(request.id, 'expired')
    }
    const note =
      'The application closed before this run reported a result, so nothing it measured is known.'
    this.repos.verifyRuns.reconcileRunning(note)
    this.repos.apiRuns.reconcileRunning(note)
    this.repos.securityRuns.reconcileRunning(note)
    sweepOrphanedContainers(leftOpen)
    sweepStaleVolumes((id) => this.repos.sessions.byId(id))
  }

  startWatchdog(deadlineMs = RUN_DEADLINE_MS, intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => this.sweepStaleRuns(deadlineMs), intervalMs)
    this.watchdog.unref?.()
  }

  stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  private watchdog: ReturnType<typeof setInterval> | null = null

  private sweepStaleRuns(deadlineMs: number): void {
    const deadline = new Date(Date.now() - deadlineMs).toISOString()
    const note =
      'This run went quiet for long enough that its session is presumed dead, so nothing it measured is known.'
    for (const projectId of this.repos.verifyRuns.reconcileStale(deadline, note)) {
      this.callbacks.onVerifyChanged(projectId)
    }
    for (const projectId of this.repos.apiRuns.reconcileStale(deadline, note)) {
      this.callbacks.onApiChanged(projectId)
    }
  }

  private resolveModelRouting(): {
    intelligentModel: string
    workerModel: string
    modelMode: ModelMode
    autoModelRouting: boolean
    effort: EffortLevel
  } {
    const settings = this.repos.settings.get()
    return {
      intelligentModel: settings.intelligentModel,
      workerModel: settings.workerModel,
      modelMode: settings.modelMode ?? 'auto',
      autoModelRouting: settings.autoModelRouting,
      effort: settings.effort,
    }
  }

  async startSession(
    projectId: string,
    resume = false,
    requestedMode?: SessionMode,
    carryTranscriptFrom?: string,
    opts?: {
      containerised?: boolean
      background?: boolean
      nodeModulesVolumeKey?: string
      engine?: SessionEngine
      workerMainLoop?: boolean
      cwd?: string
      effort?: EffortLevel
    },
  ): Promise<Session> {
    const project = this.repos.projects.byId(projectId)
    if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
    const engine = opts?.engine ?? this.repos.settings.get().defaultEngine ?? DEFAULT_SESSION_ENGINE
    if (engine === 'codex' && (opts?.containerised === true || requestedMode === 'bypass')) {
      throw {
        code: 'UNSUPPORTED',
        message:
          'Codex sessions do not run in a container. Start this one on Claude, or choose a mode other than bypass.',
      } satisfies IpcError
    }
    const mode = requestedMode ?? project.defaultSessionMode
    const bypassPermissions = mode === 'bypass'
    const containerised = opts?.containerised === true || bypassPermissions
    if (containerised && opts?.cwd) {
      throw {
        code: 'UNSUPPORTED',
        message:
          'A container session mounts the project folder itself, so it cannot run in a worktree. Untick the WSL box for this project, or choose a mode other than bypass.',
      } satisfies IpcError
    }
    if (containerised) this.refuseWhenContainersFull()
    const sessionId = newId()
    if (containerised) this.reservedContainerIds.add(sessionId)
    try {
      return await this.startSessionBody(
        sessionId,
        project,
        mode,
        bypassPermissions,
        containerised,
        resume,
        carryTranscriptFrom,
        opts,
        engine,
      )
    } finally {
      if (containerised) this.reservedContainerIds.delete(sessionId)
    }
  }

  private async startSessionBody(
    sessionId: string,
    project: Project,
    mode: SessionMode,
    bypassPermissions: boolean,
    containerised: boolean,
    resume: boolean,
    carryTranscriptFrom: string | undefined,
    opts:
      | {
          containerised?: boolean
          background?: boolean
          nodeModulesVolumeKey?: string
          engine?: SessionEngine
          workerMainLoop?: boolean
          cwd?: string
          effort?: EffortLevel
        }
      | undefined,
    engine: SessionEngine,
  ): Promise<Session> {
    const projectId = project.id
    if (containerised) {
      try {
        await ensureSandboxImage(project.path)
      } catch (error) {
        const escape = bypassPermissions
          ? 'Bypass always runs in a container, so this cannot be turned off for a bypass session; start it in another mode to run on this machine.'
          : `This is on because ${project.name} has its WSL box ticked in the project header. Untick it to run on this machine instead.`
        throw new Error(`${(error as Error).message} ${escape}`, { cause: error })
      }
    }
    const claudeExecutablePath = resolveClaudeExecutable()
    if (!claudeExecutablePath && engine === 'claude') {
      throw { code: 'NOT_FOUND', message: 'Claude Code was not found. Install it from https://claude.com/claude-code, then start a session.' } satisfies IpcError
    }
    if (engine === 'codex' && !codexInstalled()) {
      throw { code: 'NOT_FOUND', message: CODEX_MISSING_MESSAGE } satisfies IpcError
    }

    let resumeSdkSessionId: string | undefined
    let resumeFromSessionId: string | undefined
    if (resume) {
      const previous = this.repos.sessions.latestEndedForProject(projectId, engine)
      resumeSdkSessionId = previous?.sdkSessionId ?? undefined
      resumeFromSessionId = previous?.id
    }

    if (containerised) {
      await ensureSandboxVolumes(
        sandboxVolumeNames({
          projectPath: project.path,
          sessionId,
          resumeFromSessionId,
          nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
        }),
      )
    }

    const row: Session = {
      id: sessionId,
      projectId,
      engine,
      sdkSessionId: null,
      status: 'working',
      statusDetail: null,
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: nowIso(),
      endedAt: null,
      endReason: null,
      bypassPermissions,
      planMode: mode === 'plan',
      inPlanMode: mode === 'plan',
    }
    this.repos.sessions.insert(row)

    const workdir = opts?.cwd ?? project.path

    const entry: HostedEntry = {
      row,
      projectPath: workdir,
      seq: this.repos.events.maxSeq(row.id),
      live: new Map(),
      containerised,
      background: opts?.background === true,
      ranATurn: false,
      session: null as unknown as SessionHost,
      nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
    }

    const settings = this.repos.settings.get()
    const { intelligentModel, workerModel } = this.resolveModelRouting()
    const activeCombo = settings.mcpActiveServers ?? []
    const schemaDoc = (
      (activeCombo.length > 0 ? readComboDoc(project.path, activeCombo) : null) ??
      readSchemaDoc(project.path)
    )?.trim()
    const schemaAppend = schemaDoc
      ? `## Database schema (from a previous MCP scan)\n\n${schemaDoc}`
      : null
    const effort = opts?.effort ?? settings.effort
    const basic = settings.modelMode === 'basic'
    const subagents = !basic && subagentsAllowed(effort)
    const heavySubagents = subagents && settings.subagentEffort === 'max'
    row.heavySubagents = heavySubagents
    const heavyAppend = heavySubagentSystemPromptAppend(heavySubagents)
    const modesAppend = modesSystemPromptAppend(
      subagents ? heavySubagentModelMode(heavySubagents, settings.modelMode ?? 'auto') : 'basic',
    )
    const carried = carryTranscriptFrom ? transcriptFor(carryTranscriptFrom) : null
    const transcriptAppend = carried ? transcriptContextAppend(carried) : null
    const sandboxAppend = containerised
      ? sandboxSystemPromptAppend(
          [{ container: '/workspace' }, ...refMounts(project.refs.map((r) => r.path))],
          gitNotice(project.path),
          hasNodeModulesVolume(project.path),
        )
      : null
    try {
      entry.session =
        engine === 'codex'
          ? new CodexSession({
              sessionId: row.id,
              projectPath: workdir,
              model: settings.codexModel || undefined,
              effort,
              mode,
              resumeThreadId: resumeSdkSessionId,
              sink: this.makeSink(entry),
              onStatusChange: (status, detail) => this.handleStatusChange(entry, status, detail),
              onSdkSessionId: (sdkSessionId) => {
                entry.row.sdkSessionId = sdkSessionId
                this.repos.sessions.update(row.id, { sdkSessionId })
              },
              onModel: (model) => {
                entry.row.currentModel = model
                this.pushStatus(entry)
              },
              onModelUsage: (modelUsage) => {
                entry.row.modelTotals = foldModelTotals(entry.row.modelTotals ?? {}, modelUsage)
                this.pushStatus(entry)
              },
              onTurnComplete: () => {
                entry.ranATurn = true
                this.observeBranch(entry)
                this.maybeDrainQueue(entry.row.projectId)
              },
              onExit: (reason, detail) => this.handleExit(entry, reason, detail),
            })
          : new HostedSession({
        sessionId: row.id,
        projectPath: workdir,
        refDirs: project.refs.map((r) => r.path),
        sandboxMemory: settings.sandboxMemory,
        resumeSdkSessionId,
        resumeFromSessionId,
        systemPromptAppend:
          [
            sandboxAppend,
            modesAppend,
            heavyAppend,
            schemaAppend,
            transcriptAppend,
          ]
            .filter((s): s is string => Boolean(s))
            .join('\n\n') || undefined,
        claudeExecutablePath: claudeExecutablePath ?? undefined,
        mainModel: opts?.workerMainLoop
          ? workerModel
          : mainLoopModel(settings.modelMode, { intelligentModel, workerModel }),
        workerMainLoop: opts?.workerMainLoop,
        strongModel: intelligentModel,
        workerModel,
        autoModelRouting: !basic && settings.autoModelRouting,
        modelMode: settings.modelMode,
        effort,
        subagents,
        subagentEffort: settings.subagentEffort,
        resolveModels: () => this.resolveModelRouting(),
        onTurnMode: (mode) => {
          if (entry.row.currentMode === mode) return
          entry.row.currentMode = mode
          this.pushStatus(entry)
        },
        mode,
        containerised,
        nodeModulesVolumeKey: opts?.nodeModulesVolumeKey,
        onPlanModeChange: (inPlanMode) => {
          if (entry.row.inPlanMode === inPlanMode) return
          entry.row.inPlanMode = inPlanMode
          this.pushStatus(entry)
        },
        summaries: settings.summaries,
        mcpServers: {
          switchboard: switchboardMcp({
            from: project.name,
            projects: () => this.repos.projects.listActive(),
            enqueue: (targetId, text) => this.enqueueTask(targetId, text),
            isRunning: (targetId) => this.liveEntryForProject(targetId) !== undefined,
            start: (targetId) => this.startSession(targetId),
            overview: () =>
              this.repos.projects.listActive().map((p) => {
                const live = this.liveEntryForProject(p.id)
                return {
                  name: p.name,
                  running: live !== undefined,
                  status: live?.session.currentStatus,
                  queued: this.listQueue(p.id).length,
                }
              }),
          }),
        },
        sink: this.makeSink(entry),
        gate: this.callbacks.gate,
        onStatusChange: (status, detail) => this.handleStatusChange(entry, status, detail),
        onSdkSessionId: (sdkSessionId) => {
          entry.row.sdkSessionId = sdkSessionId
          this.repos.sessions.update(row.id, { sdkSessionId })
        },
        onCommands: (commands) => {
          if (containerised) return
          this.repos.projectCommands.set(projectId, commands)
          this.callbacks.onProjectCommands(projectId, commands)
        },
        onUsage: (usage) => {
          entry.row.usageUtilization = usage.utilization
          entry.row.usageResetsAt = usage.resetsAt
          entry.row.usageLimitType = usage.limitType
          this.repos.sessions.update(row.id, {
            usageUtilization: usage.utilization,
            usageResetsAt: usage.resetsAt,
            usageLimitType: usage.limitType,
          })
          this.pushStatus(entry)
        },
        onMcpServers: (servers) => {
          entry.row.mcpServers = servers
          this.pushStatus(entry)
        },
        onModel: (model) => {
          entry.row.currentModel = model
          this.pushStatus(entry)
        },
        onModels: (models) => {
          this.availableModels = models
        },
        onBackgroundTasks: (tasks) => {
          entry.row.backgroundTasks = tasks
          this.pushStatus(entry)
        },
        onModelUsage: (modelUsage) => {
          entry.row.modelTotals = foldModelTotals(entry.row.modelTotals ?? {}, modelUsage)
          this.pushStatus(entry)
        },
        onTurnComplete: () => {
          entry.ranATurn = true
          this.observeBranch(entry)
          this.maybeDrainQueue(entry.row.projectId)
          if (this.diagramWatch.delete(row.id)) {
            this.callbacks.onDiagramsChanged(projectId)
          }
        },
        onExit: (reason, detail) => this.handleExit(entry, reason, detail),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.failStart(row, detail)
      throw {
        code: 'INTERNAL',
        message: `Session failed to start: ${detail}`,
      } satisfies IpcError
    }

    this.hosted.set(row.id, entry)
    entry.session.start()
    void this.refreshBranch(entry)
    this.callbacks.onCountersChanged()
    this.maybeDrainQueue(projectId)
    return { ...entry.row }
  }

  listQueue(projectId: string): QueuedTask[] {
    return this.repos.taskQueue.listForProject(projectId)
  }

  enqueueTask(projectId: string, text: string): void {
    if (text.trim().length === 0) return
    this.repos.taskQueue.add(projectId, text)
    this.callbacks.onQueueChanged(projectId)
    this.maybeDrainQueue(projectId)
  }

  editTask(projectId: string, id: string, text: string): void {
    this.repos.taskQueue.update(id, text)
    this.callbacks.onQueueChanged(projectId)
  }

  removeTask(projectId: string, id: string): void {
    this.repos.taskQueue.remove(id)
    this.callbacks.onQueueChanged(projectId)
  }

  markSection(sessionId: string, kind: SectionKind): void {
    const entry = this.hosted.get(sessionId)
    if (entry) entry.sectionKind = kind
    this.repos.sessions.update(sessionId, { sectionKind: kind })
  }

  workdirFor(sessionId: string): string | undefined {
    return this.hosted.get(sessionId)?.projectPath
  }

  liveEntryForProject(projectId: string): HostedEntry | undefined {
    return [...this.hosted.values()].find((e) => e.row.projectId === projectId)
  }

  private maybeDrainQueue(projectId: string): void {
    const entry = this.liveEntryForProject(projectId)
    if (!entry || entry.session.currentStatus !== 'done') return
    const next = this.repos.taskQueue.takeNext(projectId)
    if (!next) return
    this.callbacks.onQueueChanged(projectId)
    this.sendMessage(entry.row.id, next.text)
  }

  editQueuedSend(sessionId: string, eventId: string, text: string): void {
    const entry = this.requireLive(sessionId)
    if (!entry.session.editQueuedSend(eventId, text)) {
      throw {
        code: 'NOT_FOUND',
        message: 'That message has already been sent, so it can no longer be changed.',
      } satisfies IpcError
    }
  }

  sendMessage(sessionId: string, text: string, agentId?: string): { eventId: string; queued: boolean } {
    const entry = this.requireLive(sessionId)
    const send = entry.session.send(text)
    const sink = this.makeSink(entry)
    const event = sink.append('prompt', { text, pending: send.queued, agentId })
    this.repos.commandHistory.add(entry.row.projectId, text)
    send.deliver(event.id)
    return { eventId: event.id, queued: send.queued }
  }

  clearBackgroundTasks(sessionId: string): void {
    const entry = this.requireLive(sessionId)
    entry.session.clearBackgroundTasks()
    this.maybeDrainQueue(entry.row.projectId)
  }

  async interruptSession(sessionId: string): Promise<{ stillQueued: number }> {
    const entry = this.requireLive(sessionId)
    return entry.session.interrupt()
  }

  setPlanMode(sessionId: string, enabled: boolean): void {
    const entry = this.requireLive(sessionId)
    if (entry.row.bypassPermissions) {
      throw {
        code: 'RULE_NOT_ALLOWED',
        message: 'A bypass session approves everything, so it has nothing to plan against.',
      } satisfies IpcError
    }
    entry.session.setPlanMode(enabled)
    entry.row.inPlanMode = enabled
    this.pushStatus(entry)
  }

  planExited(sessionId: string): void {
    const entry = this.hosted.get(sessionId)
    if (!entry || !entry.row.inPlanMode) return
    entry.row.inPlanMode = false
    this.pushStatus(entry)
  }

  async backgroundSessionFor(projectId: string, kind: SectionKind): Promise<Session> {
    if (!NEVER_REUSED.has(kind)) {
      for (const entry of this.hosted.values()) {
        if (entry.row.projectId !== projectId) continue
        if (entry.sectionKind !== kind || entry.row.endedAt) continue
        return { ...entry.row }
      }
    }
    return this.startBackground(projectId, kind)
  }

  async diagramSessionFor(projectId: string): Promise<Session> {
    return this.backgroundSessionFor(projectId, 'diagram')
  }

  private async startBackground(projectId: string, kind: SectionKind): Promise<Session> {
    const project = this.repos.projects.byId(projectId)
    const containerised = project?.useContainers === true
    const mode = project?.defaultSessionMode === 'bypass' ? 'acceptEdits' : project?.defaultSessionMode
    const session = await this.startSession(projectId, false, mode, undefined, {
      containerised,
      background: true,
      engine: 'claude',
      workerMainLoop: WORKER_KINDS.has(kind),
    })
    const entry = this.hosted.get(session.id)
    if (entry) entry.sectionKind = kind
    this.repos.sessions.update(session.id, { sectionKind: kind })
    session.sectionKind = kind
    return session
  }

  sectionKinds(projectId: string): Record<string, SectionKind> {
    const kinds: Record<string, SectionKind> = {}
    for (const entry of this.hosted.values()) {
      if (entry.row.projectId === projectId && entry.sectionKind) {
        kinds[entry.row.id] = entry.sectionKind
      }
    }
    return kinds
  }

  isolatedSuiteNamesFor(projectId: string): Record<string, string> {
    const names: Record<string, string> = {}
    for (const entry of this.hosted.values()) {
      const suite = this.isolatedSuiteNames.get(entry.row.id)
      if (suite && entry.row.projectId === projectId) names[entry.row.id] = suite
    }
    return names
  }

  private completing = new Set<string>()

  freezeDerivedName(sessionId: string, derivedName: string): void {
    const entry = this.hosted.get(sessionId)
    if (entry?.row.derivedName) return
    if (entry) entry.row.derivedName = derivedName
    this.repos.sessions.update(sessionId, { derivedName })
  }

  renameSession(sessionId: string, label: string): void {
    const trimmed = label.trim()
    const value = trimmed === '' ? null : trimmed.slice(0, 60)
    if (!this.repos.sessions.byId(sessionId)) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
    }
    this.repos.sessions.update(sessionId, { label: value })
    const entry = this.hosted.get(sessionId)
    if (entry) {
      entry.row.label = value
      this.pushStatus(entry)
    }
  }

  async cancelSecurityRun(runId: string): Promise<void> {
    const run = this.repos.securityRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.status !== 'running') return
    if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
    this.securityWatch.delete(run.sessionId ?? '')
    this.repos.securityRuns.finish(runId, 'failed', readAuditReport(run.outputDir), CANCEL_NOTE)
    this.callbacks.onSecurityChanged(run.projectId)
  }

  async cancelVerifyRun(runId: string): Promise<void> {
    const run = this.repos.verifyRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.status !== 'running') return
    const isolated = this.isolatedRuns.get(runId)
    if (isolated) {
      isolated.cancelled = true
      if (isolated.sessionId) await this.interruptSession(isolated.sessionId).catch(() => {})
    } else {
      if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
      this.verifyWatch.delete(run.sessionId ?? '')
    }
    this.repos.verifyRuns.finish(runId, 'inconclusive', null, CANCEL_NOTE)
    this.callbacks.onVerifyChanged(run.projectId)
  }

  async cancelApiRun(runId: string): Promise<void> {
    const run = this.repos.apiRuns.byId(runId)
    if (!run) throw { code: 'NOT_FOUND', message: 'Run not found' } satisfies IpcError
    if (run.status !== 'running') return
    if (run.sessionId) await this.interruptSession(run.sessionId).catch(() => {})
    this.apiWatch.delete(run.sessionId ?? '')
    this.repos.apiRuns.finish(runId, 'error', run.calls, CANCEL_NOTE, run.launched)
    this.callbacks.onApiChanged(run.projectId)
  }

  async stopSession(sessionId: string, note?: string): Promise<void> {
    const entry = this.requireLive(sessionId)
    if (note) entry.row.statusDetail = note
    for (const queued of entry.session.takeQueuedSends()) {
      this.repos.drafts.insert(entry.row.projectId, queued.text)
    }
    await entry.session.stop()
  }

  async endAllForAppExit(): Promise<void> {
    this.quitting = true
    const entries = [...this.hosted.values()]
    for (const entry of entries) {
      for (const queued of entry.session.takeQueuedSends()) {
        this.repos.drafts.insert(entry.row.projectId, queued.text)
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.session.stop()))
    for (const entry of entries) {
      entry.row.statusDetail ??= 'Switchboard closed, so this session ended. Its conversation can be resumed.'
      this.finaliseRow(entry, 'app_exit') 
    }
    this.hosted.clear()
  }

  anySessionMidTask(): boolean {
    return [...this.hosted.values()].some((entry) => entry.session.isMidTask)
  }

  liveSessionRow(sessionId: string): Session | undefined {
    const entry = this.hosted.get(sessionId)
    return entry ? { ...entry.row } : undefined
  }

  liveSessionIds(): string[] {
    return [...this.hosted.keys()]
  }

  async reloadPlugins(): Promise<void> {
    await Promise.allSettled([...this.hosted.values()].map((entry) => entry.session.reloadPlugins()))
  }

  async connectedMcpServers(sessionId: string, wanted: readonly string[], timeoutMs = 8000): Promise<string[]> {
    const connected = (): string[] =>
      (this.hosted.get(sessionId)?.row.mcpServers ?? [])
        .filter((s) => s.status.toLowerCase() === 'connected')
        .map((s) => s.name)

    if (wanted.length === 0) return []
    const deadline = Date.now() + timeoutMs
    let live = connected()
    while (Date.now() < deadline && !wanted.every((name) => live.includes(name))) {
      await delay(150)
      if (!this.hosted.has(sessionId)) break
      live = connected()
    }
    return wanted.filter((name) => live.includes(name))
  }

  private evalWatch = new Map<string, { evalId: string; kind: 'check' | 'judge' }>()

  watchEvalMarker(sessionId: string, evalId: string, kind: 'check' | 'judge'): void {
    this.evalWatch.set(sessionId, { evalId, kind })
  }

  private static readonly EVAL_SCAN_KINDS = new Set<EventKind>(['assistant_text', 'summary', 'result'])

  private closeUnreportedEval(entry: HostedEntry): void {
    this.evalWatch.delete(entry.row.id)
  }

  private scanEvalMarker(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.evalWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const marker = parseEvalMarker(text)
    if (!marker || marker.kind !== watch.kind) return
    this.evalWatch.delete(entry.row.id)
    this.repos.evals.update(
      watch.evalId,
      marker.kind === 'check' ? { checkStatus: marker.status } : { judge: marker.verdict },
    )
    this.callbacks.onEvalsChanged(entry.row.projectId)
  }

  private verifyWatch = new Map<
    string,
    { runId: string; kind: 'suites' | 'evidence'; sawBrokenMarker?: boolean }
  >()

  watchVerifyReport(sessionId: string, runId: string, kind: 'suites' | 'evidence'): void {
    const existing = this.verifyWatch.get(sessionId)
    if (existing && existing.runId !== runId) {
      const entry = this.hosted.get(sessionId)
      if (existing.kind === 'suites') {
        this.repos.verifyRuns.finish(
          existing.runId,
          'inconclusive',
          null,
          'Another verification pass was started before this one reported, so its result line was never read.',
        )
        if (entry) this.callbacks.onVerifyChanged(entry.row.projectId)
      }
    }
    this.verifyWatch.set(sessionId, { runId, kind })
  }

  private scanMarkers(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    this.scanEvalMarker(entry, kind, payload)
    this.scanVerifyReport(entry, kind, payload)
    this.scanSecurityReport(entry, kind, payload)
    this.scanFlowMarker(entry, kind, payload)
    this.scanIsolatedSuiteReport(entry, kind, payload)
    this.scanApiRequests(entry, kind, payload)
    this.scanDiagramPlan(entry, kind, payload)
  }

  private scanDiagramPlan(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    if (!SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const plan = parseDiagramPlan(text)
    if (!plan) return
    const file = this.repos.diagramRequests.latestFileFor(entry.row.projectId)
    if (!file) return
    this.repos.diagramRequests.notePlan(entry.row.projectId, file, plan)
  }

  private flowWatch = new Set<string>()

  private flowHooks: {
    onMarker: (sessionId: string, marker: FlowMarker) => void
    onSessionEnded: (sessionId: string, reason: SessionEndReason | 'crashed') => void
    onVerifyReport: (sessionId: string, report: VerifyReport) => void
    onTurnEnded: (sessionId: string) => void
  } | null = null

  setFlowHooks(hooks: {
    onMarker: (sessionId: string, marker: FlowMarker) => void
    onSessionEnded: (sessionId: string, reason: SessionEndReason | 'crashed') => void
    onVerifyReport: (sessionId: string, report: VerifyReport) => void
    onTurnEnded: (sessionId: string) => void
  }): void {
    this.flowHooks = hooks
  }

  watchFlow(sessionId: string): void {
    this.flowWatch.add(sessionId)
  }

  hasFlowWatch(sessionId: string): boolean {
    return this.flowWatch.has(sessionId)
  }

  private scanFlowMarker(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    if (!this.flowWatch.has(entry.row.id) || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const marker = parseFlowMarker(text)
    if (marker) {
      this.flowHooks?.onMarker(entry.row.id, marker)
      return
    }
    const report = parseVerifyReport(text)
    if (report) this.flowHooks?.onVerifyReport(entry.row.id, report)
  }

  private closeUnreportedFlow(entry: HostedEntry, reason: SessionEndReason | 'crashed'): void {
    if (!this.flowWatch.delete(entry.row.id)) return
    this.flowHooks?.onSessionEnded(entry.row.id, reason)
  }

  private securityWatch = new Map<string, { runId: string; outputDir: string }>()

  watchSecurityRun(sessionId: string, runId: string, outputDir: string): void {
    this.securityWatch.set(sessionId, { runId, outputDir })
  }

  private scanSecurityReport(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.securityWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text || !auditDone(text)) return
    this.securityWatch.delete(entry.row.id)
    this.settleSecurityRun(watch.runId, watch.outputDir, entry.row.projectId)
  }

  private settleSecurityRun(runId: string, outputDir: string, projectId: string): void {
    const report = readAuditReport(outputDir)
    if (report) {
      this.repos.securityRuns.finish(runId, 'complete', report, null)
    } else {
      this.repos.securityRuns.finish(
        runId,
        'failed',
        null,
        'The audit reported it was done, but no findings or coverage ledger was written where the run asked for them.',
      )
    }
    this.callbacks.onSecurityChanged(projectId)
  }

  private closeUnreportedSecurity(entry: HostedEntry): void {
    const watch = this.securityWatch.get(entry.row.id)
    if (!watch) return
    this.securityWatch.delete(entry.row.id)
    const report = readAuditReport(watch.outputDir)
    if (report) {
      this.repos.securityRuns.finish(watch.runId, 'complete', report, 'The session ended before it said it was done, so this is what it had written.')
    } else {
      this.repos.securityRuns.finish(
        watch.runId,
        'failed',
        null,
        'The session ended before the audit wrote anything.',
      )
    }
    this.callbacks.onSecurityChanged(entry.row.projectId)
  }

  private apiWatch = new Map<string, { runId: string }>()

  watchApiRequests(sessionId: string, runId: string): void {
    this.apiWatch.set(sessionId, { runId })
  }

  private diagramWatch = new Map<string, { file: string | null }>()

  watchDiagram(sessionId: string, file?: string): void {
    this.diagramWatch.set(sessionId, { file: file ?? null })
  }

  private scanApiRequests(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.apiWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const requests = parseApiRequests(text)
    if (!requests) return
    this.apiWatch.delete(entry.row.id)
    this.callbacks.onApiRequests(entry.row.projectId, watch.runId, requests)
  }

  private closeUnreportedApi(entry: HostedEntry): void {
    const watch = this.apiWatch.get(entry.row.id)
    if (!watch) return
    this.apiWatch.delete(entry.row.id)
    this.callbacks.onApiRequests(entry.row.projectId, watch.runId, [])
  }

  private scanVerifyReport(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.verifyWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const progress = parseSuiteProgress(text)
    if (progress && watch.kind !== 'evidence') {
      this.repos.verifyRuns.noteSuite(watch.runId, progress)
      this.callbacks.onVerifyChanged(entry.row.projectId)
    }
    const report = parseVerifyReport(text)
    if (!report) {
      if (verifyMarkerBroken(text)) watch.sawBrokenMarker = true
      return
    }
    this.verifyWatch.delete(entry.row.id)
    if (watch.kind === 'evidence') {
      this.repos.verifyRuns.attachEvidence(watch.runId, report.evidence)
    } else {
      const settled = this.settleAgainstArtefacts(watch.runId, entry.row.projectId, report)
      this.repos.verifyRuns.finish(watch.runId, verifyVerdict(settled.report), settled.report, settled.note)
    }
    this.callbacks.onVerifyChanged(entry.row.projectId)
  }

  private settleAgainstArtefacts(
    runId: string,
    projectId: string,
    report: VerifyReport,
  ): { report: VerifyReport; note: string | null } {
    const project = this.repos.projects.byId(projectId)
    const run = this.repos.verifyRuns.byId(runId)
    if (!project || !run) return { report, note: null }
    let settled: ReturnType<typeof reconcile>
    try {
      settled = reconcile(report, scanArtefacts(project.path, Date.parse(run.startedAt)))
    } catch {
      return { report, note: null }
    }
    if (settled.disagreements.length === 0) return { report: settled.report, note: null }
    return {
      report: settled.report,
      note:
        'The run reported figures its own artefacts contradict, and the artefacts were taken: ' +
        settled.disagreements
          .map((d) => `${d.about} — reported ${d.said}, measured ${d.measured}`)
          .join('; '),
    }
  }

  private closeUnreportedVerify(entry: HostedEntry): void {
    const watch = this.verifyWatch.get(entry.row.id)
    if (!watch) return
    this.verifyWatch.delete(entry.row.id)
    if (watch.kind === 'suites') {
      this.repos.verifyRuns.finish(
        watch.runId,
        'inconclusive',
        null,
        watch.sawBrokenMarker
          ? 'The session reported a result line this app could not read as JSON — open its output to see what it sent.'
          : 'The session finished the turn without reporting a result line — open its output to see what ran.',
      )
    }
    this.callbacks.onVerifyChanged(entry.row.projectId)
  }

  private isolatedSuiteNames = new Map<string, string>()

  private isolatedSuiteWatch = new Map<string, { suite: TestSuite; settle: (result: SuiteResult) => void }>()

  private scanIsolatedSuiteReport(entry: HostedEntry, kind: EventKind, payload: unknown): void {
    const watch = this.isolatedSuiteWatch.get(entry.row.id)
    if (!watch || !SessionManager.EVAL_SCAN_KINDS.has(kind)) return
    const text = (payload as { text?: string }).text
    if (!text) return
    const report = parseVerifyReport(text)
    const result = report?.suites[0]
    if (!result) return
    watch.settle(result)
  }

  private closeUnreportedIsolatedSuite(entry: HostedEntry): void {
    const watch = this.isolatedSuiteWatch.get(entry.row.id)
    if (!watch) return
    watch.settle({
      id: watch.suite.id,
      label: watch.suite.label,
      status: 'not_run',
      detail: 'The session ended before this suite reported a result — open its output to see what ran.',
    })
  }

  private waitForIsolatedSuite(sessionId: string, suite: TestSuite): Promise<SuiteResult> {
    return new Promise<SuiteResult>((resolve) => {
      let settled = false
      const settle = (result: SuiteResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.isolatedSuiteWatch.delete(sessionId)
        resolve(result)
      }
      const timer = setTimeout(() => {
        settle({
          id: suite.id,
          label: suite.label,
          status: 'not_run',
          detail:
            'This suite went quiet for long enough that its session is presumed dead, so nothing it measured is known.',
        })
      }, RUN_DEADLINE_MS)
      timer.unref?.()
      this.isolatedSuiteWatch.set(sessionId, { suite, settle })
    })
  }

  private isolatedRuns = new Map<string, { cancelled: boolean; sessionId: string | null }>()

  async runSuitesIsolated(input: {
    runId: string
    projectId: string
    plan: PlannedSuite[]
    stackLabel: string
    sandboxed: SandboxEnv
    dbServers: readonly string[]
  }): Promise<void> {
    const { runId, projectId, plan, stackLabel, sandboxed, dbServers } = input
    const control: { cancelled: boolean; sessionId: string | null } = { cancelled: false, sessionId: null }
    this.isolatedRuns.set(runId, control)
    const provedNothing: string[] = []
    try {
      for (const planned of plan) {
        if (control.cancelled) break
        if (planned.unavailable) continue
        const result = await this.runOneIsolatedSuite(
          runId,
          projectId,
          planned,
          stackLabel,
          sandboxed,
          dbServers,
          control,
        )
        this.repos.verifyRuns.noteSuite(runId, result)
        this.callbacks.onVerifyChanged(projectId)
        if (result.status === 'not_run') provedNothing.push(result.id)
      }
    } finally {
      this.isolatedRuns.delete(runId)
      removeNodeModulesVolume(runId)
    }
    const run = this.repos.verifyRuns.byId(runId)
    if (!run || run.status !== 'running') return
    const report = run.report ?? emptyVerifyReport()
    const note =
      provedNothing.length > 0
        ? `${provedNothing.length === 1 ? 'This suite' : 'These suites'} proved nothing: ${provedNothing.join(', ')}.`
        : null
    this.repos.verifyRuns.finish(runId, verifyVerdict(report), report, note)
    this.callbacks.onVerifyChanged(projectId)
  }

  private async runOneIsolatedSuite(
    runId: string,
    projectId: string,
    planned: PlannedSuite,
    stackLabel: string,
    sandboxed: SandboxEnv,
    dbServers: readonly string[],
    control: { cancelled: boolean; sessionId: string | null },
  ): Promise<SuiteResult> {
    let session: Session
    try {
      session = await this.startSession(projectId, false, undefined, undefined, {
        containerised: true,
        background: true,
        engine: 'claude',
        nodeModulesVolumeKey: runId,
      })
    } catch (error) {
      return {
        id: planned.suite.id,
        label: planned.suite.label,
        status: 'not_run',
        detail: errorMessage(error),
      }
    }
    control.sessionId = session.id
    const suiteEntry = this.hosted.get(session.id)
    if (suiteEntry) suiteEntry.sectionKind = 'tests'
    this.repos.sessions.update(session.id, { sectionKind: 'tests' })
    this.isolatedSuiteNames.set(session.id, planned.suite.label)
    try {
      if (control.cancelled) {
        return { id: planned.suite.id, label: planned.suite.label, status: 'not_run', detail: CANCEL_NOTE }
      }
      const settle = this.waitForIsolatedSuite(session.id, planned.suite)
      this.sendMessage(session.id, verifyPrompt([planned], stackLabel, sandboxed, dbServers))
      return await settle
    } finally {
      control.sessionId = null
      await this.stopSession(session.id, 'This suite ran in its own container, which closed when the suite finished.').catch(() => {
      })
    }
  }

  sinkFor(sessionId: string): EventSink {
    const entry = this.hosted.get(sessionId)
    if (!entry) throw { code: 'SESSION_ENDED', message: 'Session is no longer active' } satisfies IpcError
    return this.makeSink(entry)
  }

  attentionRaised(sessionId: string): void {
    this.hosted.get(sessionId)?.session.attentionRaised()
  }

  attentionCleared(sessionId: string): void {
    this.hosted.get(sessionId)?.session.attentionCleared()
  }

  private requireLive(sessionId: string): HostedEntry {
    const entry = this.hosted.get(sessionId)
    if (!entry) {
      const row = this.repos.sessions.byId(sessionId)
      if (!row) throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
      throw { code: 'SESSION_ENDED', message: 'Session has ended' } satisfies IpcError
    }
    return entry
  }

  private makeSink(entry: HostedEntry): EventSink {
    return {
      append: <K extends EventKind>(
        kind: K,
        payload: EventPayloadMap[K],
        options?: { persist?: boolean },
      ): SessionEvent<K> => {
        entry.seq += 1
        const event: SessionEvent = {
          id: newId(),
          sessionId: entry.row.id,
          seq: entry.seq,
          kind,
          payload,
          noiseKind: null,
          createdAt: nowIso(),
        }
        if (SWALLOWABLE_KINDS.includes(kind) && this.classifier) {
          event.noiseKind = this.classifier(event)
        }
        const persist = options?.persist !== false
        if (persist) this.repos.events.insert(event)
        if (UPDATABLE_KINDS.has(kind)) {
          entry.live.set(event.id, { event, persisted: persist })
          evictStaleLive(entry)
        }
        this.scanMarkers(entry, kind, payload)
        if (persist && TRANSCRIBED_KINDS.has(kind)) this.scheduleTranscript(entry.row.id)
        this.callbacks.onEvent({ ...event })
        return event as SessionEvent<K>
      },
      update: <K extends EventKind>(
        eventId: string,
        payload: EventPayloadMap[K],
        options?: { persist?: boolean; kind?: K },
      ): void => {
        const liveEntry = entry.live.get(eventId)
        if (!liveEntry) return
        liveEntry.event.payload = payload
        if (options?.kind) liveEntry.event.kind = options.kind
        liveEntry.event.noiseKind =
          SWALLOWABLE_KINDS.includes(liveEntry.event.kind) && this.classifier
            ? this.classifier(liveEntry.event)
            : null
        if (liveEntry.persisted) {
          this.repos.events.setNoiseKind(eventId, liveEntry.event.noiseKind)
        }
        if (options?.persist) {
          if (liveEntry.persisted) {
            if (options.kind) {
              this.repos.events.updatePayload(eventId, payload, liveEntry.event.kind)
            } else {
              this.repos.events.updatePayload(eventId, payload)
            }
          } else {
            this.repos.events.insert(liveEntry.event)
            liveEntry.persisted = true
          }
        }
        this.scanMarkers(entry, liveEntry.event.kind, payload)
        this.callbacks.onEvent({ ...liveEntry.event })
      },
    }
  }

  private handleStatusChange(entry: HostedEntry, status: SessionStatus, detail?: string | null): void {
    if (!this.hosted.has(entry.row.id)) return
    if (status === 'done' || status === 'error') {
      this.closeUnreportedVerify(entry)
      this.closeUnreportedApi(entry)
      this.closeUnreportedEval(entry)
      this.closeUnreportedIsolatedSuite(entry)
      this.closeUnreportedSecurity(entry)
    }
    entry.row.status = status
    entry.row.statusDetail = detail ?? null
    this.repos.sessions.update(entry.row.id, { status, statusDetail: detail ?? null })
    this.pushStatus(entry)
    this.callbacks.onCountersChanged()
    if (status === 'done') {
      if (this.flowWatch.has(entry.row.id)) this.flowHooks?.onTurnEnded(entry.row.id)
      void this.endIfIdleBackground(entry)
    }
  }

  private async endIfIdleBackground(entry: HostedEntry): Promise<void> {
    if (!entry.background) return
    if (!entry.ranATurn) return
    const id = entry.row.id
    if (
      this.verifyWatch.has(id) ||
      this.apiWatch.has(id) ||
      this.evalWatch.has(id) ||
      this.diagramWatch.has(id) ||
      this.securityWatch.has(id)
    ) {
      return
    }
    if (this.flowWatch.has(id)) return
    if (this.repos.taskQueue.listForProject(entry.row.projectId).length > 0) return
    if (!this.hosted.has(id)) return
    this.completing.add(id)
    await this.stopSession(
      id,
      'This session was opened for one piece of section work, and closed itself when that work finished.',
    )
  }

  private async refreshBranch(entry: HostedEntry): Promise<void> {
    const branch = await readGitBranch(entry.projectPath)
    if (branch === entry.row.branch) return
    entry.row.branch = branch
    this.repos.sessions.update(entry.row.id, { branch })
    this.pushStatus(entry)
  }

  private observeBranch(entry: HostedEntry): void {
    void this.refreshBranch(entry)
    void readNumstat(entry.projectPath).then(({ totals }) => {
      const adds = totals?.adds ?? null
      const dels = totals?.dels ?? null
      if (adds === entry.row.diffAdds && dels === entry.row.diffDels) return
      entry.row.diffAdds = adds
      entry.row.diffDels = dels
      this.repos.sessions.update(entry.row.id, { diffAdds: adds, diffDels: dels })
      this.pushStatus(entry)
    })
    this.callbacks.onCountersChanged()
  }

  private handleExit(entry: HostedEntry, reason: 'completed' | 'stopped' | 'crashed', detail?: string): void {
    if (reason === 'stopped' && this.completing.delete(entry.row.id)) reason = 'completed'
    if (!this.hosted.has(entry.row.id)) return
    this.closeUnreportedVerify(entry)
    this.closeUnreportedApi(entry)
    this.closeUnreportedEval(entry)
    this.closeUnreportedIsolatedSuite(entry)
    this.closeUnreportedSecurity(entry)
    this.closeUnreportedFlow(entry, reason === 'crashed' ? 'crashed' : (entry.row.endReason ?? 'completed'))
    if (this.diagramWatch.delete(entry.row.id)) {
      this.callbacks.onDiagramsChanged(entry.row.projectId)
    }
    if (reason === 'crashed') {
      entry.row.status = 'error'
      entry.row.statusDetail = detail ?? 'Session process ended unexpectedly'
    }
    this.finaliseRow(entry, reason)
    this.hosted.delete(entry.row.id)
    this.callbacks.onSessionExit(entry.row.id)
    this.callbacks.onCountersChanged()
    if (reason === 'crashed') this.reviveCrashed(entry, detail)
  }

  private reviveCrashed(entry: HostedEntry, detail?: string): void {
    if (this.quitting || entry.background) return
    const projectId = entry.row.projectId
    const since = Date.now() - (this.revivedAt.get(projectId) ?? 0)
    if (since < REVIVE_COOLDOWN_MS) return
    this.revivedAt.set(projectId, Date.now())
    void (async () => {
      try {
        const revived = await this.startSession(projectId, true, undefined, undefined, {
          engine: entry.row.engine,
        })
        this.sendMessage(
          revived.id,
          'Switchboard restarted this session: the previous process ended unexpectedly ' +
            `(${detail ?? 'no reason reported'}), so this conversation was resumed from its ` +
            'transcript. Whatever you were part-way through may have half-finished — check ' +
            'the state on disk before continuing, then carry on with the work.',
        )
      } catch {
      }
    })()
  }

  saveTranscript(sessionId: string): TranscriptSummary {
    const row = this.hosted.get(sessionId)?.row ?? this.repos.sessions.byId(sessionId)
    if (!row) throw { code: 'NOT_FOUND', message: 'Session not found' } satisfies IpcError
    const project = this.repos.projects.byId(row.projectId)
    const events = this.repos.events.page(sessionId, undefined, TRANSCRIPT_EVENT_CAP)
    return writeTranscript(row, project?.name ?? row.projectId, events)
  }

  private scheduleTranscript(sessionId: string): void {
    const pending = this.transcriptTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.transcriptTimers.delete(sessionId)
      try {
        this.saveTranscript(sessionId)
      } catch {
      }
    }, TRANSCRIPT_DEBOUNCE_MS)
    timer.unref?.()
    this.transcriptTimers.set(sessionId, timer)
  }

  private flushTranscript(sessionId: string): void {
    const pending = this.transcriptTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    this.transcriptTimers.delete(sessionId)
    try {
      this.saveTranscript(sessionId)
    } catch {
    }
  }

  private finaliseRow(entry: HostedEntry, reason: Session['endReason']): void {
    if (entry.row.endedAt) return
    entry.row.endedAt = nowIso()
    entry.row.endReason = reason
    this.repos.sessions.update(entry.row.id, {
      status: entry.row.status,
      statusDetail: entry.row.statusDetail,
      endedAt: entry.row.endedAt,
      endReason: reason,
    })
    this.flushTranscript(entry.row.id)
    if (entry.containerised && !entry.nodeModulesVolumeKey) removeNodeModulesVolume(entry.row.id)
    this.pushStatus(entry)
  }

  private pushStatus(entry: HostedEntry): void {
    this.callbacks.onSessionStatus({ ...entry.row })
  }

  private refuseWhenContainersFull(): void {
    const hostedCount = [...this.hosted.values()].filter((e) => e.containerised && !e.row.endedAt).length
    const total = hostedCount + this.reservedContainerIds.size
    if (total < MAX_CONTAINERS) return
    throw {
      code: 'SANDBOX_FULL',
      message:
        `${total} sessions already run in a container, which is the limit: they share one ` +
        'virtual machine, and one more can exhaust it and kill a session that did nothing wrong. ' +
        'End one of them, then start this again.',
    } satisfies IpcError
  }

  private failStart(row: Session, detail: string): void {
    row.status = 'error'
    row.statusDetail = detail
    row.endedAt = nowIso()
    row.endReason = 'crashed'
    this.repos.sessions.update(row.id, {
      status: row.status,
      statusDetail: row.statusDetail,
      endedAt: row.endedAt,
      endReason: row.endReason,
    })
    this.callbacks.onSessionStatus({ ...row })
  }

}

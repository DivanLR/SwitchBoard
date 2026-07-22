// Session registry (one hosted session per project, clarified invariant),
// event persistence with per-session seq, and the fan-out hook the IPC layer
// subscribes to (T012). Also owns git branch observation (FR-003).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import type {
  EventKind,
  EventPayloadMap,
  ProjectCommand,
  QueuedTask,
  Session,
  SessionEvent,
  SessionStatus,
} from '@shared/domain'
import { SWALLOWABLE_KINDS } from '@shared/domain'
import type { SessionStatusPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
import { readSchemaDoc } from '@main/mcp/schema-doc'
import { HostedSession, type PermissionGate } from './session'
import type { EventSink } from './message-mapper'
import { terseSystemPromptAppend } from './terse-mode'
import { resolveClaudeExecutable } from './claude-executable'

export class SessionManagerError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'ALREADY_ACTIVE' | 'SESSION_ENDED',
    message: string,
  ) {
    super(message)
  }
}

/** Classifier hook installed by the swallow rule engine (FR-015a); null until then. */
export type NoiseClassifier = (event: SessionEvent, projectId: string) => string | null

export interface SessionManagerCallbacks {
  onEvent: (event: SessionEvent) => void
  onSessionStatus: (push: SessionStatusPush) => void
  onCountersChanged: () => void
  /** Wired to the permission broker so pending items expire on session death. */
  onSessionExit: (sessionId: string) => void
  /** Fired when a project's planned task queue changes (add/remove/auto-run). */
  onQueueChanged: (projectId: string) => void
  /** Fired when a session reports its available slash commands / skills (init message). */
  onProjectCommands: (projectId: string, commands: ProjectCommand[]) => void
  gate: PermissionGate
}

interface LiveEventEntry {
  event: SessionEvent
  persisted: boolean
}

interface HostedEntry {
  session: HostedSession
  row: Session
  projectPath: string
  seq: number
  /** Events that may still be updated in place (partials, tool pairs, markers, questions). */
  live: Map<string, LiveEventEntry>
}

const UPDATABLE_KINDS: ReadonlySet<EventKind> = new Set([
  'prompt',
  'assistant_text',
  'tool_activity',
  'question',
  'permission_marker',
  'plan_marker',
])

export async function readGitBranch(projectPath: string): Promise<string | null> {
  try {
    // --show-current returns the branch even on an unborn branch (no commits)
    // and empty on detached HEAD, unlike rev-parse --abbrev-ref. Async
    // (execFile + promisify) so it never blocks the main-process event loop —
    // this runs on every session start and after every completed turn.
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'branch', '--show-current'], {
      timeout: 4000,
      windowsHide: true,
    })
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

/** Working-tree line changes (git diff --shortstat), shown in the header (design reference). */
export async function readGitDiffStat(
  projectPath: string,
): Promise<{ adds: number; dels: number } | null> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('git', ['-C', projectPath, 'diff', '--numstat'], {
      timeout: 4000,
      windowsHide: true,
    }))
  } catch {
    return null
  }
  let adds = 0
  let dels = 0
  for (const line of stdout.split('\n')) {
    const [a, d] = line.split('\t')
    if (a === undefined || d === undefined) continue
    // Binary files report "-" for both counts.
    adds += Number.parseInt(a, 10) || 0
    dels += Number.parseInt(d, 10) || 0
  }
  return { adds, dels }
}

export class SessionManager {
  private hosted = new Map<string, HostedEntry>()
  private classifier: NoiseClassifier | null = null

  constructor(
    private repos: Repositories,
    private callbacks: SessionManagerCallbacks,
  ) {}

  setNoiseClassifier(classifier: NoiseClassifier): void {
    this.classifier = classifier
  }

  /** Startup reconciliation (FR-022): nothing from a previous run stays live. */
  reconcileOnStartup(): void {
    this.repos.sessions.reconcileAllEnded('app_exit')
    for (const request of this.repos.requests.pending()) {
      this.repos.requests.resolve(request.id, 'expired')
    }
  }

  startSession(projectId: string, resume = false, bypassPermissions = false): Session {
    const project = this.repos.projects.byId(projectId)
    if (!project) throw new SessionManagerError('NOT_FOUND', 'Project not found')
    const active = this.repos.sessions.activeForProject(projectId)
    if (active) {
      throw new SessionManagerError('ALREADY_ACTIVE', 'The project already has an active session')
    }
    // The app drives the user's own Claude Code CLI and no longer bundles a copy
    // (that binary is ~245 MB). Every Switchboard user has Claude Code, so this
    // is normally present; if not, fail with a clear message rather than letting
    // the SDK spawn the wrong runtime and crash under Electron.
    const claudeExecutablePath = resolveClaudeExecutable()
    if (!claudeExecutablePath) {
      throw new SessionManagerError(
        'NOT_FOUND',
        'Claude Code was not found. Install it from https://claude.com/claude-code, then start a session.',
      )
    }

    let resumeSdkSessionId: string | undefined
    if (resume) {
      const previous = this.repos.sessions.latestEndedForProject(projectId)
      resumeSdkSessionId = previous?.sdkSessionId ?? undefined
    }

    const row: Session = {
      id: newId(),
      projectId,
      sdkSessionId: null,
      status: 'working',
      statusDetail: null,
      // Filled asynchronously by refreshBranch() just after start, so the git
      // read never blocks session creation on the main thread.
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: nowIso(),
      endedAt: null,
      endReason: null,
    }
    this.repos.sessions.insert(row)
    // In-memory only (never bound into the INSERT): surfaces the "⚠ Bypass"
    // header pill through liveSessionRow snapshots for the session's lifetime.
    row.bypassPermissions = bypassPermissions

    const entry: HostedEntry = {
      row,
      projectPath: project.path,
      seq: this.repos.events.maxSeq(row.id),
      live: new Map(),
      session: null as unknown as HostedSession,
    }

    const settings = this.repos.settings.get()
    // Per-project implementation-model override ("This project" settings tab);
    // 'global' or absent follows the global work model.
    const override = settings.projectModels?.[projectId]
    const workModel = override && override !== 'global' ? override : settings.workModel
    // Per-project worker-model override ("This project" tab): the cheaper model
    // for work-classified turns under auto routing; 'global'/absent follows the
    // project's implementation model above.
    const workerOverride = settings.projectWorkerModels?.[projectId]
    const workerModel = workerOverride && workerOverride !== 'global' ? workerOverride : workModel
    // Any project that has previously run an MCP scan gets its schema map
    // injected as context on every session start (no-op when never scanned).
    const terseAppend = terseSystemPromptAppend({
      terseMode: settings.terseMode,
      terseLevel: settings.terseLevel,
    })
    const schemaDoc = readSchemaDoc(project.path)?.trim()
    const schemaAppend = schemaDoc
      ? `## Database schema (from a previous MCP scan)\n\n${schemaDoc}`
      : null
    entry.session = new HostedSession({
      sessionId: row.id,
      projectPath: project.path,
      // ponytail: refs added mid-session apply from the next session start.
      refDirs: project.refs.map((r) => r.path),
      resumeSdkSessionId,
      systemPromptAppend:
        [terseAppend, schemaAppend].filter((s): s is string => Boolean(s)).join('\n\n') || undefined,
      claudeExecutablePath,
      workModel,
      workerModel,
      planModel: settings.planModel,
      autoModelRouting: settings.autoModelRouting,
      bypassPermissions,
      summaries: settings.summaries,
      sink: this.makeSink(entry),
      gate: this.callbacks.gate,
      onStatusChange: (status, detail) => this.handleStatusChange(entry, status, detail),
      onSdkSessionId: (sdkSessionId) => {
        entry.row.sdkSessionId = sdkSessionId
        this.repos.sessions.update(row.id, { sdkSessionId })
      },
      onCommands: (commands) => {
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
      // MCP servers from the init message — in-memory only, pushed to the sidebar.
      onMcpServers: (servers) => {
        entry.row.mcpServers = servers
        this.pushStatus(entry)
      },
      // Model reported per main-loop turn — in-memory only, shown in the header.
      onModel: (model) => {
        entry.row.currentModel = model
        this.pushStatus(entry)
      },
      onTurnComplete: () => {
        this.observeBranch(entry)
        // A completed turn that left the session idle pulls the next planned task.
        this.maybeDrainQueue(entry.row.projectId)
      },
      onExit: (reason, detail) => this.handleExit(entry, reason, detail),
    })

    this.hosted.set(row.id, entry)
    entry.session.start()
    // Read the git branch off the hot path and push it in when it resolves.
    void this.refreshBranch(entry)
    this.callbacks.onCountersChanged()
    // A freshly-started idle session runs any tasks already planned for it.
    this.maybeDrainQueue(projectId)
    return { ...entry.row }
  }

  // --- Planned task queue (FR-023) ---

  listQueue(projectId: string): QueuedTask[] {
    return this.repos.taskQueue.listForProject(projectId)
  }

  enqueueTask(projectId: string, text: string): void {
    if (text.trim().length === 0) return
    this.repos.taskQueue.add(projectId, text)
    this.callbacks.onQueueChanged(projectId)
    this.maybeDrainQueue(projectId)
  }

  removeTask(projectId: string, id: string): void {
    this.repos.taskQueue.remove(id)
    this.callbacks.onQueueChanged(projectId)
  }

  /**
   * Delivers the front-of-queue task when the project's session is live and
   * idle (turn finished, nothing blocking on the developer). No-op otherwise,
   * so the queue simply waits for the current turn or a decision to clear.
   */
  private maybeDrainQueue(projectId: string): void {
    const entry = [...this.hosted.values()].find((e) => e.row.projectId === projectId)
    if (!entry || entry.session.currentStatus !== 'done') return
    const next = this.repos.taskQueue.takeNext(projectId)
    if (!next) return
    this.callbacks.onQueueChanged(projectId)
    this.sendMessage(entry.row.id, next.text)
  }

  sendMessage(sessionId: string, text: string, agentId?: string): { eventId: string; queued: boolean } {
    const entry = this.requireLive(sessionId)
    const send = entry.session.send(text)
    const sink = this.makeSink(entry)
    // agentId tags prompts addressed at a subagent so they show in its chat view.
    const event = sink.append('prompt', { text, pending: send.queued, agentId })
    // Record the command for terminal-style composer suggestions.
    this.repos.commandHistory.add(entry.row.projectId, text)
    send.deliver(event.id)
    return { eventId: event.id, queued: send.queued }
  }

  async interruptSession(sessionId: string): Promise<{ stillQueued: number }> {
    const entry = this.requireLive(sessionId)
    return entry.session.interrupt()
  }

  async stopSession(sessionId: string): Promise<void> {
    const entry = this.requireLive(sessionId)
    // Same as app exit (FR-022): undelivered composer sends survive as drafts.
    for (const queued of entry.session.takeQueuedSends()) {
      this.repos.drafts.insert(entry.row.projectId, queued.text)
    }
    await entry.session.stop()
  }

  /** Graceful shutdown for application exit (FR-022): queued sends become drafts. */
  async endAllForAppExit(): Promise<void> {
    const entries = [...this.hosted.values()]
    for (const entry of entries) {
      for (const queued of entry.session.takeQueuedSends()) {
        this.repos.drafts.insert(entry.row.projectId, queued.text)
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.session.stop()))
    for (const entry of entries) {
      if (!entry.row.endedAt) this.finaliseRow(entry, 'app_exit')
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

  /** Sink for the permission broker: markers and questions enter the stream here. */
  sinkFor(sessionId: string): EventSink {
    const entry = this.hosted.get(sessionId)
    if (!entry) throw new SessionManagerError('SESSION_ENDED', 'Session is no longer active')
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
      if (!row) throw new SessionManagerError('NOT_FOUND', 'Session not found')
      throw new SessionManagerError('SESSION_ENDED', 'Session has ended')
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
          event.noiseKind = this.classifier(event, entry.row.projectId)
        }
        const persist = options?.persist !== false
        if (persist) this.repos.events.insert(event)
        if (UPDATABLE_KINDS.has(kind)) {
          entry.live.set(event.id, { event, persisted: persist })
        }
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
        // A kind change can move an event out of the swallowable set (e.g. an
        // assistant_text upgraded to a summary): recompute while it can still
        // be noise, otherwise clear any tag its earlier kind was given so a
        // now-non-swallowable event is never hidden by a stale noiseKind.
        liveEntry.event.noiseKind =
          SWALLOWABLE_KINDS.includes(liveEntry.event.kind) && this.classifier
            ? this.classifier(liveEntry.event, entry.row.projectId)
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
        this.callbacks.onEvent({ ...liveEntry.event })
      },
    }
  }

  private handleStatusChange(entry: HostedEntry, status: SessionStatus, detail?: string | null): void {
    entry.row.status = status
    entry.row.statusDetail = detail ?? null
    this.repos.sessions.update(entry.row.id, { status, statusDetail: detail ?? null })
    this.pushStatus(entry)
    this.callbacks.onCountersChanged()
  }

  /** Read the git branch asynchronously; push only when it actually changed. */
  private async refreshBranch(entry: HostedEntry): Promise<void> {
    const branch = await readGitBranch(entry.projectPath)
    if (branch === entry.row.branch) return
    entry.row.branch = branch
    this.repos.sessions.update(entry.row.id, { branch })
    this.pushStatus(entry)
  }

  private observeBranch(entry: HostedEntry): void {
    // Both git reads are async so a completed turn never blocks the main loop.
    void this.refreshBranch(entry)
    void readGitDiffStat(entry.projectPath).then((diff) => {
      const adds = diff?.adds ?? null
      const dels = diff?.dels ?? null
      if (adds === entry.row.diffAdds && dels === entry.row.diffDels) return
      entry.row.diffAdds = adds
      entry.row.diffDels = dels
      this.repos.sessions.update(entry.row.id, { diffAdds: adds, diffDels: dels })
      this.pushStatus(entry)
    })
    this.callbacks.onCountersChanged()
  }

  private handleExit(entry: HostedEntry, reason: 'completed' | 'stopped' | 'crashed', detail?: string): void {
    if (reason === 'crashed') {
      entry.row.status = 'error'
      entry.row.statusDetail = detail ?? 'Session process ended unexpectedly'
    }
    this.finaliseRow(entry, reason)
    this.hosted.delete(entry.row.id)
    this.callbacks.onSessionExit(entry.row.id)
    this.callbacks.onCountersChanged()
  }

  private finaliseRow(entry: HostedEntry, reason: Session['endReason']): void {
    entry.row.endedAt = nowIso()
    entry.row.endReason = reason
    this.repos.sessions.update(entry.row.id, {
      status: entry.row.status,
      statusDetail: entry.row.statusDetail,
      endedAt: entry.row.endedAt,
      endReason: reason,
    })
    this.pushStatus(entry)
  }

  private pushStatus(entry: HostedEntry): void {
    this.callbacks.onSessionStatus({ ...entry.row })
  }

}

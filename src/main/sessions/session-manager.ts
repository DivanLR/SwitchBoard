// Session registry (one hosted session per project, clarified invariant),
// event persistence with per-session seq, and the fan-out hook the IPC layer
// subscribes to (T012). Also owns git branch observation (FR-003).
import { execFile, execFileSync } from 'node:child_process'
import type {
  EventKind,
  EventPayloadMap,
  QueuedTask,
  Session,
  SessionEvent,
  SessionStatus,
} from '@shared/domain'
import { SWALLOWABLE_KINDS } from '@shared/domain'
import type { SessionStatusPush } from '@shared/ipc-types'
import { newId, nowIso, type Repositories } from '@main/store/repositories'
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
  onProjectCommands: (projectId: string, commands: string[]) => void
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

export function readGitBranch(projectPath: string): string | null {
  try {
    // --show-current returns the branch even on an unborn branch (no commits)
    // and empty on detached HEAD, unlike rev-parse --abbrev-ref.
    const branch = execFileSync('git', ['-C', projectPath, 'branch', '--show-current'], {
      timeout: 4000,
      windowsHide: true,
      encoding: 'utf8',
    }).trim()
    return branch.length > 0 ? branch : null
  } catch {
    return null
  }
}

/** Working-tree line changes (git diff --shortstat), shown in the header (design reference). */
export function readGitDiffStat(projectPath: string): Promise<{ adds: number; dels: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', projectPath, 'diff', '--numstat'],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
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
        resolve({ adds, dels })
      },
    )
  })
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
      branch: readGitBranch(project.path),
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
    entry.session = new HostedSession({
      sessionId: row.id,
      projectPath: project.path,
      resumeSdkSessionId,
      systemPromptAppend:
        terseSystemPromptAppend({
          terseMode: settings.terseMode,
          terseLevel: settings.terseLevel,
        }) ?? undefined,
      claudeExecutablePath: resolveClaudeExecutable() ?? undefined,
      workModel,
      planModel: settings.planModel,
      bypassPermissions,
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
      onTurnComplete: () => {
        this.observeBranch(entry)
        // A completed turn that left the session idle pulls the next planned task.
        this.maybeDrainQueue(entry.row.projectId)
      },
      onExit: (reason, detail) => this.handleExit(entry, reason, detail),
    })

    this.hosted.set(row.id, entry)
    entry.session.start()
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

  sendMessage(sessionId: string, text: string): { eventId: string; queued: boolean } {
    const entry = this.requireLive(sessionId)
    const send = entry.session.send(text)
    const sink = this.makeSink(entry)
    const event = sink.append('prompt', { text, pending: send.queued })
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

  liveSession(sessionId: string): HostedSession | undefined {
    return this.hosted.get(sessionId)?.session
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
        if (SWALLOWABLE_KINDS.includes(liveEntry.event.kind) && this.classifier) {
          liveEntry.event.noiseKind = this.classifier(liveEntry.event, entry.row.projectId)
          if (liveEntry.persisted) {
            this.repos.events.setNoiseKind(eventId, liveEntry.event.noiseKind)
          }
        }
        if (options?.persist) {
          if (liveEntry.persisted) {
            if (options.kind) {
              this.repos.events.updateKindAndPayload(eventId, liveEntry.event.kind, payload)
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

  private observeBranch(entry: HostedEntry): void {
    const branch = readGitBranch(entry.projectPath)
    let changed = false
    if (branch !== entry.row.branch) {
      entry.row.branch = branch
      this.repos.sessions.update(entry.row.id, { branch })
      changed = true
    }
    void readGitDiffStat(entry.projectPath).then((diff) => {
      const adds = diff?.adds ?? null
      const dels = diff?.dels ?? null
      if (adds === entry.row.diffAdds && dels === entry.row.diffDels) return
      entry.row.diffAdds = adds
      entry.row.diffDels = dels
      this.repos.sessions.update(entry.row.id, { diffAdds: adds, diffDels: dels })
      this.pushStatus(entry)
    })
    if (changed) this.pushStatus(entry)
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
    this.callbacks.onSessionStatus({
      sessionId: entry.row.id,
      projectId: entry.row.projectId,
      status: entry.row.status,
      statusDetail: entry.row.statusDetail,
      branch: entry.row.branch,
      diffAdds: entry.row.diffAdds,
      diffDels: entry.row.diffDels,
      usageUtilization: entry.row.usageUtilization,
      usageResetsAt: entry.row.usageResetsAt,
      usageLimitType: entry.row.usageLimitType,
      endedAt: entry.row.endedAt,
      endReason: entry.row.endReason,
    })
  }
}

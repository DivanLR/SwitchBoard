// Typed IPC endpoint implementations (contracts/ipc-contract.md). One generic
// invoke channel carries every method with a WireResult envelope so stable
// error codes survive Electron's error serialisation. Push channels batch
// stream events at >= 30 Hz flushes (SC-007).
import { ipcMain, type BrowserWindow } from 'electron'
import type { SessionEvent } from '@shared/domain'
import type {
  Counters,
  FocusRequestPush,
  InboxChangedPush,
  InvokeMap,
  InvokeMethod,
  IpcError,
  ProjectListItem,
  SessionStatusPush,
  WireResult,
} from '@shared/ipc-types'
import { isIpcError } from '@shared/ipc-types'
import type { Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import type { PermissionBroker } from '@main/inbox/permission-broker'
import { registerProject, suggestProjects } from '@main/projects/discovery'
import { defaultRiskRules } from '@main/inbox/risk-rules'
import { defaultSwallowRules } from '@main/stream/swallow-rules'

const EVENT_FLUSH_INTERVAL_MS = 33 // >= 30 Hz (contract)
const COUNTER_DEBOUNCE_MS = 50

/** Owns every main -> renderer push channel, including event batching. */
export class RendererPush {
  private eventBuffer: SessionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private counterTimer: NodeJS.Timeout | null = null

  constructor(
    private getWindow: () => BrowserWindow | null,
    private computeCounters: () => Counters,
  ) {}

  event(event: SessionEvent): void {
    this.eventBuffer.push(event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), EVENT_FLUSH_INTERVAL_MS)
    }
  }

  flushEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.eventBuffer.length === 0) return
    const batch = this.eventBuffer.splice(0)
    this.send('push.event', batch)
  }

  sessionStatus(push: SessionStatusPush): void {
    this.send('push.sessionStatus', push)
  }

  countersChanged(): void {
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      this.send('push.counters', this.computeCounters())
    }, COUNTER_DEBOUNCE_MS)
  }

  inboxChanged(push: InboxChangedPush): void {
    this.send('push.inboxChanged', push)
  }

  focusRequest(push: FocusRequestPush): void {
    this.send('push.focusRequest', push)
  }

  private send(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }
}

export interface HandlerDeps {
  repos: Repositories
  manager: SessionManager
  broker: PermissionBroker
  /** Re-reads swallow rules into the manager's classifier cache. */
  refreshSwallowRules: () => void
}

function localMidnightIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

export function computeCounters(repos: Repositories): Counters {
  const live = repos.sessions.listUnended()
  return {
    running: live.filter((s) => s.status === 'working').length,
    needsYou: live.filter((s) => s.status === 'needs_you').length,
    pendingInbox: repos.requests.pending().length,
    costTodayUsd: repos.events.costSince(localMidnightIso()),
  }
}

export function seedDefaultRules(repos: Repositories): void {
  if (repos.riskRules.count() === 0) repos.riskRules.replaceAll(defaultRiskRules())
  if (repos.swallowRules.count() === 0) repos.swallowRules.replaceAll(defaultSwallowRules())
}

type Handlers = {
  [M in InvokeMethod]: (req: InvokeMap[M]['req']) => InvokeMap[M]['res'] | Promise<InvokeMap[M]['res']>
}

function toIpcError(error: unknown): IpcError {
  if (isIpcError(error)) return { code: error.code as IpcError['code'], message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL', message }
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { repos, manager, broker } = deps

  const projectList = (): ProjectListItem[] =>
    repos.projects.listActive().map((project) => ({
      ...project,
      session:
        manager
          .liveSessionIds()
          .map((id) => manager.liveSessionRow(id))
          .find((s) => s && s.projectId === project.id) ??
        repos.sessions.latestForProject(project.id) ??
        null,
      drafts: repos.drafts.listForProject(project.id),
    }))

  const handlers: Handlers = {
    'projects.list': () => ({ projects: projectList(), counters: computeCounters(repos) }),
    'projects.suggestions': () => suggestProjects(repos),
    'projects.register': (req) => {
      const suggested = suggestProjects(repos).some(
        (s) => s.path.toLowerCase() === req.path.toLowerCase(),
      )
      return registerProject(repos, {
        path: req.path,
        name: req.name,
        source: suggested ? 'suggested' : 'manual',
      })
    },
    'projects.archive': (req) => {
      const active = repos.sessions.activeForProject(req.projectId)
      if (active) {
        throw { code: 'ALREADY_ACTIVE', message: 'Stop the session before archiving the project' }
      }
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' }
      }
      repos.projects.archive(req.projectId)
    },
    'sessions.start': (req) => manager.startSession(req.projectId, req.resume ?? false),
    'sessions.stop': (req) => manager.stopSession(req.sessionId),
    'sessions.interrupt': (req) => manager.interruptSession(req.sessionId),
    'sessions.send': (req) => {
      const result = manager.sendMessage(req.sessionId, req.text)
      // Drafts offered in the composer are consumed by the first send (FR-019 edge case).
      const session = repos.sessions.byId(req.sessionId)
      if (session) {
        for (const draft of repos.drafts.listForProject(session.projectId)) {
          repos.drafts.delete(draft.id)
        }
      }
      return result
    },
    'sessions.answerQuestion': (req) => {
      broker.answerQuestion(req.sessionId, req.eventId, req.choice)
    },
    'sessions.events': (req) => repos.events.page(req.sessionId, req.beforeSeq, req.limit),
    'sessions.promptHistory': (req) => repos.commandHistory.recent(req.projectId, req.limit),
    'inbox.pending': () => repos.requests.pending(),
    'inbox.decide': (req) => broker.decide(req.requestId, req.decision, req.confirmHighRisk ?? false),
    'inbox.alwaysAllow': (req) => {
      const { rule } = broker.alwaysAllow(req.requestId, req.matcher)
      return { rule }
    },
    'inbox.approveAllForProject': (req) => broker.approveAllForProject(req.projectId),
    'inbox.history': (req) => repos.requests.history(req),
    'rules.standing.list': (req) => repos.standingRules.listForProject(req.projectId),
    'rules.standing.revoke': (req) => {
      repos.standingRules.revoke(req.ruleId)
    },
    'rules.risk.list': () => repos.riskRules.list(),
    'rules.risk.save': (req) => {
      repos.riskRules.replaceAll(req.rules)
      return repos.riskRules.list()
    },
    'rules.risk.restoreDefaults': () => {
      repos.riskRules.replaceAll(defaultRiskRules())
      return repos.riskRules.list()
    },
    'rules.swallow.list': (req) => repos.swallowRules.list(req.projectId),
    'rules.swallow.save': (req) => {
      repos.swallowRules.replaceAll(req.rules)
      deps.refreshSwallowRules()
      return repos.swallowRules.list()
    },
    'rules.swallow.restoreDefaults': () => {
      repos.swallowRules.replaceAll(defaultSwallowRules())
      deps.refreshSwallowRules()
      return repos.swallowRules.list()
    },
    'settings.get': () => repos.settings.get(),
    'settings.set': (req) => repos.settings.set(req),
  }

  ipcMain.handle(
    'switchboard:invoke',
    async (_event, method: InvokeMethod, req: unknown): Promise<WireResult<unknown>> => {
      const handler = handlers[method]
      if (!handler) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method ${method}` } }
      }
      try {
        const value = await (handler as (r: unknown) => unknown)(req)
        return { ok: true, value: value ?? null }
      } catch (error) {
        return { ok: false, error: toIpcError(error) }
      }
    },
  )
}

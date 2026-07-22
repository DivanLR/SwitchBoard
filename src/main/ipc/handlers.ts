// Typed IPC endpoint implementations (contracts/ipc-contract.md). One generic
// invoke channel carries every method with a WireResult envelope so stable
// error codes survive Electron's error serialisation. Push channels batch
// stream events at >= 30 Hz flushes (SC-007).
import { ipcMain, type BrowserWindow } from 'electron'
import type { SessionEvent } from '@shared/domain'
import type {
  Counters,
  InvokeMap,
  InvokeMethod,
  IpcError,
  ProjectListItem,
  PushChannel,
  PushMap,
  WireResult,
} from '@shared/ipc-types'
import { isIpcError } from '@shared/ipc-types'
import type { Repositories } from '@main/store/repositories'
import type { SessionManager } from '@main/sessions/session-manager'
import type { PermissionBroker } from '@main/inbox/permission-broker'
import {
  addProjectRef,
  registerProject,
  removeProjectRef,
  suggestProjects,
} from '@main/projects/discovery'
import { defaultRiskRules } from '@main/inbox/risk-rules'
import { defaultSwallowRules } from '@main/stream/swallow-rules'
import { readSchemaDoc } from '@main/mcp/schema-doc'
import { installSpecKit, readSpecDetail, readSpecKitState } from '@main/specs/spec-kit'
import { check as checkForUpdates, installNow } from '@main/updater'

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

  countersChanged(): void {
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      this.send('push.counters', this.computeCounters())
    }, COUNTER_DEBOUNCE_MS)
  }

  /** Typed pass-through for every other push channel. */
  push<C extends PushChannel>(channel: C, payload: PushMap[C]): void {
    this.send(channel, payload)
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
  /** The trusted main window; IPC is accepted only from its webContents (A17). */
  getWindow: () => BrowserWindow | null
  /** Reserved project id backing the global Database MCP session; marked
   *  `reserved` in projectList so the sidebar never lists it as a real project. */
  dbProjectId: string
}

function localMidnightIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

export function computeCounters(repos: Repositories): Counters {
  const live = repos.sessions.listUnended()
  const midnight = localMidnightIso()
  return {
    running: live.filter((s) => s.status === 'working').length,
    needsYou: live.filter((s) => s.status === 'needs_you').length,
    costTodayUsd: repos.events.costSince(midnight),
    tokensToday: repos.events.tokensSince(midnight),
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
  const { repos, manager, broker, dbProjectId } = deps

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
      reserved: project.id === dbProjectId,
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
    'projects.rename': (req) => {
      if (!repos.projects.byId(req.projectId)) {
        throw { code: 'NOT_FOUND', message: 'Project not found' }
      }
      const name = req.name.trim()
      if (name.length === 0) throw { code: 'INVALID_PATH', message: 'Name cannot be empty' }
      repos.projects.rename(req.projectId, name)
    },
    'projects.move': (req) => {
      repos.projects.move(req.projectId, req.toIndex)
    },
    'projects.refs.add': (req) => addProjectRef(repos, req.projectId, req.target),
    'projects.refs.remove': (req) => removeProjectRef(repos, req.projectId, req.path),
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
    'sessions.start': (req) =>
      manager.startSession(req.projectId, req.resume ?? false, req.bypassPermissions ?? false),
    'sessions.stop': (req) => manager.stopSession(req.sessionId),
    'sessions.interrupt': (req) => manager.interruptSession(req.sessionId),
    'sessions.send': (req) => {
      const result = manager.sendMessage(req.sessionId, req.text, req.agentId)
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
    'projects.commands': (req) => repos.projectCommands.get(req.projectId),
    'specs.state': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      return readSpecKitState(project.path)
    },
    'specs.detail': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      return readSpecDetail(project.path, req.specId)
    },
    'specs.install': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      await installSpecKit(project.path)
      return readSpecKitState(project.path)
    },
    'mcp.readSchema': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      return { content: readSchemaDoc(project.path) }
    },
    'specs.runInSession': (req) => {
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = manager.startSession(req.projectId)
      manager.sendMessage(session.id, req.text)
      return { sessionId: session.id }
    },
    'queue.list': (req) => manager.listQueue(req.projectId),
    'queue.add': (req) => {
      manager.enqueueTask(req.projectId, req.text)
      return manager.listQueue(req.projectId)
    },
    'queue.remove': (req) => {
      manager.removeTask(req.projectId, req.id)
      return manager.listQueue(req.projectId)
    },
    'inbox.pending': () => repos.requests.pending(),
    'inbox.decide': (req) => broker.decide(req.requestId, req.decision, req.confirmHighRisk ?? false),
    'inbox.alwaysAllow': (req) => {
      const { rule } = broker.alwaysAllow(req.requestId)
      return { rule }
    },
    'inbox.approveAlways': (req) => broker.approveAlways(req.requestId, req.confirmHighRisk ?? false),
    'inbox.approveAllForProject': (req) =>
      broker.approveAllForProject(req.projectId, req.includeHighRisk ?? false),
    'inbox.history': (req) => repos.requests.history(req),
    'inbox.deleteHistory': (req) => {
      repos.requests.deleteHistory(req.requestId)
    },
    'inbox.clearHistory': () => {
      repos.requests.clearHistory()
    },
    'rules.standing.list': (req) =>
      repos.standingRules.listForProject(req.projectId, req.includeRevoked ?? false),
    'rules.standing.revoke': (req) => {
      repos.standingRules.revoke(req.ruleId)
    },
    'rules.standing.restore': (req) => {
      repos.standingRules.restore(req.ruleId)
    },
    'rules.standing.add': (req) => {
      const pattern = req.pattern.trim()
      if (!pattern) throw { code: 'INVALID_PATH', message: 'Enter a command' }
      return repos.standingRules.insert({
        projectId: req.projectId,
        toolName: 'Bash',
        matcher: { kind: 'command_prefix', value: pattern },
        createdFromRequestId: 'manual',
      })
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
    'updates.check': async () => ({ status: await checkForUpdates() }),
    'updates.install': () => installNow(),
  }

  ipcMain.handle(
    'switchboard:invoke',
    async (event, method: InvokeMethod, req: unknown): Promise<WireResult<unknown>> => {
      // Accept IPC only from the app's own main window webContents (A17): any
      // other sender (a stray frame, a compromised context) is rejected.
      const trusted = deps.getWindow()
      if (!trusted || event.sender.id !== trusted.webContents.id) {
        return { ok: false, error: { code: 'INTERNAL', message: 'Untrusted IPC sender' } }
      }
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

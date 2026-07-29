// Typed IPC endpoint implementations (contracts/ipc-contract.md). One generic
// invoke channel carries every method with a WireResult envelope so stable
// error codes survive Electron's error serialisation. Push channels batch
// stream events at >= 30 Hz flushes (SC-007).
import { ipcMain, type BrowserWindow } from 'electron'
import type { SessionEvent } from '@shared/domain'
import { canPassEval } from '@shared/domain'
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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { detectStacks, stackById, stackEntries } from '@shared/test-catalog'
import { attemptsPrompt, checkPrompt, judgePrompt } from '@main/evals/eval-dispatch'
import { evidencePrompt, planSuites, verifyPrompt } from '@main/evals/verify-dispatch'
import { apiDataPrompt } from '@main/evals/api-dispatch'
import { resolveApiHost, scanProjectEndpoints } from '@main/evals/api-scan'
import { recentEndpoints } from '@shared/api-endpoints'
import { sandboxToolsFor } from '@main/sessions/docker-sandbox'
import { comboDocPath, readComboDoc, readSchemaDoc } from '@main/mcp/schema-doc'
import { comboKey } from '@shared/mcp-combo'
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

interface HandlerDeps {
  repos: Repositories
  manager: SessionManager
  broker: PermissionBroker
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
  repos.riskRules.seedIfEmpty(defaultRiskRules())
  repos.swallowRules.seedIfEmpty(defaultSwallowRules())
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
    'projects.register': async (req) => {
      const suggested = (await suggestProjects(repos)).some(
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
      const content = req.servers?.length
        ? readComboDoc(project.path, req.servers)
        : readSchemaDoc(project.path)
      return { content }
    },
    'mcp.scanHistory': (req) => repos.mcpScans.listForProject(req.projectId),
    'mcp.recordScan': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' }
      // Only record when the scan actually produced the combination's doc, and
      // date the row from the doc's mtime — a re-scan that wrote nothing keeps
      // the honest older timestamp instead of passing itself off as fresh.
      if (!req.servers.length) return null
      const docPath = comboDocPath(project.path, req.servers)
      if (!existsSync(docPath)) return null
      const scannedAt = statSync(docPath).mtime.toISOString()
      return repos.mcpScans.upsert(req.projectId, comboKey(req.servers), req.servers, scannedAt)
    },
    'specs.runInSession': async (req) => {
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = await manager.startSession(req.projectId)
      manager.sendMessage(session.id, req.text)
      return { sessionId: session.id }
    },
    // Eval loop: the row is the whole record for a small change. A rating is the
    // developer's own (FR-089), so it is stored exactly as given; the app never
    // derives one, and an unrun check stays 'not_run' rather than passing.
    'evals.list': (req) => repos.evals.listForProject(req.projectId),
    'evals.add': (req) => {
      const acceptance = req.acceptance.trim()
      if (!acceptance) throw { code: 'INVALID_PATH', message: 'Write what is observably true when it works.' } satisfies IpcError
      repos.evals.add(req.projectId, acceptance, req.checkCmd)
      return repos.evals.listForProject(req.projectId)
    },
    'evals.record': (req) => {
      if (req.rating != null && (req.rating < 1 || req.rating > 5)) {
        throw { code: 'INVALID_PATH', message: 'A rating is 1 to 5.' } satisfies IpcError
      }
      if (req.attempts != null && (req.attempts < 1 || req.attempts > 5)) {
        throw { code: 'INVALID_PATH', message: 'Attempts are 1 to 5.' } satisfies IpcError
      }
      // The gate: a PASS verdict needs the check to have passed (FR-087). Nothing
      // in the UI offers it otherwise, and the rule is enforced here too so it
      // cannot be bypassed by a caller.
      if (req.verdict === 'pass') {
        const current = repos.evals.byId(req.id)
        if (current && !canPassEval(current)) {
          throw {
            code: 'CONFIRM_REQUIRED',
            message: 'The check has not passed yet — run it, or mark this line failed.',
          } satisfies IpcError
        }
      }
      const updated = repos.evals.update(req.id, {
        checkStatus: req.checkStatus,
        verdict: req.verdict,
        rating: req.rating,
        note: req.note,
        attempts: req.attempts,
      })
      if (!updated) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' } satisfies IpcError
      return repos.evals.listForProject(req.projectId)
    },
    'evals.remove': (req) => {
      repos.evals.remove(req.id)
      return repos.evals.listForProject(req.projectId)
    },
    // What this project can be tested with, from its own tooling — the app
    // writes no runners, it only knows the commands (FR-035/FR-037).
    'evals.suites': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      try {
        // Root plus one level: a solution often sits in a subfolder of the
        // folder the developer registered.
        return detectStacks(stackEntries(project.path, (dir) => readdirSync(dir)))
      } catch {
        // Unreadable folder (removed, permissions): no stack, not a crash.
        return []
      }
    },
    // Implement / verify / review, all through the session (FR-041). A check and
    // a judge pass are watched for their reported result; attempts only records
    // how many were asked for — the developer picks the winner.
    'evals.dispatch': async (req) => {
      const run = repos.evals.byId(req.id)
      if (!run) throw { code: 'NOT_FOUND', message: 'That acceptance line no longer exists.' } satisfies IpcError
      if (req.kind === 'check' && !run.checkCmd) {
        throw { code: 'INVALID_PATH', message: 'This line has no check — use the manual pass.' } satisfies IpcError
      }
      const text =
        req.kind === 'check'
          ? checkPrompt(run.acceptance, run.checkCmd as string)
          : req.kind === 'attempts'
            ? attemptsPrompt(run.acceptance, run.checkCmd, run.attempts)
            : judgePrompt(run.acceptance)
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = await manager.startSession(req.projectId)
      // Re-running a check clears the previous outcome, so a stale PASS can never
      // stand in for the run that is only just starting.
      if (req.kind === 'check') repos.evals.update(req.id, { checkStatus: 'not_run' })
      if (req.kind === 'judge') repos.evals.update(req.id, { judge: null })
      if (req.kind !== 'attempts') manager.watchEvalMarker(session.id, req.id, req.kind)
      manager.sendMessage(session.id, text)
      return { sessionId: session.id, runs: repos.evals.listForProject(req.projectId) }
    },
    // Verification runs: the session executes the suites and reports one result
    // line; the run row is what the gates and panels read. Nothing here parses a
    // coverage file or calls a quality service — the session already has the
    // tools, and the app never invents a figure it did not measure (FR-072).
    'verify.list': (req) => repos.verifyRuns.listForProject(req.projectId),
    'verify.start': async (req) => {
      const stack = stackById(req.stackId)
      if (!stack) throw { code: 'NOT_FOUND', message: 'Unknown stack.' } satisfies IpcError
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = await manager.startSession(req.projectId)
      // A bypass session runs in the sandbox container, which ships node (plus
      // .NET for a .NET project) and nothing else — the rest are named as
      // skipped up front rather than attempted and reported as failures of the
      // code (FR-057).
      const project = repos.projects.byId(req.projectId)
      const sandboxed =
        session.bypassPermissions === true && project ? sandboxToolsFor(project.path) : null
      const plan = planSuites(stack.suites, req.suiteIds, sandboxed)
      if (plan.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Choose at least one suite to run.' } satisfies IpcError
      }
      if (plan.every((p) => p.unavailable)) {
        throw {
          code: 'INVALID_PATH',
          message: 'None of the chosen suites can run in the bypass container — end it, or pick node suites.',
        } satisfies IpcError
      }
      const run = repos.verifyRuns.start({
        projectId: req.projectId,
        stackId: stack.id,
        sessionId: session.id,
        branch: session.branch ?? null,
        requested: plan.map((p) => p.suite.id),
      })
      manager.watchVerifyReport(session.id, run.id, 'suites')
      // Database MCP servers the session can actually reach right now: named in
      // settings AND reporting connected on this session. An API suite uses them
      // to draw real identifiers, so a name that is configured but not connected
      // must not be offered — the session would query a server that is not there.
      // Database MCP servers the run can actually reach: named in settings AND
      // reporting connected on this session. A name that is configured but absent
      // must not be offered, or the session queries a server that is not there.
      //
      // This waits, because it has to: when the session above was just started,
      // its server list has not arrived yet, and reading it immediately would name
      // nothing at all. See SessionManager.connectedMcpServers.
      const configured = repos.settings.get().databaseMcpServers ?? []
      const dbServers = await manager.connectedMcpServers(session.id, configured)
      manager.sendMessage(session.id, verifyPrompt(plan, stack.label, sandboxed, dbServers))
      return { sessionId: session.id, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    'verify.evidence': async (req) => {
      const run = req.runId
        ? repos.verifyRuns.byId(req.runId)
        : (repos.verifyRuns.listForProject(req.projectId)[0] ?? null)
      if (!run) {
        throw { code: 'NOT_FOUND', message: 'Run a verification pass first — evidence attaches to a run.' } satisfies IpcError
      }
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = await manager.startSession(req.projectId)
      // The acceptance lines still waiting on a verdict say what the evidence has
      // to show; without any, the session works from the diff alone.
      const hints = repos.evals
        .listForProject(req.projectId)
        .filter((line) => line.verdict === 'pending')
        .slice(0, 5)
        .map((line) => line.acceptance)
      manager.watchVerifyReport(session.id, run.id, 'evidence')
      manager.sendMessage(session.id, evidencePrompt(hints, session.bypassPermissions === true))
      return { sessionId: session.id, runs: repos.verifyRuns.listForProject(req.projectId) }
    },
    // The API eval set (deterministic path). Everything the app can establish
    // itself, it establishes itself: the routes come from a scan of the project's
    // source, the calls are made by the app, and the verdict is computed from the
    // statuses that came back. The session is used for one thing only — request
    // data drawn from real rows (api-dispatch.ts).
    'api.endpoints': (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      const scan = scanProjectEndpoints(project.path)
      const settings = repos.settings.get()
      const host = resolveApiHost(project.path, {
        baseUrl: settings.projectApiBase[req.projectId],
        startCmd: settings.projectApiStart[req.projectId],
      })
      return {
        endpoints: scan.endpoints,
        recent: recentEndpoints(repos.apiRuns.listForProject(req.projectId)),
        filesRead: scan.filesRead,
        truncated: scan.truncated,
        host:
          'error' in host
            ? { baseUrl: null, startCmd: null, from: null, error: host.error }
            : { baseUrl: host.baseUrl, startCmd: host.startCmd, from: host.from, error: null },
      }
    },
    'api.runs': (req) => repos.apiRuns.listForProject(req.projectId),
    'api.start': async (req) => {
      const project = repos.projects.byId(req.projectId)
      if (!project) throw { code: 'NOT_FOUND', message: 'Project not found' } satisfies IpcError
      if (req.endpoints.length === 0) {
        throw { code: 'INVALID_PATH', message: 'Choose at least one endpoint to test.' } satisfies IpcError
      }
      const settings = repos.settings.get()
      // Resolved BEFORE the session is touched: a project with nowhere to call is
      // a sentence the developer can act on, not a run that starts and then fails.
      const host = resolveApiHost(project.path, {
        baseUrl: settings.projectApiBase[req.projectId],
        startCmd: settings.projectApiStart[req.projectId],
      })
      if ('error' in host) throw { code: 'INVALID_PATH', message: host.error } satisfies IpcError
      let session = repos.sessions.activeForProject(req.projectId)
      if (!session) session = await manager.startSession(req.projectId)
      const run = repos.apiRuns.start({
        projectId: req.projectId,
        baseUrl: host.baseUrl,
        sessionId: session.id,
      })
      manager.watchApiRequests(session.id, run.id)
      // Same wait as a verification run: a session started a moment ago has not
      // reported its MCP servers yet, so reading the list immediately names none.
      const dbServers = await manager.connectedMcpServers(
        session.id,
        settings.databaseMcpServers ?? [],
      )
      manager.sendMessage(session.id, apiDataPrompt(req.endpoints, dbServers))
      return { sessionId: session.id, runs: repos.apiRuns.listForProject(req.projectId) }
    },
    'api.setHost': (req) => {
      const settings = repos.settings.get()
      const base = { ...settings.projectApiBase }
      const start = { ...settings.projectApiStart }
      // An empty string clears the override, which is what an emptied field means.
      if (req.baseUrl !== undefined) {
        if (req.baseUrl.trim()) base[req.projectId] = req.baseUrl.trim()
        else delete base[req.projectId]
      }
      if (req.startCmd !== undefined) {
        if (req.startCmd.trim()) start[req.projectId] = req.startCmd.trim()
        else delete start[req.projectId]
      }
      return repos.settings.set({ projectApiBase: base, projectApiStart: start })
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
    'settings.get': () => repos.settings.get(),
    'settings.set': (req) => repos.settings.set(req),
    'models.available': () => manager.models(),
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

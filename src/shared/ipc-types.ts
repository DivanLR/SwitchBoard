// Single source of truth for the renderer <-> main IPC contract
// (specs/001-terminal-switchboard/contracts/ipc-contract.md).
// The preload bridge exposes this surface as `window.switchboard`.

import type {
  AvailableModel,
  DecisionRecord,
  Draft,
  EvalCheckStatus,
  EvalRun,
  EvalVerdict,
  McpScan,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  Project,
  ProjectCommand,
  ProjectRef,
  QueuedTask,
  Session,
  SessionEvent,
  Settings,
  SpecDetail,
  SpecKitState,
  VerifyRun,
} from './domain'
import type { AvailableSuites } from './test-catalog'
import type { ApiEvalRun, ApiTarget, DiscoveredEndpoint } from './api-endpoints'

// --- Error model ---

export type IpcErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_ACTIVE'
  | 'SESSION_ENDED'
  | 'CONFIRM_REQUIRED'
  | 'RULE_NOT_ALLOWED'
  | 'INVALID_PATH'
  | 'DUPLICATE'
  | 'INTERNAL'

export interface IpcError {
  code: IpcErrorCode
  message: string
}

export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IpcError).code === 'string' &&
    typeof (value as IpcError).message === 'string'
  )
}

/**
 * What went wrong, in words a developer can act on.
 *
 * A rejected invoke does NOT arrive as an Error. The main process throws a plain
 * `IpcError` and it crosses the bridge as a plain object, so the obvious
 * `error instanceof Error ? error.message : String(error)` fell through to
 * `String({...})` and put the literal text "[object Object]" on screen. Every
 * reason a call could fail — the stack was unknown, no suite was chosen, Claude
 * Code was not installed — reached the user as that same useless string.
 *
 * Lives here rather than in the renderer because the shape it unwraps is defined
 * here, and both sides of the bridge describe failures with it.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (isIpcError(error)) return error.message
  if (error instanceof Error) return error.message
  // A thrown string is still worth showing. Anything else has no message to give,
  // and the caller's own wording beats printing a stringified object.
  if (typeof error === 'string' && error.trim() !== '') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() !== '' ? message : fallback
}

/**
 * Wire envelope for invoke responses. Electron serialises thrown errors down
 * to their message string, so structured errors travel inside the envelope
 * and the preload bridge re-throws them as `IpcError`.
 */
export type WireResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

// --- Invoke surface (renderer -> main) ---

export interface ProjectSuggestion {
  path: string
  name: string
}

/** Project decorated with its live session for the sidebar (FR-003/004/005). */
export interface ProjectListItem extends Project {
  session: Session | null
  /** Pending composer drafts preserved from a previous run, if any. */
  drafts: Draft[]
  /** True only for the single reserved, project-less row backing the global
   *  Database MCP session; excluded from the sidebar's project list and never
   *  independently selectable as `selectedProjectId`. */
  reserved: boolean
}

export interface Counters {
  running: number
  needsYou: number
  costTodayUsd: number
  tokensToday: number
}

/** projects.list returns projects with live status plus the aggregate counters (FR-005). */
export interface ProjectsSnapshot {
  projects: ProjectListItem[]
  counters: Counters
}

export interface InvokeMap {
  'projects.list': { req: void; res: ProjectsSnapshot }
  'projects.suggestions': { req: void; res: ProjectSuggestion[] }
  'projects.register': { req: { path: string; name?: string }; res: Project }
  'projects.rename': { req: { projectId: string; name: string }; res: void }
  'projects.move': { req: { projectId: string; toIndex: number }; res: void }
  'projects.refs.add': {
    // `target` is a folder path or the name of another registered project.
    req: { projectId: string; target: string }
    res: ProjectRef[]
  }
  'projects.refs.remove': { req: { projectId: string; path: string }; res: ProjectRef[] }
  'projects.archive': { req: { projectId: string }; res: void }
  'sessions.start': {
    req: {
      projectId: string
      resume?: boolean
      bypassPermissions?: boolean
    }
    res: Session
  }
  'sessions.stop': { req: { sessionId: string }; res: void }
  'sessions.interrupt': { req: { sessionId: string }; res: { stillQueued: number } }
  'sessions.send': {
    req: { sessionId: string; text: string; agentId?: string }
    res: { eventId: string; queued: boolean }
  }
  'sessions.answerQuestion': { req: { sessionId: string; eventId: string; choice: string }; res: void }
  'sessions.events': {
    req: { sessionId: string; beforeSeq?: number; limit?: number }
    res: SessionEvent[]
  }
  /** Recent distinct commands (past composer messages) for terminal-style suggestions. */
  'sessions.promptHistory': { req: { projectId: string; limit?: number }; res: string[] }
  /** Available slash commands / skills (plugins) for the project, for composer suggestions. */
  'projects.commands': { req: { projectId: string }; res: ProjectCommand[] }
  /** Spec Kit state for a project: installed? plus the spec summaries. */
  'specs.state': { req: { projectId: string }; res: SpecKitState }
  /** Full detail for one spec. */
  'specs.detail': { req: { projectId: string; specId: string }; res: SpecDetail | null }
  /** Install Spec Kit into the project (ephemeral uvx; never global). */
  'specs.install': { req: { projectId: string }; res: SpecKitState }
  /** The cached MCP schema map, or null if unscanned. With `servers`, reads the
   *  combination's own scan doc (.switchboard/scans/<combo>.md); without, the
   *  legacy single db-schema.md. */
  'mcp.readSchema': { req: { projectId: string; servers?: string[] }; res: { content: string | null } }
  /** Scanned-combination history, newest first ("have I scanned this set before?"). */
  'mcp.scanHistory': { req: { projectId: string }; res: McpScan[] }
  /** Record a completed scan for a combination (verifies the doc exists first). */
  'mcp.recordScan': { req: { projectId: string; servers: string[] }; res: McpScan | null }
  /**
   * Run text in the project's session (a spec-kit command or a start-phase
   * prompt), starting a session first if none is live. Returns its id.
   */
  'specs.runInSession': { req: { projectId: string; text: string }; res: { sessionId: string } }
  /** Eval loop (spec 002 US7): acceptance lines with their verdicts + ratings.
   *  Every mutation answers with the project's full list, newest first, so the
   *  view never has to merge a partial response. The check itself runs through
   *  `specs.runInSession` like any other session work (FR-041/FR-087). */
  'evals.list': { req: { projectId: string }; res: EvalRun[] }
  'evals.add': { req: { projectId: string; acceptance: string; checkCmd?: string }; res: EvalRun[] }
  'evals.record': {
    req: {
      projectId: string
      id: string
      checkStatus?: EvalCheckStatus
      verdict?: EvalVerdict
      /** 1-5, the developer's own score; null clears it. */
      rating?: number | null
      note?: string | null
      /** Parallel attempts to ask for next time this line is implemented (1-5). */
      attempts?: number
    }
    res: EvalRun[]
  }
  'evals.remove': { req: { projectId: string; id: string }; res: EvalRun[] }
  /** Suites the project's detected stacks support — the API/FE/UI checks
   *  available without writing a runner (FR-033/FR-035/FR-037). */
  'evals.suites': { req: { projectId: string }; res: AvailableSuites[] }
  /**
   * Send an acceptance line's work to the session (FR-041) and, for a check or a
   * judge pass, watch that session's output for the reported result:
   *   check    — run the check and report PASS / FAIL / INCONCLUSIVE
   *   attempts — N worktree-isolated attempts, then a report naming the winner
   *   judge    — a second opinion on the diff against the acceptance line
   */
  'evals.dispatch': {
    req: { projectId: string; id: string; kind: 'check' | 'attempts' | 'judge' }
    res: { sessionId: string; runs: EvalRun[] }
  }
  /** Verification runs (spec 002 US1-US4): the suites a run executed and what it
   *  measured — results, coverage, quality and evidence. Newest first. */
  'verify.list': { req: { projectId: string }; res: VerifyRun[] }
  /**
   * Start a run: send the chosen suites to the project's session (FR-041/FR-045)
   * and watch its output for the report. Suites the environment cannot run are
   * reported as skipped with the reason rather than attempted (FR-057).
   */
  'verify.start': {
    req: { projectId: string; stackId: string; suiteIds: string[] }
    res: { sessionId: string; runs: VerifyRun[] }
  }
  /** Capture evidence for a finished run without re-running its tests (FR-059).
   *  Attaches to `runId`, or to the newest run when omitted. */
  'verify.evidence': {
    req: { projectId: string; runId?: string }
    res: { sessionId: string; runs: VerifyRun[] }
  }
  /**
   * The endpoints this project declares, scanned from its own source, plus the
   * ones most recently tested and where a run would call them. Nothing here needs
   * a session or a running API: the list is browsable and searchable cold.
   */
  'api.endpoints': {
    req: { projectId: string }
    res: {
      endpoints: DiscoveredEndpoint[]
      /** The last few endpoints actually tested, newest first. */
      recent: { method: string; template: string }[]
      /** Files the scan read, and whether it stopped at its own limit. */
      filesRead: number
      truncated: boolean
      /** Where a run would call, or why it cannot yet. */
      host: { baseUrl: string | null; startCmd: string | null; from: string | null; error: string | null }
      /**
       * The deployed environment the same set can be run against: the URL as
       * stored, the header lines as stored (references, never resolved values),
       * and the reason a QA run would fail right now if there is one.
       */
      qa: { baseUrl: string | null; headers: string | null; error: string | null }
    }
  }
  /** API eval sets for a project, newest first. */
  'api.runs': { req: { projectId: string }; res: ApiEvalRun[] }
  /**
   * Run an automated eval set over the chosen endpoints. The session is asked for
   * the request data only; the app then starts the API if needed, sends every
   * request itself, and judges each response in code.
   *
   * `target` picks the environment: absent means the local API, 'qa' the deployed
   * one, which is never started and never stopped by the app.
   */
  'api.start': {
    req: {
      projectId: string
      endpoints: { method: string; template: string }[]
      target?: ApiTarget
    }
    res: { sessionId: string; runs: ApiEvalRun[] }
  }
  /** Set where a project's API lives. An empty string clears the override. */
  'api.setHost': {
    req: {
      projectId: string
      baseUrl?: string
      startCmd?: string
      /** The deployed environment's URL, and its `Name: value` header lines. */
      qaBaseUrl?: string
      qaHeaders?: string
    }
    res: Settings
  }
  /**
   * Write the test report for a finished run and answer with the file it wrote.
   *
   * On demand rather than on every run: the report is a document the developer
   * keeps, so it appears when they ask for one instead of accumulating a file per
   * run in their working tree. Everything in it is derived from the recorded run,
   * so an old run can still produce its report.
   */
  'api.report': {
    req: { projectId: string; runId?: string }
    res: { path: string }
  }
  /** Planned task queue: prompts/goals that auto-run in sequence (FR-023). */
  'queue.list': { req: { projectId: string }; res: QueuedTask[] }
  'queue.add': { req: { projectId: string; text: string }; res: QueuedTask[] }
  /** Reword a task that has not run yet. Empty text removes it. */
  'queue.edit': { req: { projectId: string; id: string; text: string }; res: QueuedTask[] }
  'queue.remove': { req: { projectId: string; id: string }; res: QueuedTask[] }
  'inbox.pending': { req: void; res: PermissionRequest[] }
  'inbox.decide': {
    req: { requestId: string; decision: 'approve' | 'deny'; confirmHighRisk?: boolean }
    res: { delivered: boolean }
  }
  'inbox.alwaysAllow': {
    // From a DECIDED history entry (design: right-click a command in history).
    // The main process derives the command-prefix matcher from the recorded
    // command; the caller only names the request.
    req: { requestId: string }
    res: { rule: PermissionRule }
  }
  'inbox.approveAlways': {
    // From a PENDING inbox item ("Always allow …"): inserts the standing rule
    // server-side, then approves this request. Bash → command-prefix rule
    // (refused for high-risk/destructive). MCP tools → tool_only rule
    // allow-listing the whole tool; high only by fail-safe, so confirmHighRisk
    // must be true to proceed. Refused for plans and other tools.
    req: { requestId: string; confirmHighRisk?: boolean }
    res: { delivered: boolean; rule: PermissionRule }
  }
  'inbox.approveAllForProject': {
    // includeHighRisk approves high-risk items too; the UI sets it only after an
    // explicit confirmation.
    req: { projectId: string; includeHighRisk?: boolean }
    res: { approved: number; skippedHighRisk: number }
  }
  'inbox.history': { req: { projectId?: string; limit?: number }; res: DecisionRecord[] }
  'inbox.deleteHistory': { req: { requestId: string }; res: void }
  'inbox.clearHistory': { req: void; res: void }
  'rules.standing.list': {
    req: { projectId: string; includeRevoked?: boolean }
    res: PermissionRule[]
  }
  'rules.standing.revoke': { req: { ruleId: string }; res: void }
  'rules.standing.restore': { req: { ruleId: string }; res: void }
  // User-authored allowed command (Allowed list tab): a Bash command-prefix rule.
  'rules.standing.add': { req: { projectId: string; pattern: string }; res: PermissionRule }
  // Risk and swallow rules are seeded defaults read by the main process only.
  // They have no editing UI, so they carry no IPC surface either.
  'settings.get': { req: void; res: Settings }
  'settings.set': { req: Partial<Settings>; res: Settings }
  /** Models this subscription can select, read from the CLI (probed on first ask
   *  when no session has reported yet), so the picker follows the account across
   *  model releases. Empty only when the CLI cannot answer → default only. */
  'models.available': { req: void; res: AvailableModel[] }
  /** App auto-update (GitHub releases). */
  'updates.check': { req: void; res: { status: UpdateStatus['state'] } }
  'updates.install': { req: void; res: void }
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  percent?: number
  message?: string
}

export type InvokeMethod = keyof InvokeMap

// --- Push surface (main -> renderer) ---

/** The full live session row; the renderer replaces its copy wholesale. */
export type SessionStatusPush = Session

export interface InboxChangedPush {
  added?: PermissionRequest
  resolved?: { requestId: string; status: PermissionRequestStatus; deliveryFailed?: boolean }
}

export interface QueueChangedPush {
  projectId: string
  items: QueuedTask[]
}

/** Available slash commands / skills for a project, captured from a session's
 * init message, pushed so the composer picks them up without a project switch. */
export interface ProjectCommandsPush {
  projectId: string
  commands: ProjectCommand[]
}

export type FocusRequestPush =
  | { target: 'inbox'; requestId: string }
  | { target: 'session'; sessionId: string; eventId?: string }

/** An acceptance line's result read off the session (the verifier gate), pushed
 *  so the Tests tab updates while the developer watches the check run. */
export interface EvalsChangedPush {
  projectId: string
  runs: EvalRun[]
}

/** A verification run's report read off the session, pushed so the gates and
 *  panels fill in as the run finishes rather than on a manual refresh. */
export interface VerifyChangedPush {
  projectId: string
  runs: VerifyRun[]
}

/** An API eval set's calls, pushed as the run finishes: the requests the app sent
 *  and the statuses it received, so the panel fills in without a refresh. */
export interface ApiChangedPush {
  projectId: string
  runs: ApiEvalRun[]
}

export interface PushMap {
  /** Individual events; the transport batches them (>= 30 Hz flushes) and the bridge fans out per event. */
  'push.event': SessionEvent
  'push.sessionStatus': SessionStatusPush
  'push.counters': Counters
  'push.inboxChanged': InboxChangedPush
  'push.queueChanged': QueueChangedPush
  'push.evalsChanged': EvalsChangedPush
  'push.verifyChanged': VerifyChangedPush
  'push.apiChanged': ApiChangedPush
  'push.projectCommands': ProjectCommandsPush
  'push.focusRequest': FocusRequestPush
  'push.updateStatus': UpdateStatus
}

export type PushChannel = keyof PushMap

export const PUSH_CHANNELS: readonly PushChannel[] = [
  'push.event',
  'push.sessionStatus',
  'push.counters',
  'push.inboxChanged',
  'push.queueChanged',
  'push.evalsChanged',
  'push.verifyChanged',
  'push.apiChanged',
  'push.projectCommands',
  'push.focusRequest',
  'push.updateStatus',
]

// --- The bridge exposed as `window.switchboard` ---

export interface SwitchboardApi {
  invoke<M extends InvokeMethod>(method: M, req: InvokeMap[M]['req']): Promise<InvokeMap[M]['res']>
  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void
  /**
   * Absolute path of a dragged-in OS file (Electron webUtils; File.path is
   * gone in modern Electron). Absent under the browser-based e2e mock.
   */
  pathForFile?(file: unknown): string
  /**
   * Subscribe to the number of in-flight `invoke` calls (drives the global
   * loading spinner). Fires immediately with the current count. Returns an
   * unsubscribe. Absent under the browser-based e2e mock.
   */
  onLoading?(listener: (pending: number) => void): () => void
}

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}

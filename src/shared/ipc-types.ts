// Single source of truth for the renderer <-> main IPC contract
// (specs/001-terminal-switchboard/contracts/ipc-contract.md).
// The preload bridge exposes this surface as `window.switchboard`.

import type {
  DecisionRecord,
  Draft,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  Project,
  ProjectCommand,
  ProjectRef,
  QueuedTask,
  RiskClassificationRule,
  Session,
  SessionEvent,
  Settings,
  SpecDetail,
  SpecKitState,
  SwallowRule,
} from './domain'

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
  /** The cached MCP schema map (.switchboard/db-schema.md), or null if unscanned. */
  'mcp.readSchema': { req: { projectId: string }; res: { content: string | null } }
  /**
   * Run text in the project's session (a spec-kit command or a start-phase
   * prompt), starting a session first if none is live. Returns its id.
   */
  'specs.runInSession': { req: { projectId: string; text: string }; res: { sessionId: string } }
  /** Planned task queue: prompts/goals that auto-run in sequence (FR-023). */
  'queue.list': { req: { projectId: string }; res: QueuedTask[] }
  'queue.add': { req: { projectId: string; text: string }; res: QueuedTask[] }
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
  'rules.risk.list': { req: void; res: RiskClassificationRule[] }
  'rules.risk.save': { req: { rules: RiskClassificationRule[] }; res: RiskClassificationRule[] }
  'rules.risk.restoreDefaults': { req: void; res: RiskClassificationRule[] }
  'rules.swallow.list': { req: { projectId?: string }; res: SwallowRule[] }
  'rules.swallow.save': { req: { rules: SwallowRule[] }; res: SwallowRule[] }
  'rules.swallow.restoreDefaults': { req: void; res: SwallowRule[] }
  'settings.get': { req: void; res: Settings }
  'settings.set': { req: Partial<Settings>; res: Settings }
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

export interface PushMap {
  /** Individual events; the transport batches them (>= 30 Hz flushes) and the bridge fans out per event. */
  'push.event': SessionEvent
  'push.sessionStatus': SessionStatusPush
  'push.counters': Counters
  'push.inboxChanged': InboxChangedPush
  'push.queueChanged': QueueChangedPush
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
}

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}

// Single source of truth for the renderer <-> main IPC contract
// (specs/001-terminal-switchboard/contracts/ipc-contract.md).
// The preload bridge exposes this surface as `window.switchboard`.

import type {
  DecisionRecord,
  Draft,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  PermissionRuleMatcher,
  Project,
  RiskClassificationRule,
  Session,
  SessionEndReason,
  SessionEvent,
  SessionStatus,
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
  | 'DELIVERY_FAILED'
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
}

export interface Counters {
  running: number
  needsYou: number
  pendingInbox: number
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
  'projects.archive': { req: { projectId: string }; res: void }
  'sessions.start': { req: { projectId: string; resume?: boolean }; res: Session }
  'sessions.stop': { req: { sessionId: string }; res: void }
  'sessions.interrupt': { req: { sessionId: string }; res: { stillQueued: number } }
  'sessions.send': { req: { sessionId: string; text: string }; res: { eventId: string; queued: boolean } }
  'sessions.answerQuestion': { req: { sessionId: string; eventId: string; choice: string }; res: void }
  'sessions.events': {
    req: { sessionId: string; beforeSeq?: number; limit?: number }
    res: SessionEvent[]
  }
  /** Recent distinct commands (past composer messages) for terminal-style suggestions. */
  'sessions.promptHistory': { req: { projectId: string; limit?: number }; res: string[] }
  /** Available slash commands / skills (plugins) for the project, for composer suggestions. */
  'projects.commands': { req: { projectId: string }; res: string[] }
  /** Spec Kit state for a project: installed? plus the spec summaries. */
  'specs.state': { req: { projectId: string }; res: SpecKitState }
  /** Full detail for one spec. */
  'specs.detail': { req: { projectId: string; specId: string }; res: SpecDetail | null }
  /** Install Spec Kit into the project (ephemeral uvx; never global). */
  'specs.install': { req: { projectId: string }; res: SpecKitState }
  'inbox.pending': { req: void; res: PermissionRequest[] }
  'inbox.decide': {
    req: { requestId: string; decision: 'approve' | 'deny'; confirmHighRisk?: boolean }
    res: { delivered: boolean }
  }
  'inbox.alwaysAllow': {
    req: { requestId: string; matcher: PermissionRuleMatcher }
    res: { rule: PermissionRule }
  }
  'inbox.approveAllForProject': {
    req: { projectId: string }
    res: { approved: number; skippedHighRisk: number }
  }
  'inbox.history': { req: { projectId?: string; before?: string; limit?: number }; res: DecisionRecord[] }
  'rules.standing.list': { req: { projectId: string }; res: PermissionRule[] }
  'rules.standing.revoke': { req: { ruleId: string }; res: void }
  'rules.risk.list': { req: void; res: RiskClassificationRule[] }
  'rules.risk.save': { req: { rules: RiskClassificationRule[] }; res: RiskClassificationRule[] }
  'rules.risk.restoreDefaults': { req: void; res: RiskClassificationRule[] }
  'rules.swallow.list': { req: { projectId?: string }; res: SwallowRule[] }
  'rules.swallow.save': { req: { rules: SwallowRule[] }; res: SwallowRule[] }
  'rules.swallow.restoreDefaults': { req: void; res: SwallowRule[] }
  'settings.get': { req: void; res: Settings }
  'settings.set': { req: Partial<Settings>; res: Settings }
}

export type InvokeMethod = keyof InvokeMap

// --- Push surface (main -> renderer) ---

export interface SessionStatusPush {
  sessionId: string
  projectId: string
  status: SessionStatus
  statusDetail?: string | null
  branch?: string | null
  diffAdds?: number | null
  diffDels?: number | null
  usageUtilization?: number | null
  usageResetsAt?: number | null
  usageLimitType?: string | null
  endedAt?: string | null
  endReason?: SessionEndReason | null
}

export interface InboxChangedPush {
  added?: PermissionRequest
  resolved?: { requestId: string; status: PermissionRequestStatus; deliveryFailed?: boolean }
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
  'push.focusRequest': FocusRequestPush
}

export type PushChannel = keyof PushMap

export const PUSH_CHANNELS: readonly PushChannel[] = [
  'push.event',
  'push.sessionStatus',
  'push.counters',
  'push.inboxChanged',
  'push.focusRequest',
]

// --- The bridge exposed as `window.switchboard` ---

export interface SwitchboardApi {
  invoke<M extends InvokeMethod>(method: M, req: InvokeMap[M]['req']): Promise<InvokeMap[M]['res']>
  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void
}

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}

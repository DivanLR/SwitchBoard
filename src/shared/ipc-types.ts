import type {
  AvailableModel,
  CustomSkill,
  DecisionRecord,
  DiagramEntry,
  DiffListResult,
  Draft,
  EvalCheckStatus,
  EvalRun,
  EvalVerdict,
  FileDiffContent,
  McpScan,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRule,
  Project,
  ProjectCommand,
  ProjectRef,
  QueuedTask,
  SectionKind,
  Session,
  FlowFeature,
  FlowItem,
  FlowLesson,
  FlowRun,
  ScopedItem,
  SecurityRun,
  SecurityScope,
  SessionEvent,
  SessionEngine,
  SessionMode,
  Settings,
  SkillImportResult,
  SpecDetail,
  SpecKitState,
  VerifyRun,
} from './domain'
import type { AvailableSuites } from './test-catalog'
import type { ApiEvalRun, ApiTarget, DiscoveredEndpoint } from './api-endpoints'
import type { ArchifyOptions } from './diagram'

type IpcErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_ACTIVE'
  | 'SESSION_ENDED'
  | 'CONFIRM_REQUIRED'
  | 'RULE_NOT_ALLOWED'
  | 'INVALID_PATH'
  | 'DUPLICATE'
  | 'NOT_LIVE'
  | 'SANDBOX_FULL'
  | 'UNSUPPORTED'
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

const IPC_ERROR_CODE_KEYS: Record<IpcErrorCode, true> = {
  NOT_FOUND: true,
  ALREADY_ACTIVE: true,
  SESSION_ENDED: true,
  CONFIRM_REQUIRED: true,
  RULE_NOT_ALLOWED: true,
  INVALID_PATH: true,
  DUPLICATE: true,
  NOT_LIVE: true,
  SANDBOX_FULL: true,
  UNSUPPORTED: true,
  INTERNAL: true,
}

export function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === 'string' && Object.hasOwn(IPC_ERROR_CODE_KEYS, value)
}

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (isIpcError(error)) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.trim() !== '') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() !== '' ? message : fallback
}

export type WireResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

export interface ProjectSuggestion {
  path: string
  name: string
}

export interface ProjectListItem extends Project {
  session: Session | null
  sessions: Session[]
  gitNotice: string | null
  drafts: Draft[]
  reserved: boolean
}

export interface Counters {
  running: number
  needsYou: number
  costTodayUsd: number
  tokensToday: number
}

interface ProjectsSnapshot {
  projects: ProjectListItem[]
  archived: Project[]
  counters: Counters
}

export interface InvokeMap {
  'projects.list': { req: void; res: ProjectsSnapshot }
  'dialog.pickFolder': { req: void; res: { path: string | null } }
  'dialog.pickFile': { req: { command: string }; res: { path: string | null } }
  'projects.register': {
    req: { path: string; name?: string; defaultSessionMode?: SessionMode }
    res: Project
  }
  'projects.setSessionMode': { req: { projectId: string; mode: SessionMode }; res: void }
  'projects.setUseContainers': { req: { projectId: string; on: boolean }; res: void }
  'projects.rename': { req: { projectId: string; name: string }; res: void }
  'projects.repoint': { req: { projectId: string; path: string }; res: Project }
  'projects.move': { req: { projectId: string; toIndex: number }; res: void }
  'projects.refs.add': {
    req: { projectId: string; target: string }
    res: ProjectRef[]
  }
  'projects.refs.remove': { req: { projectId: string; path: string }; res: ProjectRef[] }
  'projects.archive': { req: { projectId: string }; res: void }
  'projects.unarchive': { req: { projectId: string }; res: void }
  'terminal.open': {
    req: {
      id: string
      cwd: string
      cols: number
      rows: number
      engine: SessionEngine | 'shell'
      resumeSessionId?: string
    }
    res: { scrollback: string; reused: boolean }
  }
  'terminal.write': { req: { id: string; data: string }; res: void }
  'terminal.resize': { req: { id: string; cols: number; rows: number }; res: void }
  'terminal.close': { req: { id: string }; res: void }
  'sessions.start': {
    req: {
      projectId: string
      resume?: boolean
      mode?: SessionMode
      containerised?: boolean
      engine?: SessionEngine
      carryTranscriptFrom?: string
    }
    res: Session
  }
  'sessions.setPlanMode': { req: { sessionId: string; enabled: boolean }; res: void }
  'sessions.stop': { req: { sessionId: string }; res: void }
  'sessions.fate': {
    req: { sessionId: string }
    res: { endedAt: string | null; endReason: string | null; statusDetail: string | null } | null
  }
  'sessions.interrupt': { req: { sessionId: string }; res: { stillQueued: number } }
  'sessions.clearBackgroundTasks': { req: { sessionId: string }; res: void }
  'sessions.send': {
    req: { sessionId: string; text: string; agentId?: string }
    res: { eventId: string; queued: boolean }
  }
  'sessions.answerQuestion': { req: { sessionId: string; eventId: string; choice: string }; res: void }
  'sessions.events': {
    req: { sessionId: string; beforeSeq?: number; limit?: number }
    res: SessionEvent[]
  }
  'sessions.promptHistory': { req: { projectId: string; limit?: number }; res: string[] }
  'sessions.rename': { req: { sessionId: string; label: string }; res: void }
  'clipboard.write': { req: { text: string }; res: void }
  'clipboard.read': { req: void; res: { text: string } }
  'projects.commands': { req: { projectId: string }; res: ProjectCommand[] }
  'skills.list': { req: void; res: CustomSkill[] }
  'skills.import': { req: { url: string }; res: SkillImportResult }
  'skills.setEnabled': { req: { name: string; enabled: boolean }; res: CustomSkill[] }
  'skills.remove': { req: { name: string }; res: CustomSkill[] }
  'skills.run': { req: { projectId: string; name: string; argument?: string }; res: { sessionId: string } }
  'specs.state': { req: { projectId: string }; res: SpecKitState }
  'specs.detail': { req: { projectId: string; specId: string }; res: SpecDetail | null }
  'specs.install': { req: { projectId: string }; res: SpecKitState }
  'diff.list': { req: { projectId: string }; res: DiffListResult }
  'diff.file': { req: { projectId: string; path: string }; res: FileDiffContent | null }
  'diff.apply': {
    req: {
      projectId: string
      path: string
      lines: string[]
      instruction: string
    }
    res: { sessionId: string }
  }
  'diagrams.list': { req: { projectId: string }; res: DiagramEntry[] }
  'diagrams.generate': {
    req: { projectId: string; description: string; name?: string; archify?: ArchifyOptions }
    res: { sessionId: string; file: string }
  }
  'plugins.install': { req: { marketplace: string; pkg: string }; res: void }
  'diagrams.open': { req: { projectId: string; file: string }; res: void }
  'diagrams.read': { req: { projectId: string; file: string }; res: { html: string } }
  'mcp.readSchema': { req: { projectId: string; servers?: string[] }; res: { content: string | null } }
  'mcp.scanHistory': { req: { projectId: string }; res: McpScan[] }
  'mcp.recordScan': { req: { projectId: string; servers: string[] }; res: McpScan | null }
  'specs.runInSession': {
    req: {
      projectId: string
      text: string
      background?: boolean
      kind?: SectionKind
      watchDiagrams?: boolean
    }
    res: { sessionId: string }
  }
  'evals.list': { req: { projectId: string }; res: EvalRun[] }
  'evals.add': { req: { projectId: string; acceptance: string; checkCmd?: string }; res: EvalRun[] }
  'evals.record': {
    req: {
      projectId: string
      id: string
      checkStatus?: EvalCheckStatus
      verdict?: EvalVerdict
      rating?: number | null
      note?: string | null
      attempts?: number
    }
    res: EvalRun[]
  }
  'evals.remove': { req: { projectId: string; id: string }; res: EvalRun[] }
  'evals.suites': { req: { projectId: string }; res: AvailableSuites[] }
  'evals.dispatch': {
    req: { projectId: string; id: string; kind: 'check' | 'attempts' | 'judge' }
    res: { sessionId: string; runs: EvalRun[] }
  }
  'verify.list': { req: { projectId: string }; res: VerifyRun[] }
  'verify.start': {
    req: {
      projectId: string
      stackId: string
      suiteIds: string[]
      isolated?: boolean
    }
    res: { sessionId: string | null; runs: VerifyRun[] }
  }
  'verify.evidence': {
    req: { projectId: string; runId?: string }
    res: { sessionId: string; runs: VerifyRun[] }
  }
  'verify.cancel': { req: { projectId: string; runId: string }; res: VerifyRun[] }
  'flow.list': { req: { projectId: string }; res: { runs: FlowRun[]; items: FlowItem[] } }
  'flow.features': { req: { projectId: string; query?: string }; res: FlowFeature[] }
  'flow.start': {
    req: { projectId: string; featureId: string; featureTitle: string }
    res: { runId: string; runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.saveItems': {
    req: { projectId: string; runId: string; items: ScopedItem[] }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.publish': {
    req: { projectId: string; runId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.startWork': {
    req: { projectId: string; runId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.retryItem': {
    req: { projectId: string; itemId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.learn': {
    req: { projectId: string; runId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.spec': {
    req: { projectId: string; runId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'flow.lessons': { req: { projectId: string }; res: FlowLesson[] }
  'flow.decideLesson': {
    req: { projectId: string; lessonId: string; accept: boolean; reason?: string }
    res: { lessons: FlowLesson[]; appliedLines: number; path: string | null }
  }
  'flow.cancel': {
    req: { projectId: string; runId: string }
    res: { runs: FlowRun[]; items: FlowItem[] }
  }
  'security.list': { req: { projectId: string }; res: SecurityRun[] }
  'security.start': {
    req: { projectId: string; scope: SecurityScope }
    res: { sessionId: string; runs: SecurityRun[] }
  }
  'security.cancel': { req: { projectId: string; runId: string }; res: SecurityRun[] }
  'security.openReport': { req: { projectId: string; runId: string; file: string }; res: void }
  'api.endpoints': {
    req: { projectId: string }
    res: {
      endpoints: DiscoveredEndpoint[]
      recent: { method: string; template: string }[]
      filesRead: number
      truncated: boolean
      host: { baseUrl: string | null; startCmd: string | null; from: string | null; error: string | null }
      qa: { baseUrl: string | null; headers: string | null; error: string | null }
    }
  }
  'api.runs': { req: { projectId: string }; res: ApiEvalRun[] }
  'api.start': {
    req: {
      projectId: string
      endpoints: { method: string; template: string }[]
      target?: ApiTarget
    }
    res: { sessionId: string; runs: ApiEvalRun[] }
  }
  'api.cancel': { req: { projectId: string; runId: string }; res: ApiEvalRun[] }
  'api.setHost': {
    req: {
      projectId: string
      baseUrl?: string
      startCmd?: string
      qaBaseUrl?: string
      qaHeaders?: string
    }
    res: Settings
  }
  'api.report': {
    req: { projectId: string; runId?: string }
    res: { path: string }
  }
  'queue.list': { req: { projectId: string }; res: QueuedTask[] }
  'queue.add': { req: { projectId: string; text: string }; res: QueuedTask[] }
  'queue.edit': { req: { projectId: string; id: string; text: string }; res: QueuedTask[] }
  'queue.remove': { req: { projectId: string; id: string }; res: QueuedTask[] }
  'inbox.pending': { req: void; res: PermissionRequest[] }
  'inbox.decide': {
    req: { requestId: string; decision: 'approve' | 'deny'; confirmHighRisk?: boolean }
    res: { delivered: boolean }
  }
  'inbox.alwaysAllow': {
    req: { requestId: string }
    res: { rule: PermissionRule }
  }
  'inbox.approveAlways': {
    req: { requestId: string; confirmHighRisk?: boolean }
    res: { delivered: boolean; rule: PermissionRule }
  }
  'inbox.approveAllForProject': {
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
  'rules.standing.add': { req: { projectId: string; pattern: string }; res: PermissionRule }
  'sessions.editQueued': { req: { sessionId: string; eventId: string; text: string }; res: void }
  'settings.get': { req: void; res: Settings }
  'settings.set': { req: Partial<Settings>; res: Settings }
  'models.available': { req: void; res: AvailableModel[] }
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

export type SessionStatusPush = Session

export interface InboxChangedPush {
  added?: PermissionRequest
  resolved?: { requestId: string; status: PermissionRequestStatus; deliveryFailed?: boolean }
}

export interface QueueChangedPush {
  projectId: string
  items: QueuedTask[]
}

interface ProjectCommandsPush {
  projectId: string
  commands: ProjectCommand[]
}

export type FocusRequestPush =
  | { target: 'inbox'; requestId: string }
  | { target: 'session'; sessionId: string; eventId?: string }

interface EvalsChangedPush {
  projectId: string
  runs: EvalRun[]
}

interface VerifyChangedPush {
  projectId: string
  runs: VerifyRun[]
}

interface SecurityChangedPush {
  projectId: string
  runs: SecurityRun[]
}

interface FlowChangedPush {
  projectId: string
  runs: FlowRun[]
  items: FlowItem[]
}

interface DiagramsChangedPush {
  projectId: string
  entries: DiagramEntry[]
}

interface ApiChangedPush {
  projectId: string
  runs: ApiEvalRun[]
}

interface TerminalDataPush {
  id: string
  data: string
}

interface TerminalExitPush {
  id: string
  exitCode: number
}

export interface PushMap {
  'push.event': SessionEvent
  'push.sessionStatus': SessionStatusPush
  'push.counters': Counters
  'push.inboxChanged': InboxChangedPush
  'push.queueChanged': QueueChangedPush
  'push.evalsChanged': EvalsChangedPush
  'push.verifyChanged': VerifyChangedPush
  'push.securityChanged': SecurityChangedPush
  'push.flowChanged': FlowChangedPush
  'push.diagramsChanged': DiagramsChangedPush
  'push.apiChanged': ApiChangedPush
  'push.projectCommands': ProjectCommandsPush
  'push.focusRequest': FocusRequestPush
  'push.updateStatus': UpdateStatus
  'push.terminalData': TerminalDataPush
  'push.terminalExit': TerminalExitPush
}

export type PushChannel = keyof PushMap

const PUSH_CHANNEL_KEYS: Record<PushChannel, true> = {
  'push.event': true,
  'push.sessionStatus': true,
  'push.counters': true,
  'push.inboxChanged': true,
  'push.queueChanged': true,
  'push.evalsChanged': true,
  'push.verifyChanged': true,
  'push.securityChanged': true,
  'push.flowChanged': true,
  'push.diagramsChanged': true,
  'push.apiChanged': true,
  'push.projectCommands': true,
  'push.focusRequest': true,
  'push.updateStatus': true,
  'push.terminalData': true,
  'push.terminalExit': true,
}

export const PUSH_CHANNELS: readonly PushChannel[] = Object.keys(
  PUSH_CHANNEL_KEYS,
) as PushChannel[]

export const INVOKE_CHANNEL = 'switchboard:invoke'

export interface SwitchboardApi {
  invoke<M extends InvokeMethod>(method: M, req: InvokeMap[M]['req']): Promise<InvokeMap[M]['res']>
  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void
  pathForFile?(file: unknown): string
  onLoading?(listener: (pending: number) => void): () => void
}

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}

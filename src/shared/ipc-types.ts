import type {
  AvailableModel,
  CustomSkill,
  DecisionRecord,
  DiagramEntry,
  DiffListResult,
  Draft,
  FileDiffContent,
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
  FlowRun,
  FlowStackId,
  FlowStage,
  FlowStageRecord,
  SessionEvent,
  SessionMode,
  Settings,
  SkillImportResult,
  SddProcess,
  SpecDetail,
  SpecKitState,
  SpecSummary,
  VerifyRun,
} from './domain'
import type { AvailableSuites } from './test-catalog'
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

export interface FlowSnapshot {
  runs: FlowRun[]
  stages: FlowStageRecord[]
}

export type FlowStartSource =
  | { kind: 'ado'; featureId: string; featureTitle: string; url: string | null }
  | { kind: 'text'; title: string; description: string }
  | { kind: 'spec'; specId: string }
  | { kind: 'bug'; title: string; symptom: string; slug?: string }
  | { kind: 'idea'; title: string; idea: string; slug?: string }

export interface FlowCompanionRequest {
  projectId: string
  baseBranch?: string
}

export type FlowArtefactKind = 'spec' | 'plan' | 'tasks' | 'postman' | 'report' | 'doc'

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
      engine: 'claude' | 'shell'
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
  'skills.installed': { req: void; res: string[] }
  'skills.import': { req: { url: string }; res: SkillImportResult }
  'skills.setEnabled': { req: { name: string; enabled: boolean }; res: CustomSkill[] }
  'skills.remove': { req: { name: string }; res: CustomSkill[] }
  'specs.state': { req: { projectId: string }; res: SpecKitState }
  'specs.detail': { req: { projectId: string; specId: string }; res: SpecDetail | null }
  'specs.install': { req: { projectId: string }; res: SpecKitState }
  'specs.installExtension': { req: { projectId: string; name: SddProcess }; res: SpecKitState }
  'specs.report': {
    req: { projectId: string; process: SddProcess; slug: string; file: string }
    res: { path: string; content: string } | null
  }
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
  'sections.runInSession': {
    req: {
      projectId: string
      text: string
      background?: boolean
      kind: SectionKind
      watchDiagrams?: boolean
    }
    res: { sessionId: string }
  }
  'verify.list': { req: { projectId: string }; res: VerifyRun[] }
  'verify.suites': { req: { projectId: string }; res: AvailableSuites[] }
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
  'flow.list': { req: { projectId: string }; res: FlowSnapshot }
  'flow.features': { req: { projectId: string; query?: string }; res: FlowFeature[] }
  'flow.existingSpecs': { req: { projectId: string }; res: SpecSummary[] }
  'flow.detectStacks': { req: { projectId: string }; res: FlowStackId[] }
  'flow.start': {
    req: {
      projectId: string
      source: FlowStartSource
      autopilot: boolean
      autoShip: boolean
      checklist?: boolean
      baseBranch?: string
      companions?: FlowCompanionRequest[]
    }
    res: { runId: string } & FlowSnapshot
  }
  'flow.approve': { req: { runId: string }; res: FlowSnapshot }
  'flow.retry': { req: { runId: string }; res: FlowSnapshot }
  'flow.skip': { req: { runId: string }; res: FlowSnapshot }
  'flow.fix': { req: { runId: string }; res: FlowSnapshot }
  'flow.ship': { req: { runId: string }; res: FlowSnapshot }
  'flow.feature': { req: { runId: string }; res: { title: string; description: string } }
  'flow.cancel': { req: { runId: string }; res: FlowSnapshot }
  'flow.revise': { req: { runId: string; feedback: string }; res: FlowSnapshot }
  'flow.setAutopilot': { req: { runId: string; autopilot: boolean }; res: FlowSnapshot }
  'flow.removeWorktree': { req: { runId: string; force?: boolean }; res: FlowSnapshot }
  'flow.openPullRequest': { req: { runId: string; projectId?: string }; res: void }
  'flow.artefact': {
    req: { runId: string; stage: FlowStage; kind?: FlowArtefactKind }
    res: { path: string | null; content: string } | null
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

interface VerifyChangedPush {
  projectId: string
  runs: VerifyRun[]
}

interface FlowChangedPush extends FlowSnapshot {
  projectId: string
}

interface DiagramsChangedPush {
  projectId: string
  entries: DiagramEntry[]
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
  'push.verifyChanged': VerifyChangedPush
  'push.flowChanged': FlowChangedPush
  'push.diagramsChanged': DiagramsChangedPush
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
  'push.verifyChanged': true,
  'push.flowChanged': true,
  'push.diagramsChanged': true,
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

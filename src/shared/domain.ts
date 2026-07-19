// Domain types mirrored from specs/001-terminal-switchboard/data-model.md.
// All timestamps are ISO 8601 UTC strings; identifiers are UUIDv7.

export type ProjectSource = 'suggested' | 'manual'

export type SessionStatus = 'working' | 'needs_you' | 'done' | 'error'

export type SessionEndReason = 'completed' | 'stopped' | 'crashed' | 'app_exit'

export type EventKind =
  | 'prompt'
  | 'assistant_text'
  | 'summary'
  | 'tool_activity'
  | 'question'
  | 'permission_marker'
  | 'plan_marker'
  | 'error'
  | 'result'
  | 'raw_output'

export type RiskLevel = 'low' | 'medium' | 'high'

export type PermissionRequestType = 'tool_permission' | 'plan_approval'

export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'rule_approved'

export type DecisionOutcome = Exclude<PermissionRequestStatus, 'pending'>

export type SwallowScope = 'global' | 'project'

export interface Project {
  id: string
  name: string
  path: string
  source: ProjectSource
  createdAt: string
  archivedAt: string | null
}

export interface Session {
  id: string
  projectId: string
  sdkSessionId: string | null
  status: SessionStatus
  statusDetail: string | null
  branch: string | null
  /** Working-tree line changes since session start, shown in the header (design reference). */
  diffAdds: number | null
  diffDels: number | null
  startedAt: string
  endedAt: string | null
  endReason: SessionEndReason | null
}

// --- Event payloads (contracts/session-events.md) ---

export interface PromptPayload {
  text: string
  /** True while the message is queued and not yet delivered to the session (FR-019). */
  pending?: boolean
}

export interface AssistantTextPayload {
  text: string
  partial: boolean
}

export interface SummaryPayload {
  text: string
}

export interface ToolActivityPayload {
  toolName: string
  inputPreview: string
  resultPreview?: string
  isError?: boolean
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionPayload {
  text: string
  options: QuestionOption[]
  answered?: boolean
  answer?: string
}

export interface PermissionMarkerPayload {
  requestId: string
  title: string
  risk: RiskLevel
  status: PermissionRequestStatus
}

export interface PlanMarkerPayload {
  requestId: string
  title: string
  status: PermissionRequestStatus
}

export interface ErrorPayload {
  text: string
  fatal: boolean
}

export interface ResultUsage {
  inputTokens?: number
  outputTokens?: number
  [key: string]: unknown
}

export interface ResultPayload {
  text?: string
  totalCostUsd: number
  usage: ResultUsage
  durationMs: number
}

export interface RawOutputPayload {
  text: string
}

export interface EventPayloadMap {
  prompt: PromptPayload
  assistant_text: AssistantTextPayload
  summary: SummaryPayload
  tool_activity: ToolActivityPayload
  question: QuestionPayload
  permission_marker: PermissionMarkerPayload
  plan_marker: PlanMarkerPayload
  error: ErrorPayload
  result: ResultPayload
  raw_output: RawOutputPayload
}

export interface SessionEvent<K extends EventKind = EventKind> {
  id: string
  sessionId: string
  /** Monotonic per session, assigned in arrival order; the only ordering key. */
  seq: number
  kind: K
  payload: EventPayloadMap[K]
  /** Set by the swallow classifier; null means never swallowed (FR-015a). */
  noiseKind: string | null
  createdAt: string
}

/** Event kinds the swallow classifier may tag; all others are categorically exempt (FR-015a, FR-017). */
export const SWALLOWABLE_KINDS: readonly EventKind[] = ['tool_activity', 'raw_output', 'assistant_text']

// --- Permissions ---

export interface PermissionRequest {
  id: string
  sessionId: string
  /** Denormalised for inbox grouping. */
  projectId: string
  type: PermissionRequestType
  toolName: string | null
  title: string
  explanation: string
  detail: string
  risk: RiskLevel
  status: PermissionRequestStatus
  createdAt: string
  resolvedAt: string | null
  /** Set when the decision could not reach the originating session (SC-004). */
  deliveryFailed: boolean
}

/** History projection of resolved PermissionRequests (FR-012). */
export interface DecisionRecord extends Omit<PermissionRequest, 'status' | 'resolvedAt'> {
  status: DecisionOutcome
  resolvedAt: string
}

export type PermissionRuleMatcherKind = 'command_prefix' | 'path_glob' | 'exact_input' | 'tool_only'

export interface PermissionRuleMatcher {
  kind: PermissionRuleMatcherKind
  /** Prefix, glob, or serialised input depending on `kind`; absent for `tool_only`. */
  value?: string
}

export interface PermissionRule {
  id: string
  /** Standing rules are always per project, never global. */
  projectId: string
  toolName: string
  matcher: PermissionRuleMatcher
  createdFromRequestId: string
  createdAt: string
  revokedAt: string | null
}

export interface RiskInputMatcher {
  /** Tool input property the pattern applies to, for example `command` or `file_path`. */
  field: string
  match: 'regex' | 'prefix' | 'glob'
  pattern: string
}

export interface RiskClassificationRule {
  id: string
  scope: 'global'
  /** Ordered; first match wins. */
  position: number
  /** Tool name or `*`. */
  toolMatcher: string
  inputMatcher: RiskInputMatcher | null
  risk: RiskLevel
  /** Seeded defaults are editable and deletable; restore-defaults re-seeds. */
  builtin: boolean
}

export interface SwallowRule {
  id: string
  scope: SwallowScope
  projectId: string | null
  /** Ordered; first match wins. Project-scope rules take precedence over global. */
  position: number
  /** Event kind the rule may tag (`tool_activity`, `raw_output`, `assistant_text`, or `*`). */
  eventKindMatcher: string
  /** Regular expression applied to the event's display text. */
  pattern: string
  /** Label shown on the swallowed block, for example "build output". */
  noiseKind: string
  enabled: boolean
}

export type TerseLevel = 'lite' | 'full' | 'ultra'

export interface Settings {
  defaultView: 'clean' | 'raw'
  notificationsEnabled: boolean
  /**
   * Terse (caveman-style) output mode: appends a concise-style instruction to
   * every hosted session's system prompt so the model generates fewer output
   * tokens. Reduces output tokens only; code, commands and errors are preserved.
   */
  terseMode: boolean
  terseLevel: TerseLevel
  /** Fixed in v1 but stored for forward compatibility (FR-021a). */
  retentionDecisionDays: number
  retentionSessionsPerProject: number
  lastFocusedProjectId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'clean',
  notificationsEnabled: true,
  terseMode: true,
  terseLevel: 'full',
  retentionDecisionDays: 30,
  retentionSessionsPerProject: 2,
  lastFocusedProjectId: null,
}

/** Composer message preserved across an application quit and offered on next session start. */
export interface Draft {
  id: string
  projectId: string
  text: string
  createdAt: string
}

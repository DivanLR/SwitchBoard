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
  /** Subscription rate-limit usage from the SDK rate_limit_event (session usage meter). */
  usageUtilization: number | null
  usageResetsAt: number | null
  usageLimitType: string | null
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

/** Selectable Claude models for sessions, rendered as settings cards (design reference). */
export interface ModelChoice {
  id: string
  label: string
  /** One-line strengths description shown under the name. */
  desc: string
  /** Relative cost hint shown at the card's right edge. */
  price: string
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'default', label: 'Account default', desc: 'Follows your subscription default model', price: '—' },
  { id: 'claude-fable-5', label: 'Fable 5', desc: 'Deepest reasoning — best for architecture and tricky plans', price: '$$$' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', desc: 'Strong reasoning with faster output', price: '$$$' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Fast and strong — the everyday workhorse', price: '$$' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', desc: 'Fastest and cheapest — simple, mechanical edits', price: '$' },
]

export interface Settings {
  defaultView: 'clean' | 'raw'
  notificationsEnabled: boolean
  /** Model for planning turns (plan mode); 'default' uses the account default. */
  planModel: string
  /** Model for normal work turns; 'default' uses the account default. */
  workModel: string
  /**
   * Terse (caveman-style) output mode: appends a concise-style instruction to
   * every hosted session's system prompt so the model generates fewer output
   * tokens. Reduces output tokens only; code, commands and errors are preserved.
   */
  terseMode: boolean
  terseLevel: TerseLevel
  /** Output display (design reference, Terminals tab). */
  fontSize: 'sm' | 'md' | 'lg'
  /** Clean view shows tool activity as collapsible rows instead of hiding it. */
  showToolRows: boolean
  /** Show the time next to every event in the Clean view. */
  timestamps: boolean
  /** Keep the view pinned to the newest line while the session works. */
  autoscroll: boolean
  /** Per-project implementation-model overrides; 'global' or absent follows workModel. */
  projectModels: Record<string, string>
  /** Fixed in v1 but stored for forward compatibility (FR-021a). */
  retentionDecisionDays: number
  retentionSessionsPerProject: number
  lastFocusedProjectId: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'clean',
  notificationsEnabled: true,
  planModel: 'default',
  workModel: 'default',
  terseMode: true,
  terseLevel: 'full',
  fontSize: 'md',
  showToolRows: false,
  timestamps: false,
  autoscroll: true,
  projectModels: {},
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

/** A planned prompt/command queued to auto-run when the session next goes idle (FR-023). */
export interface QueuedTask {
  id: string
  projectId: string
  text: string
  position: number
  createdAt: string
}

// --- Spec Kit (github/spec-kit) per-project specs ---

export type SpecStatus = 'draft' | 'in_progress' | 'complete'

/** One feature spec (a `specs/NNN-name/` directory) — summary for the chip list. */
export interface SpecSummary {
  id: string // directory name, e.g. "001-terminal-switchboard"
  title: string
  status: SpecStatus
  tasksTotal: number
  tasksDone: number
}

export interface SpecSection {
  title: string
  body: string
}

/** A resolved clarification (question already answered), from spec.md. */
export interface ResolvedClarification {
  question: string
  answer: string
}

/** Spec Kit slash commands offered as buttons in the specs view. */
export interface SpecKitCommand {
  command: string // e.g. "speckit-clarify"
  label: string
  hint: string
}

export const SPEC_KIT_COMMANDS: readonly SpecKitCommand[] = [
  { command: 'speckit-specify', label: '/specify', hint: 'Create or update the feature spec' },
  { command: 'speckit-clarify', label: '/clarify', hint: 'Ask clarifying questions, write answers back' },
  { command: 'speckit-plan', label: '/plan', hint: 'Generate the implementation plan' },
  { command: 'speckit-tasks', label: '/tasks', hint: 'Generate the dependency-ordered task list' },
  { command: 'speckit-analyze', label: '/analyze', hint: 'Cross-check spec, plan, and tasks' },
  { command: 'speckit-checklist', label: '/checklist', hint: 'Generate a quality checklist' },
  { command: 'speckit-implement', label: '/implement', hint: 'Execute the task list' },
]

export interface SpecTask {
  id: string // e.g. "T001"
  label: string
  done: boolean
}

export interface SpecPhase {
  label: string
  tasks: SpecTask[]
}

/** Full detail for one selected spec. */
export interface SpecDetail extends SpecSummary {
  description: string
  path: string
  /** Sections parsed from spec.md (## headings). */
  sections: SpecSection[]
  /** Tasks grouped by phase from tasks.md. */
  phases: SpecPhase[]
  /** Open [NEEDS CLARIFICATION] questions from spec.md. */
  clarifications: string[]
  /** Clarifications already answered (## Clarifications section). */
  resolvedClarifications: ResolvedClarification[]
}

/** Spec Kit status for a project. */
export interface SpecKitState {
  installed: boolean // `.specify/` present
  specs: SpecSummary[]
}

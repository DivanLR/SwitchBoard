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

/** A folder a project's sessions may read for context (header REFS chips). */
export interface ProjectRef {
  path: string
  label: string
}

export interface Project {
  id: string
  name: string
  path: string
  source: ProjectSource
  createdAt: string
  archivedAt: string | null
  /** Extra folders granted to sessions as additional directories (REFS row). */
  refs: ProjectRef[]
}

/** An MCP server the session reported in its init message (sidebar MCP row). */
export interface McpServer {
  name: string
  /** SDK-reported connection status, e.g. 'connected' | 'failed' | 'pending'. */
  status: string
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
  /**
   * Started with --dangerously-skip-permissions (header "⚠ Bypass" pill), which
   * also means the session ran inside the Docker sandbox. Persisted, because a
   * bypass session's transcript lives in a container volume rather than the
   * host's ~/.claude: resuming one as a native session (or the reverse) would
   * look for that transcript in the wrong place and silently find nothing.
   */
  bypassPermissions?: boolean
  /** MCP servers reported in the session init message (in-memory only). */
  mcpServers?: McpServer[]
  /** Model the SDK reported for the latest main-loop turn (in-memory only). */
  currentModel?: string | null
  /** Pairing mode chosen for the latest work turn (in-memory only): advisor,
   *  orchestrator, or null for plan/question turns. */
  currentMode?: 'advisor' | 'orchestrator' | null
  /** Live background tasks (deep-research workflows, backgrounded subagents/bash)
   *  the SDK reports for this session (in-memory only). */
  backgroundTasks?: { taskId: string; description: string }[]
  /** Cumulative per-model usage for this session (in-memory only): total
   *  processed tokens (input + output + cache) and cost, keyed by model id. */
  modelTotals?: Record<string, { tokens: number; costUsd: number }>
}

// --- Event payloads (contracts/session-events.md) ---

/**
 * Mixed into payloads produced inside a subagent (Task/Agent tool run):
 * `agentId` is the spawning tool_use id (the SDK's parent_tool_use_id).
 * Main-loop events leave it unset. Drives the per-agent chat view.
 */
export interface AgentScopedPayload {
  agentId?: string
}

export interface PromptPayload extends AgentScopedPayload {
  text: string
  /** True while the message is queued and not yet delivered to the session (FR-019). */
  pending?: boolean
}

export interface AssistantTextPayload extends AgentScopedPayload {
  text: string
  partial: boolean
}

export interface SummaryPayload extends AgentScopedPayload {
  text: string
}

export interface ToolActivityPayload extends AgentScopedPayload {
  toolName: string
  inputPreview: string
  resultPreview?: string
  isError?: boolean
  /** The SDK tool_use id — subagent events reference it as their agentId. */
  toolUseId?: string
  /** A subagent reported via the SDK task channel (backgrounded / parallel
   *  fan-out). It may outlive the turn that spawned it, so it stays "active"
   *  across a result boundary until explicitly closed. */
  background?: boolean
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
  /** The tool the marker is for — the clean view shows a generic action label
   *  ("Ran a command") from this instead of the full command in `title`. */
  toolName?: string | null
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

export interface RawOutputPayload extends AgentScopedPayload {
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

export type PermissionRuleMatcherKind = 'command_prefix' | 'path_glob' | 'tool_only'

export interface PermissionRuleMatcher {
  kind: PermissionRuleMatcherKind
  /** Command prefix or path glob depending on `kind`; absent for `tool_only`. */
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

/**
 * Shell commands that can never become a standing auto-approve rule — even from
 * a history entry the developer approved once — because they are destructive or
 * irreversible/outward-facing (the design's locked "rm · sudo · git push" row).
 * This is deliberately NARROWER than the risk classifier's fail-safe-to-high:
 * ordinary vetted commands (`mkdir`, `make build`, `python x`) are unmatched by
 * the classifier and land at `high`, but must still be eligible for "always
 * allow". Only the genuinely dangerous set below is ever barred.
 */
const DANGEROUS_COMMAND =
  /\b(rm|rmdir|del|rd|format|mkfs|dd|sudo|doas)\b|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command)
}

export interface RiskInputMatcher {
  /** Tool input property the pattern applies to, for example `command` or `file_path`. */
  field: string
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

/** A collapsible sidebar group holding projects; array order is display order. */
export interface ProjectGroup {
  id: string
  name: string
  /** Persisted so a folded group stays folded across restarts. */
  collapsed: boolean
  /** Swatch colour on the group header, taken from the sidebar accent palette
   *  when the group is created. Absent on groups saved before colours existed;
   *  those fall back to their position in the list. */
  color?: string
}

/** Shape of one model card in the settings picker. Built at runtime from the
 *  discovered model list (see AvailableModel) — there is no hardcoded catalogue,
 *  so a newly released model appears without a code change. */
export interface ModelChoice {
  id: string
  label: string
  /** One-line strengths description shown under the name (from the SDK). */
  desc: string
  /** Relative cost hint shown at the card's right edge. */
  price: string
}

/** A model the subscription can actually select, discovered from the SDK's
 *  supportedModels(). `id` is the canonical wire id (used for setModel and
 *  persisted in settings); `label`/`description` come from the SDK. */
export interface AvailableModel {
  id: string
  label: string
  description: string
}

// Model families, strongest first. The only model knowledge the app keeps:
// families change far more rarely than the models within them, so a new release
// inherits its family's label, price hint and fallback rung automatically.
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** The family an id belongs to, or null when it names none (including 'default',
 *  which resolves to whatever the account default is). */
export function modelFamily(id: string | undefined): string | null {
  if (!id) return null
  const lower = id.toLowerCase()
  return FAMILIES.find((family) => lower.includes(family)) ?? null
}

/**
 * Display label derived from a model id, so any model reads correctly with no
 * code change: 'claude-opus-5[1m]' → 'Opus 5 (1M)', 'claude-haiku-4-5-20251001'
 * → 'Haiku 4.5', 'sonnet' → 'Sonnet'. Preferred over the SDK's own displayName,
 * which drops the version ('Opus', 'Sonnet') and so cannot tell two releases of
 * one family apart.
 */
export function modelLabel(id: string): string {
  if (!id || id === 'default') return 'Account default'
  const oneMillion = /\[1m\]/i.test(id)
  const base = id
    .replace(/\[1m\]/i, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // release-date suffix, e.g. haiku-4-5-20251001
  const [family = base, ...version] = base.split('-')
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return `${name}${version.length ? ` ${version.join('.')}` : ''}${oneMillion ? ' (1M)' : ''}`
}

const FAMILY_PRICE: Record<string, string> = {
  fable: '$$$',
  opus: '$$$',
  sonnet: '$$',
  haiku: '$',
}

/** Relative cost hint for a model card; '—' when the family is not recognised. */
export function modelPrice(id: string): string {
  return FAMILY_PRICE[modelFamily(id) ?? ''] ?? '—'
}

/** Advisor/Orchestrator pairing mode; 'auto' picks per message by workload. */
export type ModelMode = 'auto' | 'advisor' | 'orchestrator'

export interface Settings {
  defaultView: 'clean' | 'raw'
  notificationsEnabled: boolean
  /**
   * The INTELLIGENT model: plans, answers questions, runs Orchestrator loops,
   * and advises in Advisor mode. 'default' uses the account default.
   */
  intelligentModel: string
  /**
   * The WORKER model: always the cheaper one. Runs Advisor-mode executor turns
   * and Orchestrator worker subagents.
   */
  workerModel: string
  /**
   * Route each message by intent instead of by plan/build mode: question-shaped
   * messages use the intelligent model; work routes by the pairing mode below.
   */
  autoModelRouting: boolean
  /**
   * Advisor/Orchestrator pairing mode (the Fable-5 era cost patterns).
   * 'auto' lets the app pick per message from the workload: scoped mechanical
   * work runs Advisor (cheap executor + rare strong-model consults); broad
   * multi-step work runs Orchestrator (strong planner + cheap parallel
   * workers). Forcing a mode pins every work turn to that pattern.
   */
  modelMode: ModelMode
  /**
   * Terse (caveman-style) output mode: appends a concise-style instruction to
   * every hosted session's system prompt so the model generates fewer output
   * tokens. Reduces output tokens only; code, commands and errors are preserved.
   */
  terseMode: boolean
  terseLevel: TerseLevel
  /**
   * Relabel each turn's closing message as a ✦ SUMMARY. Off shows that message
   * as ordinary assistant text — the raw response (e.g. the full /usage report)
   * with no summary styling. A display choice only; no extra model call.
   */
  summaries: boolean
  /** Output display (design reference, Terminals tab). */
  fontSize: 'sm' | 'md' | 'lg'
  /** Clean view shows tool activity as collapsible rows instead of hiding it. */
  showToolRows: boolean
  /** Show the time next to every event in the Clean view. */
  timestamps: boolean
  /** Keep the view pinned to the newest line while the session works. */
  autoscroll: boolean
  /** Per-project INTELLIGENT-model overrides; 'global'/absent follows the global one. */
  projectModels: Record<string, string>
  /**
   * Per-project WORKER-model overrides — 'global' or absent follows the global
   * worker model.
   */
  projectWorkerModels: Record<string, string>
  /** The verification stack chosen for a project's Tests section (a TEST_STACKS
   *  id). Absent means nothing chosen yet, so the section shows the picker with
   *  whatever detection found. */
  projectTestStacks: Record<string, string>
  /** Auto-approve requests by risk level (Allowed list tab): recorded as rule_approved. */
  autoApproveLow: boolean
  autoApproveMedium: boolean
  /**
   * Collapsible sidebar groups, in display order. Sidebar-only organisation, so
   * it lives here beside the other per-project maps rather than in the schema.
   */
  projectGroups: ProjectGroup[]
  /** projectId -> groupId. An absent or unknown id means the project is ungrouped. */
  projectGroupOf: Record<string, string>
  /** Per-project plugin/skill commands hidden from composer suggestions. */
  disabledCommands: Record<string, string[]>
  /**
   * MCP servers shown in the MCP view (Settings → MCP toggles the roster).
   * Sessions still expose every configured server; this only controls which
   * appear as checkboxes in the combined MCP view and the sidebar.
   */
  databaseMcpServers: string[]
  /**
   * The subset of the roster currently ACTIVE in the MCP chat — the working
   * combination. Each distinct combination gets its own scan doc + history row.
   */
  mcpActiveServers: string[]
}

/** One scanned MCP combination (history row for "have I scanned this before?"). */
export interface McpScan {
  id: string
  projectId: string
  /** Order-independent display key, e.g. "github + postgres". */
  comboKey: string
  servers: string[]
  scannedAt: string
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'clean',
  notificationsEnabled: true,
  intelligentModel: 'default',
  // The worker defaults to the cheaper everyday model, per the pairing modes.
  workerModel: 'claude-sonnet-5',
  autoModelRouting: true,
  modelMode: 'auto',
  terseMode: true,
  terseLevel: 'full',
  summaries: true,
  fontSize: 'md',
  // Clean view is narrative + approvals by default; tool rows live in Raw.
  showToolRows: false,
  timestamps: false,
  autoscroll: true,
  projectModels: {},
  projectWorkerModels: {},
  projectTestStacks: {},
  autoApproveLow: false,
  autoApproveMedium: false,
  projectGroups: [],
  projectGroupOf: {},
  disabledCommands: {},
  databaseMcpServers: [],
  mcpActiveServers: [],
}

/** A slash command / skill a project's sessions can run (composer suggestions). */
export interface ProjectCommand {
  name: string
  /** Small explanation of what the command does, shown next to the suggestion. */
  description?: string
}

/** Composer message preserved across an application quit and offered on next session start. */
export interface Draft {
  id: string
  projectId: string
  text: string
  createdAt: string
}

/** A planned prompt/command queued to auto-run when the session next goes idle (FR-023). */
// --- Eval loop (spec 002 US7 / FR-086..FR-092) ---

/** Outcome of an acceptance line's check. 'not_run' is never "passing": the app
 *  does not parse a verdict the session did not report (FR-087). 'inconclusive'
 *  is the check having run without reporting a readable result (FR-047) — also
 *  never passing. */
export type EvalCheckStatus = 'not_run' | 'pass' | 'fail' | 'inconclusive'
/** The developer's own verdict on the change, after looking at it. */
export type EvalVerdict = 'pending' | 'pass' | 'fail'

/**
 * One small change, recorded as a single observable acceptance line instead of a
 * spec document. The check proves it, the verdict is the developer's, and the
 * rating (1-5) is their score of what was generated — never derived (FR-089).
 */
export interface EvalRun {
  id: string
  projectId: string
  /** One observable sentence: a testid, a label, a status — not an approach. */
  acceptance: string
  /** The command that proves it, run through the session. Null for styling-only. */
  checkCmd: string | null
  checkStatus: EvalCheckStatus
  verdict: EvalVerdict
  rating: number | null
  note: string | null
  /** How many independent, worktree-isolated attempts were requested (1 = one
   *  straight run). Best-of-N: the developer keeps the winner. */
  attempts: number
  /** The judge pass: a second opinion on the diff against the acceptance line,
   *  read back from the session. Null until a judge pass has run. */
  judge: string | null
  createdAt: string
}

/** A rating at or below this needs another loop, not a rewrite (FR-091). */
export const EVAL_RELOOP_RATING = 3

/**
 * Coordinator-Implementor-Verifier stage of an acceptance line. Derived from
 * what has actually happened rather than stored, so it can never disagree with
 * the row: no stored stage to drift, nothing to advance by hand.
 */
export type EvalStage = 'implement' | 'verify' | 'review' | 'done'

export function evalStage(run: Pick<EvalRun, 'checkStatus' | 'verdict' | 'judge'>): EvalStage {
  if (run.verdict !== 'pending') return 'done'
  if (run.judge) return 'review'
  if (run.checkStatus !== 'not_run') return 'verify'
  return 'implement'
}

/**
 * The verifier gate: a human PASS is only offered once the check has passed
 * (FR-087). A line with no check at all is gated by the manual pass instead, so
 * it is never blocked here. Fail is always available — a gate stops false
 * passes, not honest failures.
 */
export function canPassEval(run: Pick<EvalRun, 'checkCmd' | 'checkStatus'>): boolean {
  return !run.checkCmd || run.checkStatus === 'pass'
}

// --- Verification runs (spec 002 US1-US4: results, coverage, quality, evidence) ---

/**
 * One figure plus the tool that produced it (FR-072). `value: null` means NOT
 * MEASURED and must render as "—": the app never derives, estimates or
 * substitutes a number, and every number it does show names its source.
 */
export interface Measured {
  value: number | null
  /** e.g. "dotnet test --collect", "sonarqube", "stryker". Null when unmeasured. */
  source: string | null
}

/** 'unavailable' is the environment's limit (no .NET SDK in the sandbox), never
 *  the code's fault (FR-057). 'not_run' is a suite a stopped run never reached
 *  (FR-075) — both are distinct from a failure. */
export type SuiteStatus = 'pass' | 'fail' | 'skipped' | 'unavailable' | 'not_run'

export interface SuiteResult {
  /** Catalog suite id, so the panel can name it even if the report shortens it. */
  id: string
  label: string
  status: SuiteStatus
  /** One line: counts, the first failure, or why it could not run. */
  detail: string
}

/** Proof the code was executed — real input and the real result (FR-048). */
export interface EvidenceItem {
  kind: 'run' | 'screenshot'
  /** The request sent, the case exercised, or the screen captured. */
  what: string
  /** What actually came back. */
  result: string
  /** Absolute path to a file the session saved (a screenshot), if any. */
  path: string | null
}

/** What one verification run measured. Every block is independently nullable:
 *  a run that only executed unit tests reports coverage and quality as unmeasured
 *  rather than as zero. */
export interface VerifyReport {
  suites: SuiteResult[]
  coverage: {
    line: Measured
    /** Coverage of the changed lines alone — the threshold that matters (FR-084). */
    changed: Measured
    /** The touched files a test reaches least, worst first. */
    files: { path: string; pct: number }[]
  }
  quality: {
    /** The external code-quality service's own gate. 'not_configured' when no
     *  such server is connected — absence is stated, never read as a pass. */
    gate: 'pass' | 'fail' | 'not_configured' | null
    gateSource: string | null
    /** Percent duplicated lines. */
    duplication: Measured
    /** The service's technical-debt figure, verbatim (e.g. "2d 4h"). */
    debt: string | null
    /** Percent of mutants killed. */
    mutation: Measured
    /** Surviving mutants worth looking at, as the tool described them. */
    survivors: string[]
    archViolations: Measured
    /** Named rule violations, worst first, so a count is never the whole story. */
    findings: string[]
  }
  evidence: EvidenceItem[]
}

export type VerifyStatus = 'running' | 'pass' | 'fail' | 'inconclusive'

/**
 * One verification pass over the working tree: which suites ran, what they
 * measured, and the session it ran in (so every figure traces back to the output
 * that produced it — FR-046/FR-051).
 */
export interface VerifyRun {
  id: string
  projectId: string
  stackId: string
  sessionId: string | null
  branch: string | null
  /** Suite ids the run was asked to cover, so "not run" can be told from "not asked". */
  requested: string[]
  status: VerifyStatus
  report: VerifyReport | null
  /** Why an inconclusive run proved nothing, in one line (FR-047). */
  note: string | null
  startedAt: string
  finishedAt: string | null
}

/**
 * A run's verdict comes from its test results alone: a missed coverage or
 * quality threshold is reported, but never turns a passing run into a failing
 * one (FR-071). A run where nothing actually executed is INCONCLUSIVE, never a
 * pass (FR-047).
 */
export function verifyVerdict(report: VerifyReport): Exclude<VerifyStatus, 'running'> {
  const executed = report.suites.filter((s) => s.status === 'pass' || s.status === 'fail')
  if (executed.some((s) => s.status === 'fail')) return 'fail'
  return executed.length > 0 ? 'pass' : 'inconclusive'
}

/** The empty report a run starts from, so every panel can render before results. */
export function emptyVerifyReport(): VerifyReport {
  const unmeasured = (): Measured => ({ value: null, source: null })
  return {
    suites: [],
    coverage: { line: unmeasured(), changed: unmeasured(), files: [] },
    quality: {
      gate: null,
      gateSource: null,
      duplication: unmeasured(),
      debt: null,
      mutation: unmeasured(),
      survivors: [],
      archViolations: unmeasured(),
      findings: [],
    },
    evidence: [],
  }
}

export interface QueuedTask {
  id: string
  projectId: string
  text: string
  position: number
  createdAt: string
}

// --- Spec Kit (github/spec-kit) per-project specs ---

export type SpecStatus = 'draft' | 'ready' | 'in_progress' | 'complete'

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

/**
 * Spec Kit stage commands (the Commands part tab). `label` is the design's
 * display form (/speckit.clarify); `command` is the real installed skill the
 * session receives (/speckit-clarify).
 */
export interface SpecKitCommand {
  command: string // e.g. "speckit-clarify"
  label: string
  hint: string
}

export const SPEC_KIT_COMMANDS: readonly SpecKitCommand[] = [
  { command: 'speckit-clarify', label: '/speckit.clarify', hint: 'Scan the spec for ambiguity and ask up to 5 new clarification questions' },
  { command: 'speckit-plan', label: '/speckit.plan', hint: 'Regenerate plan.md from the current spec and answers' },
  { command: 'speckit-tasks', label: '/speckit.tasks', hint: 'Rebuild tasks.md from the plan, phase by phase' },
  { command: 'speckit-analyze', label: '/speckit.analyze', hint: 'Cross-check spec, plan, and tasks for drift or contradictions' },
  { command: 'speckit-implement', label: '/speckit.implement', hint: 'Execute every remaining task in tasks.md' },
  { command: 'speckit-checklist', label: '/speckit.checklist', hint: 'Generate a review checklist for the finished work' },
]

/**
 * Curated code-review / cleanup commands for the Cleanup section, sourced from
 * the Ponytail and Dotnet Claude Kit plugins. `command` is the dash-form slash
 * command the session receives (the section sends `/${command}`); availability
 * depends on the project having the relevant plugin installed.
 */
export interface CleanupCommand {
  command: string
  label: string
  hint: string
}

export interface CleanupGroup {
  /** Plugin slug, shown as the group name (design: "dotnet-claude-kit"). */
  source: string
  /** Short tag line shown after the name. */
  tag: string
  blurb: string
  /** `/plugin marketplace add …` — adds the plugin's marketplace to the project. */
  marketplace: string
  /** `/plugin install …` — installs the plugin. */
  pkg: string
  commands: readonly CleanupCommand[]
}

export const CLEANUP_GROUPS: readonly CleanupGroup[] = [
  {
    source: 'dotnet-claude-kit',
    tag: 'Roslyn-powered · .NET review & quality',
    blurb: 'Multi-dimensional review, health grading, and systematic cleanup for .NET projects.',
    marketplace: '/plugin marketplace add codewithmukesh/dotnet-claude-kit',
    pkg: '/plugin install dotnet-claude-kit',
    commands: [
      { command: 'code-review', label: '/code-review', hint: 'Blast-radius-prioritized code review' },
      { command: 'de-sloppify', label: '/de-sloppify', hint: 'Format, remove dead code, fix analyzers, seal types' },
      { command: 'security-scan', label: '/security-scan', hint: 'OWASP, secrets, and CVE auditing' },
      { command: 'verify', label: '/verify', hint: 'Build, analyzers, tests, and security in one pass' },
      { command: 'health-check', label: '/health-check', hint: 'Letter-grade project assessment (A–F)' },
      { command: 'outdated', label: '/outdated', hint: 'Dependency health: CVEs and licensing traps' },
      { command: 'arch-check', label: '/arch-check', hint: 'Architecture conformance validation' },
    ],
  },
  {
    source: 'ponytail',
    tag: 'the laziest senior dev · kill over-engineering',
    blurb: 'Find and delete code that never needed to exist — the best code is the code you never wrote.',
    marketplace: '/plugin marketplace add DietrichGebert/ponytail',
    pkg: '/plugin install ponytail@ponytail',
    commands: [
      { command: 'ponytail-review', label: '/ponytail-review', hint: 'Review the current diff for over-engineering' },
      { command: 'ponytail-audit', label: '/ponytail-audit', hint: 'Audit the whole repo, not just the diff' },
      { command: 'ponytail-debt', label: '/ponytail-debt', hint: 'Collect deferred ponytail: shortcuts into a ledger' },
    ],
  },
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
  /** Sections parsed from plan.md (## headings); absent when plan.md is missing. */
  plan?: SpecSection[]
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

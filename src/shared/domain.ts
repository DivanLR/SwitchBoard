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

/**
 * Which engine a developer's rule override belongs to (the `kind` column of
 * rule_prefs). Here rather than in the main process because it travels in a
 * request: the editor names the rule it is changing.
 */
export type RuleKind = 'risk' | 'swallow'

export type PermissionRequestType = 'tool_permission' | 'plan_approval'

export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'rule_approved'

export type DecisionOutcome = Exclude<PermissionRequestStatus, 'pending'>

/**
 * How a session decides what it may do, chosen per project and used every time
 * that project starts one.
 *
 * One value rather than the pair of booleans (`bypassPermissions`, `planMode`)
 * this replaces, because the SDK takes exactly one `permissionMode` and two
 * booleans could describe a state it has no way to spawn in. The names are this
 * app's own, and `resolvePermissionMode` in `src/main/sessions/session.ts` maps
 * them onto the SDK's enum; the only one that differs is `bypass`, which the SDK
 * spells `bypassPermissions`.
 */
export type SessionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass'

/**
 * The mode a project takes when nothing else says otherwise, and the value the
 * 022 migration backfilled onto every project that existed before the choice
 * did. It is `auto` rather than `default` because `auto` is what every session
 * in this app already ran as, so the migration changed no behaviour.
 */
export const DEFAULT_SESSION_MODE: SessionMode = 'auto'

/**
 * The five modes in escalation order, with the copy the pickers render. Shared
 * rather than per-component because two surfaces choose a mode (the new-session
 * dialogue and the per-project setting) and a mode explained two different ways
 * is a mode the developer has to learn twice.
 */
export const SESSION_MODES: readonly {
  value: SessionMode
  label: string
  detail: string
}[] = [
  {
    value: 'default',
    label: 'Default',
    detail: 'Every tool call waits for you in the inbox.',
  },
  {
    value: 'auto',
    label: 'Auto',
    detail: "Claude Code's own classifier decides, and only what it will not judge reaches you.",
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    detail: 'File edits go through without asking. Commands and deletes still come to you.',
  },
  {
    value: 'plan',
    label: 'Plan first',
    detail: 'Reads and researches without changing anything, then sends a plan to your inbox.',
  },
  {
    value: 'bypass',
    label: 'Bypass',
    detail: 'Nothing asks for approval. Runs inside a disposable Docker container.',
  },
]

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
  /**
   * The mode this project's sessions start in, chosen when the project is added
   * and changeable afterwards. Always present: the 022 migration added the column
   * NOT NULL with a DEFAULT, so there is no such thing as a project without one
   * and no caller needs a fallback.
   */
  defaultSessionMode: SessionMode
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
  /**
   * Asked to START in plan mode: read-only until a plan is approved. Persisted
   * for one reason only — the restart toggle pre-fills from it — and it records
   * how the session began, never where it is now. Plan mode can be switched at
   * runtime, so a column claiming to hold the current mode would go stale the
   * first time a toggle did not reach it, and a stale persisted value is worse
   * than none because the sidebar and the next launch would believe it.
   */
  planMode?: boolean
  /**
   * In plan mode RIGHT NOW (in-memory only): the session may read but not act,
   * until it proposes a plan and the developer approves it in the inbox.
   */
  inPlanMode?: boolean
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
  /**
   * The developer took this queued message back before it was delivered.
   *
   * The row stays rather than disappearing, because events are append-only: what
   * was typed is part of the record even when it was never sent. The stream
   * renders it as withdrawn so it cannot be mistaken for something the session saw.
   */
  withdrawn?: boolean
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

/**
 * The subagent an event was produced inside, or undefined for a main-loop event.
 *
 * Shared because both the session view (which hides agent-tagged events from the
 * main stream) and the MCP view (which shows only main-loop events) need the same
 * answer. The `in` check narrows the payload union to the kinds that actually
 * carry `agentId`, so no kind is asked for a field it does not have.
 */
export function agentIdOf(event: SessionEvent): string | undefined {
  const payload: EventPayloadMap[EventKind] = event.payload
  return 'agentId' in payload ? payload.agentId : undefined
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
  /** Ordered; first match wins. */
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
   * Heavy subagent mode: instructs every hosted session to decompose work and
   * fan it out across as many subagents as the task graph allows, rather than
   * doing it in one thread. Faster wall-clock on anything parallel, and cheaper
   * when the workers run the cheap model; it costs more total tokens than one
   * thread would, which is the trade being made deliberately.
   */
  heavySubagents: boolean
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
  /**
   * Per-project overrides for a suite's command, keyed by project id and then by
   * suite id.
   *
   * The catalogue's command is a good guess about a conventional layout, and a
   * guess is all it can be: a monorepo where `npm test` at the root reaches
   * nothing, or a solution needing `--project`, had no way to correct it short of
   * editing this application's own source. An absent entry means the catalogue's
   * own command, and clearing the field deletes the entry rather than storing an
   * empty string.
   */
  projectSuiteCommands: Record<string, Record<string, string>>
  /** Base URL an API eval set calls for a project, e.g. http://localhost:5057.
   *  Absent means it is read from the project's launchSettings.json instead. */
  projectApiBase: Record<string, string>
  /** Command that starts the project's API, when the app has to launch it.
   *  Absent means `dotnet run --project <the project holding launchSettings>`. */
  projectApiStart: Record<string, string>
  /**
   * A deployed environment the same eval set can be run against — the QA URL for
   * an API that already exists somewhere.
   *
   * Separate from `projectApiBase` rather than replacing it, because the two are
   * used differently and confusing them is what makes a run dangerous: a local
   * run may be launched by the app and may write, whereas this one is a shared
   * environment nobody asked us to restart. Absent means the project has no QA
   * target and the choice is not offered.
   */
  projectApiQa: Record<string, string>
  /**
   * Headers every call to that environment carries, as `Name: value` lines —
   * usually the API key a deployed environment requires and a local one does not.
   *
   * A value may reference an environment variable as `${NAME}`, which is resolved
   * when the call is made. That is the supported way to supply a key: the app
   * stores the reference, never the secret, so the credential stays in the
   * developer's own environment and never lands in this database or in a report.
   */
  projectApiQaHeaders: Record<string, string>
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
  /**
   * Memory cap for each bypass sandbox container (docker --memory): any Docker
   * size ("6g", "12g"), or "0" for no cap. The SWITCHBOARD_SANDBOX_MEMORY env
   * var still overrides it — see sandboxMemoryArg for why both exist.
   */
  sandboxMemory: string
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
  // Off by default: fan-out is the right default for big work and the wrong one
  // for a one-line fix, and the user is the one who knows which this is.
  heavySubagents: false,
  summaries: true,
  fontSize: 'md',
  // Clean view is narrative + approvals by default; tool rows live in Raw.
  showToolRows: false,
  timestamps: false,
  autoscroll: true,
  projectModels: {},
  projectWorkerModels: {},
  projectTestStacks: {},
  projectSuiteCommands: {},
  projectApiBase: {},
  projectApiStart: {},
  projectApiQa: {},
  projectApiQaHeaders: {},
  autoApproveLow: false,
  autoApproveMedium: false,
  projectGroups: [],
  projectGroupOf: {},
  disabledCommands: {},
  databaseMcpServers: [],
  mcpActiveServers: [],
  sandboxMemory: '6g',
}

/**
 * A saved session transcript: the temp-file export of one session's prompt and
 * reply spine, plus the digest a following session can be seeded with.
 *
 * Written continuously while a session runs, so a crash leaves one behind, and
 * expires 12 hours after its last write.
 */
export interface TranscriptSummary {
  sessionId: string
  projectId: string
  projectName: string
  /** ISO of the last write. */
  savedAt: string
  /** ISO of savedAt + 12h; the sweep deletes the file after this. */
  expiresAt: string
  /** Absolute path to the markdown file in the OS temp directory. */
  path: string
  prompts: number
  replies: number
  lastPrompt: string | null
  /** The facts block a new session is given inline when this is carried over. */
  digest: string
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
  /**
   * True when the app parsed this figure out of the runner's own artefact file
   * itself, rather than taking the session's word for it.
   *
   * The distinction is the point. A machine-readable line from a session is a
   * guarantee about shape, never about truth, so a figure the app read out of a
   * TRX, Cobertura or Stryker report is different evidence from the same number
   * typed into a report line. Absent means session-reported, which is still shown
   * — just not as something the app checked.
   */
  verified?: boolean
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
  /** True when a test-runner artefact, not the session's summary, settled this. */
  verified?: boolean
}

/** Proof the code was executed — real input and the real result (FR-048). */
/**
 * One real HTTP call made against a running API, with the real data it used.
 *
 * This is the difference between "the integration suite passed" and knowing what
 * the API actually answered. An endpoint result is only ever written from a call
 * that was genuinely made: `status` null means the call did not complete, never
 * that it was assumed to work.
 *
 * `dataSource` and `dataQuery` record where the identifiers came from. When a
 * database MCP server supplied them, the row that made the call meaningful is
 * named, so a passing endpoint can be told apart from one that returned 200 with
 * an empty body because it was called with an id that does not exist.
 */
export interface EndpointResult {
  method: string
  /** The path called, with real values substituted, e.g. /api/customers/4417. */
  path: string
  /** HTTP status actually received, or null when the call never completed. */
  status: number | null
  /** Round-trip time in milliseconds, when measured. */
  ms: number | null
  /** Response body, truncated by the session to something readable. */
  response: string | null
  /** The MCP server that supplied the real data, e.g. "oracle-sqlcl". */
  dataSource: string | null
  /** The query run to obtain the identifiers, verbatim. */
  dataQuery: string | null
  /** What the data proved, e.g. "customer 4417 has 3 contracts; response listed 3". */
  dataAssertion: string | null
  /** 'pass' only when the response was checked against the real data and matched. */
  outcome: 'pass' | 'fail' | 'not_run'
  /** Why it failed, or what could not be checked. */
  detail: string | null
}

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
  /**
   * Real HTTP calls made against the running API, with the real data behind them.
   * Empty when no API or HTTP suite ran, which is stated rather than implied: an
   * empty list never means "the endpoints are fine".
   */
  endpoints: EndpointResult[]
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
 *
 * A failed real endpoint call counts as a test result, and fails the run. FR-071
 * exists to stop a *measurement about* the code (coverage, duplication, mutation
 * score) from flipping a verdict; an HTTP call against the running API is not a
 * measurement, it is an execution, and the most direct one the run performs. The
 * whole point of exercising real endpoints is that a suite can go green against
 * fixtures while every real request fails — so a verdict blind to those calls
 * would report the green suite and hide the thing that was actually broken.
 */
export function verifyVerdict(report: VerifyReport): Exclude<VerifyStatus, 'running'> {
  const executed = report.suites.filter((s) => s.status === 'pass' || s.status === 'fail')
  const calls = report.endpoints.filter((e) => e.outcome === 'pass' || e.outcome === 'fail')
  if (executed.some((s) => s.status === 'fail') || calls.some((e) => e.outcome === 'fail')) return 'fail'
  // A run that only made endpoint calls still proved something; one where nothing
  // executed at all proved nothing, whatever it reported.
  return executed.length > 0 || calls.length > 0 ? 'pass' : 'inconclusive'
}

/**
 * How long this run is likely to take, learned from the runs before it.
 *
 * The app measures nothing else it does not measure, so the shape of this matters:
 * it is an ESTIMATE, labelled as one, and it says what it is made of. `basis` is
 * the sentence the panel shows, so the developer can weigh it — four past runs of
 * the same suites is worth trusting; one run of a different selection is worth
 * knowing about and not much more. No history at all returns null, and the panel
 * says nothing rather than inventing a first guess.
 *
 * The median, not the mean: the distribution is skewed by the occasional run that
 * sat waiting on a permission prompt, and one twenty-minute outlier must not move
 * the number a developer plans their next ten minutes around.
 *
 * `sameWork` marks the past runs that covered the same work as the one being
 * estimated. Those are preferred, and the rest are only used when there are too
 * few of them — a mutation run and a unit run are not the same question, but
 * "roughly a couple of minutes" from any past run beats no answer.
 */
export interface RunEstimate {
  /** Milliseconds, median of the runs the estimate was drawn from. */
  ms: number
  /** How the figure was arrived at, in the developer's words. */
  basis: string
  /** True when every run behind it covered the same work. */
  comparable: boolean
}

export function estimateRunMs(
  runs: readonly { startedAt: string; finishedAt: string | null }[],
  sameWork?: (run: { startedAt: string; finishedAt: string | null }) => boolean,
): RunEstimate | null {
  const durations = (
    candidates: readonly { startedAt: string; finishedAt: string | null }[],
  ): number[] =>
    candidates
      .map((run) => {
        if (!run.finishedAt) return null
        const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
        // A negative or absurd span is a clock change or a corrupted row, not a
        // duration, and averaging it in would poison every later estimate.
        return Number.isFinite(ms) && ms > 0 && ms < 6 * 60 * 60 * 1000 ? ms : null
      })
      .filter((ms): ms is number => ms !== null)

  const all = durations(runs)
  const matching = sameWork ? durations(runs.filter(sameWork)) : all
  // Same work if there is any, everything otherwise. One matching run is a weaker
  // basis than four, which is exactly what `basis` says out loud rather than the
  // function quietly choosing for the developer.
  const chosen = matching.length > 0 ? matching : all
  if (chosen.length === 0) return null
  const comparable = sameWork !== undefined && matching.length > 0
  const ms = median(chosen)
  const many = chosen.length > 1
  return {
    ms,
    basis: comparable
      ? `median of ${chosen.length} past ${many ? 'runs' : 'run'} of the same suites`
      : sameWork
        ? `median of ${chosen.length} past ${many ? 'runs' : 'run'}, which covered different suites`
        : `median of ${chosen.length} past ${many ? 'runs' : 'run'}`,
    comparable,
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** A duration as a developer says it: "40s", "2m 30s", "1h 5m". */
export function humanDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
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
    endpoints: [],
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

// Spec Kit stage commands and the cleanup/review plugin catalogue live in
// command-catalog.ts: they are display copy, not persisted shapes.

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

// --- Diff tab (working-tree changes) ---

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

/** One changed file in the project's working tree, tracked or not. */
export interface DiffFileEntry {
  /** Project-relative, forward-slash separated. */
  path: string
  status: DiffFileStatus
  /** Null when counts are unavailable (binary content). */
  addedLines: number | null
  removedLines: number | null
  binary: boolean
}

/** Response for `diff.list`: the change list plus whether it could be read at
 *  all — `gitNotice` travels inline rather than as a separate error, the same
 *  way it already does on `ProjectListItem`. */
export interface DiffListResult {
  /** Non-null means the working tree could not be read; `files` is not meaningful. */
  gitNotice: string | null
  files: DiffFileEntry[]
}

export interface DiffLine {
  type: 'context' | 'add' | 'del'
  text: string
}

/** Response for `diff.file`. `binary: true` carries no lines — the view
 *  states no text diff is available instead of rendering one. */
export interface FileDiffContent {
  binary: boolean
  lines: DiffLine[]
}

import type { DiagramPlan } from './diagram'

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
  | 'injection'

export type RiskLevel = 'low' | 'medium' | 'high'

export type RuleKind = 'risk' | 'swallow'

type PermissionRequestType = 'tool_permission' | 'plan_approval'

export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'rule_approved'

export type DecisionOutcome = Exclude<PermissionRequestStatus, 'pending'>

export type SessionMode = 'default' | 'dontAsk' | 'auto' | 'acceptEdits' | 'plan' | 'bypass'

export const DEFAULT_SESSION_MODE: SessionMode = 'auto'

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
    value: 'dontAsk',
    label: "Don't ask",
    detail:
      'Nothing ever interrupts you. Anything not already approved is refused rather than asked.',
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
    detail: 'Nothing asks for approval. Runs inside a disposable WSL container.',
  },
]

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
  refs: ProjectRef[]
  defaultSessionMode: SessionMode
  useContainers: boolean
}

export interface CustomSkill {
  name: string
  description: string
  sourceUrl: string
  sourcePath: string
  enabled: boolean
  fileCount: number
  importedAt: string
}

export interface SkillImportResult {
  imported: CustomSkill[]
  skipped: { name: string; reason: string }[]
}

export interface McpServer {
  name: string
  status: string
}

export interface Session {
  id: string
  projectId: string
  sdkSessionId: string | null
  status: SessionStatus
  statusDetail: string | null
  branch: string | null
  diffAdds: number | null
  diffDels: number | null
  usageUtilization: number | null
  usageResetsAt: number | null
  usageLimitType: string | null
  startedAt: string
  endedAt: string | null
  endReason: SessionEndReason | null
  name?: string | null
  derivedName?: string | null
  label?: string | null
  sectionKind?: SectionKind | null
  bypassPermissions?: boolean
  planMode?: boolean
  inPlanMode?: boolean
  heavySubagents?: boolean
  mcpServers?: McpServer[]
  currentModel?: string | null
  currentMode?: 'advisor' | 'orchestrator' | null
  backgroundTasks?: { taskId: string; description: string }[]
  modelTotals?: Record<string, { tokens: number; costUsd: number }>
}

interface AgentScopedPayload {
  agentId?: string
}

export interface PromptPayload extends AgentScopedPayload {
  text: string
  pending?: boolean
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
  toolUseId?: string
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

interface RawOutputPayload extends AgentScopedPayload {
  text: string
}

type InjectionSource = 'system_reminder' | 'command' | 'hook' | 'system' | 'context'

export interface InjectionPayload extends AgentScopedPayload {
  text: string
  source: InjectionSource
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
  injection: InjectionPayload
}

export interface SessionEvent<K extends EventKind = EventKind> {
  id: string
  sessionId: string
  seq: number
  kind: K
  payload: EventPayloadMap[K]
  noiseKind: string | null
  createdAt: string
}

export function agentIdOf(event: SessionEvent): string | undefined {
  const payload: EventPayloadMap[EventKind] = event.payload
  return 'agentId' in payload ? payload.agentId : undefined
}

export const SWALLOWABLE_KINDS: readonly EventKind[] = [
  'tool_activity',
  'raw_output',
  'assistant_text',
  'injection',
]

export function classifyInjection(text: string): InjectionSource {
  if (/<system-reminder>/i.test(text)) return 'system_reminder'
  if (/<command-name>|<command-message>|<command-args>/i.test(text)) return 'command'
  if (/<(?:user-prompt-submit-)?hook[-_ ]?(?:output|feedback)>|hook success|hook blocked/i.test(text))
    return 'hook'
  return 'context'
}

export interface PermissionRequest {
  id: string
  sessionId: string
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
  deliveryFailed: boolean
}

export interface DecisionRecord extends Omit<PermissionRequest, 'status' | 'resolvedAt'> {
  status: DecisionOutcome
  resolvedAt: string
}

type PermissionRuleMatcherKind = 'command_prefix' | 'path_glob' | 'tool_only'

export interface PermissionRuleMatcher {
  kind: PermissionRuleMatcherKind
  value?: string
}

export interface PermissionRule {
  id: string
  projectId: string
  toolName: string
  matcher: PermissionRuleMatcher
  createdFromRequestId: string
  createdAt: string
  revokedAt: string | null
}

const DANGEROUS_COMMAND =
  /\b(rm|rmdir|del|rd|mkfs|dd|sudo|doas)\b|\bformat\s+[a-z]:|Remove-Item|git\s+(push|reset\s+--hard|clean)\b/i

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command)
}

export interface RiskInputMatcher {
  field: string
  pattern: string
}

export interface RiskClassificationRule {
  id: string
  scope: 'global'
  position: number
  toolMatcher: string
  inputMatcher: RiskInputMatcher | null
  risk: RiskLevel
  builtin: boolean
}

export interface SwallowRule {
  id: string
  position: number
  eventKindMatcher: string
  pattern: string
  noiseKind: string
  enabled: boolean
}

export interface ProjectGroup {
  id: string
  name: string
  collapsed: boolean
  color?: string
}

export interface ModelChoice {
  id: string
  label: string
  desc: string
  price: string
}

export interface AvailableModel {
  id: string
  label: string
  description: string
}

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const

export function modelFamily(id: string | undefined): string | null {
  if (!id) return null
  const lower = id.toLowerCase()
  return FAMILIES.find((family) => lower.includes(family)) ?? null
}

export function modelLabel(id: string): string {
  if (!id || id === 'default') return 'Account default'
  const oneMillion = /\[1m\]/i.test(id)
  const base = id
    .replace(/\[1m\]/i, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') 
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

export function modelPrice(id: string): string {
  return FAMILY_PRICE[modelFamily(id) ?? ''] ?? '—'
}

export type ModelMode = 'auto' | 'advisor' | 'orchestrator' | 'basic'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function subagentsAllowed(effort: EffortLevel): boolean {
  return effort === 'max'
}

export interface Settings {
  defaultView: 'clean' | 'raw'
  notificationsEnabled: boolean
  intelligentModel: string
  workerModel: string
  autoModelRouting: boolean
  modelMode: ModelMode
  effort: EffortLevel
  subagentEffort: EffortLevel
  summaries: boolean
  fontSize: 'sm' | 'md' | 'lg'
  showToolRows: boolean
  showInjections: boolean
  timestamps: boolean
  autoscroll: boolean
  showSessionTimer: boolean
  projectTestStacks: Record<string, string>
  projectSuiteCommands: Record<string, Record<string, string>>
  projectTestSelection: Record<string, string[]>
  projectIsolatedRuns: Record<string, boolean>
  projectAcceptedGates: Record<string, string[]>
  autoApproveLow: boolean
  autoApproveMedium: boolean
  projectGroups: ProjectGroup[]
  projectGroupOf: Record<string, string>
  disabledCommands: Record<string, string[]>
  databaseMcpServers: string[]
  diagramEngine: 'diagram-design' | 'archify'
  mcpActiveServers: string[]
  sandboxMemory: string
  flowConcurrency: number
  flowWorktreeRoot: string
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'clean',
  notificationsEnabled: true,
  intelligentModel: 'claude-opus-5',
  workerModel: 'claude-sonnet-5',
  autoModelRouting: true,
  modelMode: 'auto',
  effort: 'xhigh',
  subagentEffort: 'low',
  summaries: true,
  fontSize: 'md',
  showToolRows: false,
  showInjections: false,
  timestamps: false,
  autoscroll: true,
  showSessionTimer: true,
  projectTestStacks: {},
  projectSuiteCommands: {},
  projectTestSelection: {},
  projectIsolatedRuns: {},
  projectAcceptedGates: {},
  autoApproveLow: false,
  autoApproveMedium: false,
  projectGroups: [],
  projectGroupOf: {},
  disabledCommands: {},
  databaseMcpServers: [],
  mcpActiveServers: [],
  sandboxMemory: '6g',
  flowConcurrency: 4,
  flowWorktreeRoot: '',
  diagramEngine: 'diagram-design',
}

export interface TranscriptSummary {
  sessionId: string
  projectId: string
  projectName: string
  savedAt: string
  expiresAt: string
  path: string
  prompts: number
  replies: number
  lastPrompt: string | null
  digest: string
}

export interface ProjectCommand {
  name: string
  description?: string
}

export interface Draft {
  id: string
  projectId: string
  text: string
  createdAt: string
}

export interface Measured {
  value: number | null
  source: string | null
  verified?: boolean
}

export type SuiteStatus = 'pass' | 'fail' | 'skipped' | 'unavailable' | 'not_run'

export interface SuiteResult {
  id: string
  label: string
  status: SuiteStatus
  detail: string
  verified?: boolean
}

export interface EndpointResult {
  method: string
  path: string
  status: number | null
  ms: number | null
  response: string | null
  dataSource: string | null
  dataQuery: string | null
  dataAssertion: string | null
  outcome: 'pass' | 'fail' | 'not_run'
  detail: string | null
}

export interface EvidenceItem {
  kind: 'run' | 'screenshot'
  what: string
  result: string
  path: string | null
}

export interface VerifyReport {
  suites: SuiteResult[]
  coverage: {
    line: Measured
    changed: Measured
    files: { path: string; pct: number }[]
  }
  quality: {
    gate: 'pass' | 'fail' | 'not_configured' | null
    gateSource: string | null
    duplication: Measured
    debt: string | null
    mutation: Measured
    mutationKilled: number | null
    mutationSurvived: number | null
    survivors: string[]
    archViolations: Measured
    findings: string[]
  }
  evidence: EvidenceItem[]
  endpoints: EndpointResult[]
}

type VerifyStatus = 'running' | 'pass' | 'fail' | 'inconclusive'

export interface VerifyRun {
  id: string
  projectId: string
  stackId: string
  sessionId: string | null
  branch: string | null
  requested: string[]
  status: VerifyStatus
  report: VerifyReport | null
  note: string | null
  startedAt: string
  finishedAt: string | null
}

export function verifyVerdict(report: VerifyReport): Exclude<VerifyStatus, 'running'> {
  const executed = report.suites.filter((s) => s.status === 'pass' || s.status === 'fail')
  const calls = report.endpoints.filter((e) => e.outcome === 'pass' || e.outcome === 'fail')
  if (executed.some((s) => s.status === 'fail') || calls.some((e) => e.outcome === 'fail')) return 'fail'
  return executed.length > 0 || calls.length > 0 ? 'pass' : 'inconclusive'
}

export type FlowRunStatus =
  | 'scoping'
  | 'crosscheck'
  | 'awaiting_approval'
  | 'publishing'
  | 'publish_interrupted'
  | 'ready'
  | 'implementing'
  | 'learning'
  | 'done'
  | 'failed'
  | 'cancelled'

export type FlowItemStatus =
  | 'proposed'
  | 'published'
  | 'queued'
  | 'preparing'
  | 'implementing'
  | 'tech_review'
  | 'revising'
  | 'raising_pr'
  | 'pr_interrupted'
  | 'pr_open'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export type FlowEstimate = 's' | 'm' | 'l'

export interface FlowFeature {
  id: string
  title: string
  state: string | null
  url: string | null
}

export interface ScopedItem {
  localId: string
  title: string
  body: string
  acceptance: string[]
  estimate: FlowEstimate
}

export interface FlowItem {
  id: string
  runId: string
  projectId: string
  position: number
  localId: string
  title: string
  body: string
  acceptance: string[]
  estimate: FlowEstimate
  workItemId: string | null
  workItemUrl: string | null
  branch: string | null
  worktreePath: string | null
  sessionId: string | null
  status: FlowItemStatus
  attempts: number
  prId: string | null
  prUrl: string | null
  note: string | null
  startedAt: string | null
  finishedAt: string | null
}

export type FlowLessonStatus = 'proposed' | 'accepted' | 'rejected'

export interface FlowLessonEvidence {
  prId: string | null
  author: string | null
  quote: string
}

export interface FlowLesson {
  id: string
  projectId: string
  runId: string | null
  ruleId: string
  rule: string
  section: string | null
  evidence: FlowLessonEvidence[]
  status: FlowLessonStatus
  reason: string | null
  createdAt: string
  decidedAt: string | null
}

export function flowRuleId(rule: string): string {
  const normalised = rule
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;:,]+$/, '')
  let hash = 5381
  for (let i = 0; i < normalised.length; i += 1) {
    hash = ((hash << 5) + hash + normalised.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

export interface FlowRun {
  id: string
  projectId: string
  featureId: string
  featureTitle: string
  status: FlowRunStatus
  sessionId: string | null
  risks: string[]
  outOfScope: string[]
  concurrency: number
  baseBranch: string | null
  worktreeRoot: string | null
  crosscheckRound: number
  concerns: string[]
  specSessionId: string | null
  note: string | null
  startedAt: string
  finishedAt: string | null
}

export function flowStage(
  status: FlowRunStatus,
): 'scoping' | 'crosscheck' | 'approve' | 'publishing' | 'ready' | 'learning' | 'closed' {
  if (status === 'scoping') return 'scoping'
  if (status === 'crosscheck') return 'crosscheck'
  if (status === 'learning') return 'learning'
  if (status === 'awaiting_approval') return 'approve'
  if (status === 'publishing' || status === 'publish_interrupted') return 'publishing'
  if (status === 'ready' || status === 'implementing') return 'ready'
  return 'closed'
}

interface RunEstimate {
  ms: number
  basis: string
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
        return Number.isFinite(ms) && ms > 0 && ms < 6 * 60 * 60 * 1000 ? ms : null
      })
      .filter((ms): ms is number => ms !== null)

  const all = durations(runs)
  const matching = sameWork ? durations(runs.filter(sameWork)) : all
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
      mutationKilled: null,
      mutationSurvived: null,
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

export type SpecStatus = 'draft' | 'ready' | 'in_progress' | 'complete'

export interface SpecSummary {
  id: string 
  title: string
  status: SpecStatus
  tasksTotal: number
  tasksDone: number
}

export interface SpecSection {
  title: string
  body: string
}

export interface ResolvedClarification {
  question: string
  answer: string
}

export interface SpecTask {
  id: string 
  label: string
  done: boolean
}

export interface SpecPhase {
  label: string
  tasks: SpecTask[]
}

export interface SpecDetail extends SpecSummary {
  description: string
  path: string
  sections: SpecSection[]
  plan?: SpecSection[]
  phases: SpecPhase[]
  clarifications: string[]
  resolvedClarifications: ResolvedClarification[]
}

export interface SpecKitState {
  installed: boolean 
  specs: SpecSummary[]
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface DiffFileEntry {
  path: string
  status: DiffFileStatus
  addedLines: number | null
  removedLines: number | null
  binary: boolean
}

export interface DiffListResult {
  gitNotice: string | null
  files: DiffFileEntry[]
}

export type SectionKind =
  | 'spec'
  | 'tests'
  | 'diff'
  | 'diagram'
  | 'flow'

export function sessionName(
  sessionId: string,
  work: {
    verifyRunSessionIds?: readonly string[]
    diagrams?: readonly { sessionId: string | null; description: string }[]
    kinds?: Readonly<Record<string, SectionKind>>
    suites?: Readonly<Record<string, string>>
  },
  branch?: string | null,
  endReason?: SessionEndReason | null,
): string | null {
  const diagram = work.diagrams?.find((d) => d.sessionId === sessionId)
  if (diagram) {
    const words = diagram.description.trim().split(/\s+/).slice(0, 6).join(' ')
    return words ? `Diagram: ${words}` : 'Diagram'
  }
  const done = endReason === 'completed'
  const on = done ? ' - Complete' : branch ? ` - ${branch}` : ''
  const kind = work.kinds?.[sessionId]
  const suite = work.suites?.[sessionId]
  if (kind && suite) return `${SECTION_LABELS[kind]}: ${suite}${done ? ' - Complete' : ''}`
  if (kind) return `${SECTION_LABELS[kind]}${on}`
  if (work.verifyRunSessionIds?.includes(sessionId)) return `Tests${on}`
  return null
}

const SECTION_LABELS: Record<SectionKind, string> = {
  spec: 'Specs',
  tests: 'Tests',
  diff: 'Diff',
  diagram: 'Diagram',
  flow: 'Flow',
}

export interface DiagramEntry {
  file: string
  path: string
  description: string | null
  sessionId: string | null
  plan: DiagramPlan | null
  modifiedAt: string
  bytes: number
}

interface DiffLine {
  type: 'context' | 'add' | 'del'
  text: string
}

export interface FileDiffContent {
  binary: boolean
  lines: DiffLine[]
}

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

export type SessionEngine = 'claude' | 'codex'

export const DEFAULT_SESSION_ENGINE: SessionEngine = 'claude'

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
  engine: SessionEngine
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
  engine?: SessionEngine
}

export function engineOf(model: AvailableModel): SessionEngine {
  return model.engine ?? 'claude'
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
  defaultEngine: SessionEngine
  codexModel: string
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
  projectApiBase: Record<string, string>
  projectApiStart: Record<string, string>
  projectApiQa: Record<string, string>
  projectApiQaHeaders: Record<string, string>
  autoApproveLow: boolean
  autoApproveMedium: boolean
  projectGroups: ProjectGroup[]
  projectGroupOf: Record<string, string>
  disabledCommands: Record<string, string[]>
  databaseMcpServers: string[]
  diagramEngine: 'diagram-design' | 'archify'
  favouriteSkills: string[]
  mcpActiveServers: string[]
  sandboxMemory: string
}

export interface McpScan {
  id: string
  projectId: string
  comboKey: string
  servers: string[]
  scannedAt: string
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'clean',
  notificationsEnabled: true,
  intelligentModel: 'claude-opus-5',
  workerModel: 'claude-sonnet-5',
  autoModelRouting: true,
  modelMode: 'auto',
  defaultEngine: DEFAULT_SESSION_ENGINE,
  codexModel: '',
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
  diagramEngine: 'diagram-design',
  favouriteSkills: [],
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

export type EvalCheckStatus = 'not_run' | 'pass' | 'fail' | 'inconclusive'
export type EvalVerdict = 'pending' | 'pass' | 'fail'

export interface EvalRun {
  id: string
  projectId: string
  acceptance: string
  checkCmd: string | null
  checkStatus: EvalCheckStatus
  verdict: EvalVerdict
  rating: number | null
  note: string | null
  attempts: number
  judge: string | null
  createdAt: string
}

export const EVAL_RELOOP_RATING = 3

type EvalStage = 'implement' | 'verify' | 'review' | 'done'

export function evalStage(run: Pick<EvalRun, 'checkStatus' | 'verdict' | 'judge'>): EvalStage {
  if (run.verdict !== 'pending') return 'done'
  if (run.judge) return 'review'
  if (run.checkStatus !== 'not_run') return 'verify'
  return 'implement'
}

export function canPassEval(run: Pick<EvalRun, 'checkCmd' | 'checkStatus'>): boolean {
  return !run.checkCmd || run.checkStatus === 'pass'
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

export type SectionKind = 'spec' | 'tests' | 'diff' | 'cleanup' | 'diagram' | 'skills'

export function sessionName(
  sessionId: string,
  work: {
    verifyRunSessionIds?: readonly string[]
    apiRunSessionIds?: readonly string[]
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
  if (work.apiRunSessionIds?.includes(sessionId)) return `API${on}`
  return null
}

const SECTION_LABELS: Record<SectionKind, string> = {
  spec: 'Specs',
  tests: 'Tests',
  diff: 'Diff',
  cleanup: 'Cleanup',
  diagram: 'Diagram',
  skills: 'Skills',
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

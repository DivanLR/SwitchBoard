import type {
  FlowBugResult,
  FlowDecision,
  FlowFeature,
  FlowReviewFinding,
  FlowReviewSeverity,
  FlowStage,
} from '@shared/domain'
import { FLOW_STAGE_LABELS } from '@shared/domain'
import { firstJsonObject, markerTail, str } from '@main/verify/parse'

export const FLOW_MARKER = 'SWB_FLOW'

export interface FlowFeaturesMarker {
  kind: 'features'
  features: FlowFeature[]
}

export interface FlowStageMarker {
  kind: 'stage'
  stage: FlowStage
  outcome: 'done' | 'blocked'
  summary: string
  why: string | null
  specDir: string | null
  tasksDone: number | null
  tasksTotal: number | null
  verdict: 'ready' | 'needs_fixes' | null
  findings: FlowReviewFinding[]
  unmet: string[]
  prUrl: string | null
  prId: string | null
  pullRequests: FlowPullRequestMarker[]
  converged: boolean | null
  result: FlowBugResult | null
  decision: FlowDecision | null
}

export interface FlowPullRequestMarker {
  repository: string
  prUrl: string | null
  prId: string | null
}

export type FlowMarker = FlowFeaturesMarker | FlowStageMarker

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return asArray(value)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== null)
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function features(value: unknown): FlowFeature[] {
  const found: FlowFeature[] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = idOf(record.id)
    const title = str(record.title)
    if (!id || !title) continue
    found.push({ id, title, state: str(record.state), url: str(record.url) })
  }
  return found
}

function idOf(value: unknown): string | null {
  return str(value) ?? (typeof value === 'number' ? String(value) : null)
}

function pullRequests(value: unknown): FlowPullRequestMarker[] {
  const found: FlowPullRequestMarker[] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const repository = str(record.repository)
    if (repository) found.push({ repository, prUrl: str(record.prUrl), prId: idOf(record.prId) })
  }
  return found
}

const SEVERITIES: ReadonlySet<string> = new Set(['must_fix', 'should_fix', 'nit'])

function findings(value: unknown): FlowReviewFinding[] {
  const found: FlowReviewFinding[] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const what = str(record.what)
    if (!what) continue
    const rawSeverity = str(record.severity)?.toLowerCase() ?? 'should_fix'
    const severity: FlowReviewSeverity = SEVERITIES.has(rawSeverity)
      ? (rawSeverity as FlowReviewSeverity)
      : 'should_fix'
    found.push({ severity, file: str(record.file), line: num(record.line), what })
  }
  return found
}

const STAGES: ReadonlySet<string> = new Set(Object.keys(FLOW_STAGE_LABELS))

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return value === 'true' ? true : value === 'false' ? false : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const text = str(value)?.toLowerCase()
  return allowed.find((entry) => entry === text) ?? null
}

export function parseFlowMarker(text: string): FlowMarker | null {
  const tail = markerTail(text, FLOW_MARKER)
  if (tail === null) return null
  const json = firstJsonObject(tail)
  if (!json) return null
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const kind = str(record.kind)
  if (kind === 'features') return { kind: 'features', features: features(record.features) }
  if (kind === 'stage') {
    const stage = str(record.stage)
    const outcome = str(record.outcome)
    if (!stage || !STAGES.has(stage) || (outcome !== 'done' && outcome !== 'blocked')) return null
    const rawVerdict = str(record.verdict)
    return {
      kind: 'stage',
      stage: stage as FlowStage,
      outcome,
      summary: str(record.summary) ?? '',
      why: str(record.why),
      specDir: str(record.specDir),
      tasksDone: num(record.tasksDone),
      tasksTotal: num(record.tasksTotal),
      verdict: rawVerdict === 'ready' || rawVerdict === 'needs_fixes' ? rawVerdict : null,
      findings: findings(record.findings),
      unmet: strings(record.unmet),
      prUrl: str(record.prUrl),
      prId: str(record.prId),
      pullRequests: pullRequests(record.pullRequests),
      converged: bool(record.converged),
      result: oneOf(record.result, ['verified', 'partial', 'failed'] as const),
      decision: oneOf(record.decision, ['go', 'needs-clarification', 'kill'] as const),
    }
  }
  return null
}

const PULL_REQUEST_HOSTS: ReadonlySet<string> = new Set(['github.com', 'dev.azure.com'])

export function allowedPullRequestUrl(raw: string | null, originHost: string | null): string | null {
  if (!raw || !URL.canParse(raw)) return null
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  const host = url.hostname.toLowerCase()
  const allowed = PULL_REQUEST_HOSTS.has(host) || host.endsWith('.visualstudio.com') || host === originHost
  return allowed ? url.href : null
}

export function flowMarkerBroken(text: string): boolean {
  return markerTail(text, FLOW_MARKER) !== null && parseFlowMarker(text) === null
}

import type { FlowEstimate, FlowFeature, ScopedItem } from '@shared/domain'
import { firstJsonObject, markerTail, str } from '@main/evals/parse'

export const FLOW_MARKER = 'SWB_FLOW'

export interface FlowFeaturesMarker {
  kind: 'features'
  features: FlowFeature[]
}

export interface FlowScopeMarker {
  kind: 'scope'
  items: ScopedItem[]
  risks: string[]
  outOfScope: string[]
}

export interface FlowPublishedMarker {
  kind: 'published'
  created: { localId: string; workItemId: string; url: string | null }[]
  failed: { localId: string; why: string }[]
}

export interface FlowItemMarker {
  kind: 'item'
  workItemId: string
  outcome: 'done' | 'blocked'
  summary: string
  why: string | null
}

export interface FlowPrMarker {
  kind: 'pr'
  workItemId: string
  prId: string
  url: string | null
  branch: string | null
}

export interface FlowSignoffMarker {
  kind: 'signoff'
  verdict: 'approve' | 'revise'
  concerns: string[]
  items: ScopedItem[] | null
}

export interface FlowLessonsMarker {
  kind: 'lessons'
  lessons: {
    rule: string
    section: string | null
    evidence: { prId: string | null; author: string | null; quote: string }[]
  }[]
  note: string | null
}

export type FlowMarker =
  | FlowFeaturesMarker
  | FlowScopeMarker
  | FlowPublishedMarker
  | FlowItemMarker
  | FlowPrMarker
  | FlowSignoffMarker
  | FlowLessonsMarker

const ESTIMATES: ReadonlySet<string> = new Set(['s', 'm', 'l'])

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return asArray(value)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== null)
}

function estimate(value: unknown): FlowEstimate {
  const raw = str(value)?.toLowerCase()
  return raw && ESTIMATES.has(raw) ? (raw as FlowEstimate) : 'm'
}

function features(value: unknown): FlowFeature[] {
  const found: FlowFeature[] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = str(record.id) ?? (typeof record.id === 'number' ? String(record.id) : null)
    const title = str(record.title)
    if (!id || !title) continue
    found.push({ id, title, state: str(record.state), url: str(record.url) })
  }
  return found
}

function items(value: unknown): ScopedItem[] {
  const found: ScopedItem[] = []
  for (const [index, entry] of asArray(value).entries()) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const title = str(record.title)
    if (!title) continue
    found.push({
      localId: str(record.localId) ?? `item-${index + 1}`,
      title,
      body: str(record.body) ?? '',
      acceptance: strings(record.acceptance),
      estimate: estimate(record.estimate),
    })
  }
  return found
}

function created(value: unknown): FlowPublishedMarker['created'] {
  const found: FlowPublishedMarker['created'] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const localId = str(record.localId)
    const workItemId =
      str(record.workItemId) ?? (typeof record.workItemId === 'number' ? String(record.workItemId) : null)
    if (!localId || !workItemId) continue
    found.push({ localId, workItemId, url: str(record.url) })
  }
  return found
}

function failed(value: unknown): FlowPublishedMarker['failed'] {
  const found: FlowPublishedMarker['failed'] = []
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const localId = str(record.localId)
    if (!localId) continue
    found.push({ localId, why: str(record.why) ?? 'no reason given' })
  }
  return found
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
  if (kind === 'scope') {
    const scoped = items(record.items)
    if (scoped.length === 0) return null
    return {
      kind: 'scope',
      items: scoped,
      risks: strings(record.risks),
      outOfScope: strings(record.outOfScope),
    }
  }
  if (kind === 'published') {
    return { kind: 'published', created: created(record.created), failed: failed(record.failed) }
  }
  if (kind === 'item') {
    const workItemId = str(record.workItemId)
    const outcome = str(record.outcome)
    if (!workItemId || (outcome !== 'done' && outcome !== 'blocked')) return null
    return {
      kind: 'item',
      workItemId,
      outcome,
      summary: str(record.summary) ?? '',
      why: str(record.why),
    }
  }
  if (kind === 'signoff') {
    const verdict = str(record.verdict)
    if (verdict !== 'approve' && verdict !== 'revise') return null
    const revised = items(record.items)
    return {
      kind: 'signoff',
      verdict,
      concerns: strings(record.concerns),
      items: revised.length > 0 ? revised : null,
    }
  }
  if (kind === 'lessons') {
    const lessons: FlowLessonsMarker['lessons'] = []
    for (const entry of asArray(record.lessons)) {
      if (typeof entry !== 'object' || entry === null) continue
      const lesson = entry as Record<string, unknown>
      const rule = str(lesson.rule)
      if (!rule) continue
      const evidence: FlowLessonsMarker['lessons'][number]['evidence'] = []
      for (const cited of asArray(lesson.evidence)) {
        if (typeof cited !== 'object' || cited === null) continue
        const record2 = cited as Record<string, unknown>
        const quote = str(record2.quote)
        if (!quote) continue
        evidence.push({ prId: str(record2.prId), author: str(record2.author), quote })
      }
      // A rule with nothing behind it is a claim, not a lesson, so it is dropped.
      if (evidence.length === 0) continue
      lessons.push({ rule, section: str(lesson.section), evidence })
    }
    return { kind: 'lessons', lessons, note: str(record.note) }
  }
  if (kind === 'pr') {
    const workItemId = str(record.workItemId)
    const prId = str(record.prId)
    if (!workItemId || !prId) return null
    return { kind: 'pr', workItemId, prId, url: str(record.url), branch: str(record.branch) }
  }
  return null
}

export function flowMarkerBroken(text: string): boolean {
  return markerTail(text, FLOW_MARKER) !== null && parseFlowMarker(text) === null
}

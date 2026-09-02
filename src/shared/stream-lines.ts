// Raw view formatting (FR-018): one session event rendered as the mono lines a
// terminal would have shown. Pure and Vue-free, so the mapping from every event
// kind to its prefix is testable on its own — it is the one place the raw view's
// promise of "100% of the output" is actually kept.
//
// In shared/ rather than renderer/ for the same reason markdown.ts is: the node
// tsconfig and Vitest can reach it without pulling in the Vue-dependent renderer.
import type { ResultPayload, SessionEvent } from './domain'

/**
 * What a finished turn cost, as one line: `turn complete · 1.2s · $0.42 · 140 tok`.
 *
 * Shared rather than defined in the view that renders it, because BOTH views
 * state this and they must not be able to disagree. The raw view used to print
 * the bare string `✓ turn complete` and throw the figures away, so the one place
 * a developer would look for what a turn actually cost was the only place that
 * did not say. Every part is conditional: a turn with no cost recorded says
 * nothing about cost rather than claiming `$0.00`.
 */
export function resultLabel(payload: ResultPayload): string {
  const parts: string[] = ['turn complete']
  if (payload.durationMs > 0) parts.push(`${(payload.durationMs / 1000).toFixed(1)}s`)
  if (payload.totalCostUsd > 0) parts.push(`$${payload.totalCostUsd.toFixed(2)}`)
  // Every field read defensively, `usage` included. As a view-only helper this
  // only ever saw a complete payload from the SDK; the raw view calls it on
  // whatever is in the event log, and its own contract is that no event renders
  // as nothing whatever its shape. A stored row from an older schema, or a
  // truncated one, must degrade to `turn complete` rather than throw and take
  // the whole transcript down with it.
  const tokens = (payload.usage?.inputTokens ?? 0) + (payload.usage?.outputTokens ?? 0)
  if (tokens > 0) parts.push(`${tokens} tok`)
  return parts.join(' · ')
}

/**
 * The raw lines for one event.
 *
 * The payload is the EventPayloadMap union; this formatter reads a fixed set of
 * optional string fields across kinds, so it is typed as exactly that rather
 * than an untyped cast. A kind with nothing special to say falls through to its
 * text, which is why an unrecognised kind still appears rather than vanishing.
 */
export function rawLinesOf(event: SessionEvent): string[] {
  const p = event.payload as Partial<{
    text: string
    toolName: string
    inputPreview: string
    resultPreview: string
    status: string
    title: string
  }>
  switch (event.kind) {
    case 'prompt':
      return [`❯ ${p.text}`]
    case 'assistant_text':
    case 'summary':
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (event.kind === 'summary' && i === 0 ? `✦ ${line}` : line))
    case 'tool_activity': {
      const lines = [`⏺ ${p.toolName}(${p.inputPreview ?? ''})`]
      if (p.resultPreview) lines.push(`  ⎿ ${p.resultPreview}`)
      return lines
    }
    case 'permission_marker':
    case 'plan_marker': {
      const status = String(p.status)
      if (status === 'pending') return [`? Permission: ${p.title}`, '⏸ Waiting for approval…']
      const mark = status === 'approved' || status === 'rule_approved' ? '✓' : '✗'
      return [`${mark} ${status} · ${p.title}`]
    }
    case 'question':
      return [`? ${p.text}`]
    case 'error':
      return [`✗ ${p.text}`]
    // The figures, not a stand-in for them. This printed the literal string
    // `✓ turn complete` and dropped the duration, the cost and the token count
    // that the payload was already carrying — in the one view whose whole promise
    // is that it shows what the session actually reported.
    case 'result':
      return [`✓ ${resultLabel(event.payload as ResultPayload)}`]
    default:
      return String(p.text ?? '').split('\n')
  }
}

/**
 * What colour a terminal would have printed the line in.
 *
 * Derived from the EVENT KIND, not by re-reading the prefix glyph out of the
 * formatted string: the glyph is presentation and the kind is the fact. Line
 * index is passed because two kinds print a continuation line that reads
 * differently from their first — a tool's `⎿` result, a summary's body.
 */
export type LineTone = 'prompt' | 'text' | 'tool' | 'result' | 'ok' | 'warn' | 'err'

function toneOf(event: SessionEvent, i: number): LineTone {
  switch (event.kind) {
    case 'prompt':
      return 'prompt'
    case 'tool_activity':
      return i === 0 ? 'tool' : 'result'
    case 'summary':
      return i === 0 ? 'tool' : 'text'
    case 'permission_marker':
    case 'plan_marker': {
      const status = String((event.payload as { status?: string }).status)
      if (status === 'pending') return 'warn'
      return status === 'approved' || status === 'rule_approved' ? 'ok' : 'err'
    }
    case 'question':
      return 'warn'
    case 'error':
      return 'err'
    case 'result':
      return 'ok'
    default:
      return 'text'
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The HH:MM gutter stamp for an event's timestamp. */
function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface RawLine {
  key: string
  text: string
  stamp: string
  tone: LineTone
}

/**
 * Every event flattened to keyed raw lines.
 *
 * Keys are `event id + line offset` rather than an array index, so an event
 * still streaming — whose text grows line by line — keeps the lines it already
 * rendered instead of Vue re-keying the whole tail on each update. The stamp
 * sits on an event's FIRST line only, so a multi-line response reads as one
 * entry with one time, matching the clean view's gutter.
 */
export function toRawLines(events: readonly SessionEvent[], stamps: boolean): RawLine[] {
  return events.flatMap((event) => {
    const stamp = stamps ? hhmm(event.createdAt) : null
    return rawLinesOf(event).map((text, i) => ({
      key: `${event.id}:${i}`,
      text,
      stamp: i === 0 ? (stamp ?? '') : '',
      tone: toneOf(event, i),
    }))
  })
}

// Raw view formatting (FR-018): one session event rendered as the mono lines a
// terminal would have shown. Pure and Vue-free, so the mapping from every event
// kind to its prefix is testable on its own — it is the one place the raw view's
// promise of "100% of the output" is actually kept.
//
// In shared/ rather than renderer/ for the same reason markdown.ts is: the node
// tsconfig and Vitest can reach it without pulling in the Vue-dependent renderer.
import type { ResultPayload, SessionEvent } from './domain'

/** What each injected block is called on its header line. Shared with the clean
 *  view's collapsed row, so the two cannot name the same block differently. */
export const INJECTION_LABEL: Record<string, string> = {
  system_reminder: 'system reminder (injected)',
  command: 'slash command expansion (injected)',
  hook: 'hook output (injected)',
  system: 'session init',
  context: 'injected context',
}

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
/**
 * The argument a terminal would have shown beside a tool name.
 *
 * `inputPreview` is `JSON.stringify` of the tool's whole input, which is what the
 * raw view used to print: a wall of escaped JSON where the CLI shows
 * `Read(src/main/index.ts)`. The one field that identifies the call is picked per
 * tool; anything unrecognised falls back to the JSON, because showing a blob is
 * still better than showing nothing.
 */
const TOOL_ARG_FIELDS: Record<string, readonly string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description'],
  Agent: ['description'],
  Skill: ['skill'],
}

export function toolArgOf(toolName: string | undefined, inputPreview: string | undefined): string {
  const raw = inputPreview ?? ''
  if (!raw) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Truncated or already a bare string: nothing to pick a field out of.
    return raw
  }
  if (typeof parsed === 'string') return parsed
  if (typeof parsed !== 'object' || parsed === null) return raw
  const record = parsed as Record<string, unknown>
  for (const field of TOOL_ARG_FIELDS[toolName ?? ''] ?? []) {
    const value = record[field]
    if (typeof value === 'string' && value) return value
  }
  return raw
}

/**
 * Continuation lines under a tool call, in the CLI's own shape: the first result
 * line carries the `⎿` elbow and the rest are indented to sit under it.
 */
function resultLines(text: string): string[] {
  return text.split('\n').map((line, i) => (i === 0 ? `  ⎿ ${line}` : `    ${line}`))
}

export function rawLinesOf(event: SessionEvent): string[] {
  const p = event.payload as Partial<{
    text: string
    toolName: string
    inputPreview: string
    resultPreview: string
    status: string
    title: string
    source: string
  }>
  switch (event.kind) {
    case 'prompt':
      // A multi-line message keeps its shape, indented under the caret, rather
      // than being flattened onto one line that no longer reads as what was sent.
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`))
    case 'assistant_text':
    case 'summary':
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (event.kind === 'summary' && i === 0 ? `✦ ${line}` : line))
    case 'injection': {
      // Injected context, whole. The header names what it is so a system reminder
      // is never mistaken for something the developer typed.
      const label = INJECTION_LABEL[String(p.source)] ?? 'injected context'
      return [`⧉ ${label}`, ...String(p.text ?? '').split('\n').map((line) => `  ${line}`)]
    }
    case 'tool_activity': {
      const lines = [`⏺ ${p.toolName}(${toolArgOf(p.toolName, p.inputPreview)})`]
      if (p.resultPreview) lines.push(...resultLines(p.resultPreview))
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
export type LineTone = 'prompt' | 'text' | 'tool' | 'result' | 'ok' | 'warn' | 'err' | 'inject'

function toneOf(event: SessionEvent, i: number): LineTone {
  switch (event.kind) {
    case 'prompt':
      return 'prompt'
    case 'injection':
      return 'inject'
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

import type { ResultPayload, SessionEvent } from './domain'

export const INJECTION_LABEL: Record<string, string> = {
  system_reminder: 'system reminder (injected)',
  command: 'slash command expansion (injected)',
  hook: 'hook output (injected)',
  system: 'session init',
  context: 'injected context',
}

export function resultLabel(payload: ResultPayload): string {
  const parts: string[] = ['turn complete']
  if (payload.durationMs > 0) parts.push(`${(payload.durationMs / 1000).toFixed(1)}s`)
  if (payload.totalCostUsd > 0) parts.push(`$${payload.totalCostUsd.toFixed(2)}`)
  const tokens = (payload.usage?.inputTokens ?? 0) + (payload.usage?.outputTokens ?? 0)
  if (tokens > 0) parts.push(`${tokens} tok`)
  return parts.join(' · ')
}

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

function toolArgOf(toolName: string | undefined, inputPreview: string | undefined): string {
  const raw = inputPreview ?? ''
  if (!raw) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
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
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`))
    case 'assistant_text':
    case 'summary':
      return String(p.text ?? '')
        .split('\n')
        .map((line, i) => (event.kind === 'summary' && i === 0 ? `✦ ${line}` : line))
    case 'injection': {
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
    case 'result':
      return [`✓ ${resultLabel(event.payload as ResultPayload)}`]
    default:
      return String(p.text ?? '').split('\n')
  }
}

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

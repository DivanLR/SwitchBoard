import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent, TranscriptSummary } from '@shared/domain'

export const TRANSCRIPT_TTL_MS = 12 * 60 * 60 * 1000

export const TRANSCRIPT_EVENT_CAP = 5000

const HEADER_PREFIX = '<!-- switchboard-transcript '
const HEADER_SUFFIX = ' -->'

export function transcriptDir(): string {
  return join(tmpdir(), 'switchboard-transcripts')
}

function fileFor(sessionId: string): string {
  return join(transcriptDir(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
}

function oneLine(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16)
}

function countTop(values: string[], top: number): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, count]) => ({ name, count }))
}

function filePathsIn(events: SessionEvent[]): string[] {
  const paths: string[] = []
  for (const event of events) {
    if (event.kind !== 'tool_activity') continue
    const preview = (event.payload as { inputPreview?: string }).inputPreview ?? ''
    const match = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(preview)
    if (!match) continue
    try {
      paths.push(JSON.parse(`"${match[1]}"`) as string)
    } catch {
      paths.push(match[1])
    }
  }
  return paths
}

export interface BuiltTranscript {
  summary: Omit<TranscriptSummary, 'path'>
  text: string
}

export function buildTranscript(
  session: Session,
  projectName: string,
  events: SessionEvent[],
  savedAtMs: number,
): BuiltTranscript {
  const prompts = events.filter(
    (e) =>
      e.kind === 'prompt' &&
      !(e.payload as { pending?: boolean }).pending &&
      !(e.payload as { withdrawn?: boolean }).withdrawn,
  )
  const replies = events.filter(
    (e) =>
      (e.kind === 'assistant_text' && !(e.payload as { partial?: boolean }).partial) ||
      e.kind === 'summary',
  )
  const toolNames = events
    .filter((e) => e.kind === 'tool_activity')
    .map((e) => (e.payload as { toolName?: string }).toolName ?? 'tool')
  const denied = events.filter(
    (e) => e.kind === 'permission_marker' && (e.payload as { status?: string }).status === 'denied',
  ).length
  const files = countTop(filePathsIn(events), 3)
  const lastPrompt = prompts.length > 0
    ? oneLine((prompts[prompts.length - 1].payload as { text: string }).text)
    : null

  const savedAt = new Date(savedAtMs).toISOString()
  const expiresAt = new Date(savedAtMs + TRANSCRIPT_TTL_MS).toISOString()

  const digestLines = [
    `Previous session on **${projectName}** (${session.id}), ` +
      `${session.endedAt ? `ended ${clock(session.endedAt)}` : 'still open'}, ` +
      `started ${clock(session.startedAt)}.`,
    `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}, ` +
      `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}, ` +
      `${toolNames.length} tool call${toolNames.length === 1 ? '' : 's'}` +
      (denied > 0 ? `, ${denied} denied` : '') +
      '.',
  ]
  if (session.branch) digestLines.push(`Branch: ${session.branch}.`)
  if (toolNames.length > 0) {
    digestLines.push(
      `Tools: ${countTop(toolNames, 3).map((t) => `${t.name} ${t.count}×`).join(', ')}.`,
    )
  }
  if (files.length > 0) {
    digestLines.push(`Files touched: ${files.map((f) => `${f.name} (${f.count}×)`).join(', ')}.`)
  }
  if (lastPrompt) digestLines.push(`Last asked: "${lastPrompt}"`)
  const digest = digestLines.join('\n')

  const spine: string[] = []
  for (const event of events) {
    if (prompts.includes(event)) {
      spine.push(`### ❯ ${clock(event.createdAt)} asked\n\n${(event.payload as { text: string }).text.trim()}`)
    } else if (replies.includes(event)) {
      spine.push(`### ${clock(event.createdAt)} answered\n\n${(event.payload as { text: string }).text.trim()}`)
    }
  }

  const meta = {
    sessionId: session.id,
    projectId: session.projectId,
    projectName,
    savedAt,
    expiresAt,
    prompts: prompts.length,
    replies: replies.length,
    lastPrompt,
    digest,
  }

  const text = [
    `${HEADER_PREFIX}${JSON.stringify(meta)}${HEADER_SUFFIX}`,
    `# ${projectName} — session transcript`,
    '',
    digest,
    '',
    `Saved ${savedAt}. This file is temporary and expires ${expiresAt}.`,
    '',
    '---',
    '',
    spine.length > 0 ? spine.join('\n\n') : '_Nothing was asked in this session._',
    '',
  ].join('\n')

  return { summary: meta, text }
}

function parseHeader(text: string): Omit<TranscriptSummary, 'path'> | null {
  const end = text.indexOf(HEADER_SUFFIX)
  if (!text.startsWith(HEADER_PREFIX) || end < 0) return null
  try {
    return JSON.parse(text.slice(HEADER_PREFIX.length, end)) as Omit<TranscriptSummary, 'path'>
  } catch {
    return null
  }
}

export function sweepExpiredTranscripts(nowMs = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(transcriptDir())
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const file = join(transcriptDir(), name)
    try {
      if (nowMs - statSync(file).mtimeMs < TRANSCRIPT_TTL_MS) continue
      rmSync(file)
      removed += 1
    } catch {
    }
  }
  return removed
}

export function writeTranscript(
  session: Session,
  projectName: string,
  events: SessionEvent[],
  nowMs = Date.now(),
): TranscriptSummary {
  const built = buildTranscript(session, projectName, events, nowMs)
  mkdirSync(transcriptDir(), { recursive: true })
  const path = fileFor(session.id)
  writeFileSync(path, built.text, 'utf8')
  sweepExpiredTranscripts(nowMs)
  return { ...built.summary, path }
}

export function listTranscripts(nowMs = Date.now()): TranscriptSummary[] {
  sweepExpiredTranscripts(nowMs)
  let names: string[]
  try {
    names = readdirSync(transcriptDir())
  } catch {
    return []
  }
  const out: TranscriptSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(transcriptDir(), name)
    try {
      const header = parseHeader(readFileSync(path, 'utf8').slice(0, 4096))
      if (header) out.push({ ...header, path })
    } catch {
    }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export function transcriptFor(sessionId: string, nowMs = Date.now()): TranscriptSummary | null {
  return listTranscripts(nowMs).find((t) => t.sessionId === sessionId) ?? null
}

export function transcriptContextAppend(transcript: TranscriptSummary): string {
  return [
    '## Carried context from the previous session',
    '',
    transcript.digest,
    '',
    `The full transcript of that session — every prompt and reply — is at ` +
      `${transcript.path}. Read it when you need detail the digest does not carry. ` +
      `It is a temporary file and expires ${transcript.expiresAt}.`,
    '',
    'Continue from where that session left off. Do not repeat work it already ' +
      'finished, and do not re-ask decisions it already settled.',
  ].join('\n')
}

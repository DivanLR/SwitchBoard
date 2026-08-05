// Session transcripts: the temp-file export a following session can be seeded
// with. The build is pure, so it is asserted directly; the filesystem half is
// asserted against a real temp directory, because an expiry sweep that does not
// actually delete is worth nothing.
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shared/domain'
import {
  TRANSCRIPT_TTL_MS,
  buildTranscript,
  listTranscripts,
  sweepExpiredTranscripts,
  transcriptContextAppend,
  transcriptDir,
  writeTranscript,
} from '@main/sessions/transcript'

const SAVED_AT = Date.parse('2026-08-04T21:00:00.000Z')

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    sdkSessionId: 'sdk-1',
    status: 'done',
    statusDetail: null,
    branch: 'main',
    diffAdds: null,
    diffDels: null,
    usageUtilization: null,
    usageResetsAt: null,
    usageLimitType: null,
    bypassPermissions: false,
    planMode: false,
    inPlanMode: false,
    mcpServers: [],
    startedAt: '2026-08-04T20:00:00.000Z',
    endedAt: '2026-08-04T20:58:00.000Z',
    endReason: 'stopped',
    ...overrides,
  } as Session
}

let seq = 0
function event(kind: string, payload: Record<string, unknown>): SessionEvent {
  seq += 1
  return {
    id: `e${seq}`,
    sessionId: 'sess-1',
    seq,
    kind,
    payload,
    noiseKind: null,
    createdAt: '2026-08-04T20:30:00.000Z',
  } as unknown as SessionEvent
}

describe('buildTranscript', () => {
  it('transcribes the prompt and reply spine, and nothing else', () => {
    const { text } = buildTranscript(
      session(),
      'alpha',
      [
        event('prompt', { text: 'tighten the lane rows' }),
        event('tool_activity', { toolName: 'Edit', inputPreview: '{"file_path":"src/a.vue"}' }),
        event('raw_output', { text: 'npm warn deprecated' }),
        event('assistant_text', { text: 'Done: rows are 40px.', partial: false }),
      ],
      SAVED_AT,
    )
    expect(text).toContain('tighten the lane rows')
    expect(text).toContain('Done: rows are 40px.')
    // Counted in the digest, never transcribed into the body.
    expect(text).toContain('Edit 1×')
    expect(text).not.toContain('npm warn deprecated')
  })

  it('counts only delivered prompts and settled replies', () => {
    const { summary } = buildTranscript(
      session(),
      'alpha',
      [
        event('prompt', { text: 'sent' }),
        event('prompt', { text: 'still queued', pending: true }),
        event('prompt', { text: 'taken back', withdrawn: true }),
        event('assistant_text', { text: 'half a th', partial: true }),
        event('assistant_text', { text: 'a whole thought', partial: false }),
        event('summary', { text: 'wrapped up' }),
      ],
      SAVED_AT,
    )
    expect(summary.prompts).toBe(1)
    expect(summary.replies).toBe(2)
    expect(summary.lastPrompt).toBe('sent')
  })

  it('names files only when a tool input actually quotes one', () => {
    const withPath = buildTranscript(
      session(),
      'alpha',
      [
        event('tool_activity', { toolName: 'Edit', inputPreview: '{"file_path":"src/a.vue","old' }),
        event('tool_activity', { toolName: 'Edit', inputPreview: '{"file_path":"src/a.vue","new' }),
      ],
      SAVED_AT,
    ).text
    expect(withPath).toContain('src/a.vue (2×)')

    const withoutPath = buildTranscript(
      session(),
      'alpha',
      [event('tool_activity', { toolName: 'Bash', inputPreview: '{"command":"npm test"}' })],
      SAVED_AT,
    ).text
    expect(withoutPath).not.toContain('Files touched')
  })

  it('expires twelve hours after the write, and says so in the file', () => {
    const { summary, text } = buildTranscript(session(), 'alpha', [], SAVED_AT)
    expect(Date.parse(summary.expiresAt) - Date.parse(summary.savedAt)).toBe(TRANSCRIPT_TTL_MS)
    expect(text).toContain(summary.expiresAt)
  })

  it('carries the digest inline and the path by reference, never the whole log', () => {
    const built = buildTranscript(
      session(),
      'alpha',
      [
        event('prompt', { text: 'a very specific thing that was asked' }),
        event('assistant_text', { text: 'a long answer that belongs in the file', partial: false }),
      ],
      SAVED_AT,
    )
    const append = transcriptContextAppend({ ...built.summary, path: '/tmp/t/sess-1.md' })
    expect(append).toContain(built.summary.digest)
    expect(append).toContain('/tmp/t/sess-1.md')
    // The digest quotes the last prompt on purpose — that is the cheapest useful
    // fact about where a session got to. What must NOT travel inline is the body.
    expect(append).toContain('a very specific thing that was asked')
    expect(append).not.toContain('a long answer that belongs in the file')
  })
})

describe('the temp directory', () => {
  const stray = () => join(transcriptDir(), 'stray-old.md')

  beforeEach(() => {
    mkdirSync(transcriptDir(), { recursive: true })
  })

  afterEach(() => {
    for (const file of [stray(), join(transcriptDir(), 'sess-1.md')]) {
      if (existsSync(file)) rmSync(file)
    }
  })

  it('writes a listable transcript and reads its own header back', () => {
    const saved = writeTranscript(
      session(),
      'alpha',
      [event('prompt', { text: 'hello' })],
      SAVED_AT,
    )
    expect(existsSync(saved.path)).toBe(true)
    expect(readFileSync(saved.path, 'utf8')).toContain('hello')
    const listed = listTranscripts(SAVED_AT).find((t) => t.sessionId === 'sess-1')
    expect(listed?.path).toBe(saved.path)
    expect(listed?.prompts).toBe(1)
  })

  it('sweeps a transcript older than the ttl and keeps a fresh one', () => {
    writeFileSync(stray(), '<!-- switchboard-transcript {} -->\n', 'utf8')
    const old = (Date.now() - TRANSCRIPT_TTL_MS - 60_000) / 1000
    utimesSync(stray(), old, old)

    // Every write sweeps, so an expired file cannot outlive the next save even if
    // nothing ever calls the sweep directly.
    const fresh = writeTranscript(session(), 'alpha', [], Date.now())
    expect(existsSync(stray())).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)

    // And the sweep is idempotent: nothing left to remove, the fresh one stays.
    expect(sweepExpiredTranscripts()).toBe(0)
    expect(existsSync(fresh.path)).toBe(true)
  })

  it('offers nothing once every transcript has expired', () => {
    const saved = writeTranscript(session(), 'alpha', [], Date.now())
    const old = (Date.now() - TRANSCRIPT_TTL_MS - 60_000) / 1000
    utimesSync(saved.path, old, old)

    expect(listTranscripts().find((t) => t.sessionId === 'sess-1')).toBeUndefined()
    expect(existsSync(saved.path)).toBe(false)
  })
})

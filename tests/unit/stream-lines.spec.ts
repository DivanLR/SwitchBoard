// The raw view's promise is "100% of the output" (FR-018), so what matters here
// is that no event kind renders as nothing and that streaming keys stay stable.
import { describe, expect, it } from 'vitest'
import type { EventKind, SessionEvent } from '@shared/domain'
import { rawLinesOf, toRawLines } from '@shared/stream-lines'

function event<K extends EventKind>(kind: K, payload: unknown, id = 'e1'): SessionEvent {
  return {
    id,
    sessionId: 's1',
    seq: 1,
    kind,
    payload: payload as SessionEvent['payload'],
    noiseKind: null,
    createdAt: '2026-08-02T09:07:00.000Z',
  }
}

describe('rawLinesOf', () => {
  it('prefixes each kind the way a terminal would have shown it', () => {
    expect(rawLinesOf(event('prompt', { text: 'do the thing' }))).toEqual(['❯ do the thing'])
    expect(rawLinesOf(event('error', { text: 'it broke' }))).toEqual(['✗ it broke'])
    expect(rawLinesOf(event('question', { text: 'which one?' }))).toEqual(['? which one?'])
    // An empty payload still renders, and says only what it knows.
    expect(rawLinesOf(event('result', {}))).toEqual(['✓ turn complete'])
  })

  // THE FIGURES, NOT A STAND-IN FOR THEM. This case printed the bare string
  // `✓ turn complete` and discarded the duration, cost and token count the
  // payload was already carrying — in the one view whose promise is that it
  // shows what the session actually reported.
  it('states what the turn cost, in the view that promises the whole output', () => {
    const lines = rawLinesOf(
      event('result', {
        durationMs: 1200,
        totalCostUsd: 0.42,
        usage: { inputTokens: 100, outputTokens: 40 },
      }),
    )
    expect(lines).toEqual(['✓ turn complete · 1.2s · $0.42 · 140 tok'])
  })

  // A partial payload degrades a part at a time rather than all at once, and a
  // missing `usage` must not throw: the raw view calls this on whatever is in
  // the event log, including rows written by an older schema.
  it('drops only the parts it has no figure for', () => {
    expect(rawLinesOf(event('result', { durationMs: 900 }))).toEqual([
      '✓ turn complete · 0.9s',
    ])
    expect(rawLinesOf(event('result', { totalCostUsd: 0.5, usage: {} }))).toEqual([
      '✓ turn complete · $0.50',
    ])
    // Zero is not a reading worth a column: a free turn says nothing about cost
    // rather than claiming $0.00.
    expect(rawLinesOf(event('result', { durationMs: 0, totalCostUsd: 0 }))).toEqual([
      '✓ turn complete',
    ])
  })

  it('marks only the first line of a summary, leaving the body alone', () => {
    expect(rawLinesOf(event('summary', { text: 'Did it\nand then\nsome more' }))).toEqual([
      '✦ Did it',
      'and then',
      'some more',
    ])
  })

  it('shows a tool result underneath its call, and omits the branch when absent', () => {
    expect(
      rawLinesOf(event('tool_activity', { toolName: 'Bash', inputPreview: 'ls', resultPreview: 'a b' })),
    ).toEqual(['⏺ Bash(ls)', '  ⎿ a b'])
    expect(rawLinesOf(event('tool_activity', { toolName: 'Read', inputPreview: 'x.ts' }))).toEqual([
      '⏺ Read(x.ts)',
    ])
  })

  it('says a pending permission is still waiting, and how a decided one went', () => {
    expect(rawLinesOf(event('permission_marker', { status: 'pending', title: 'rm -rf' }))).toEqual([
      '? Permission: rm -rf',
      '⏸ Waiting for approval…',
    ])
    expect(rawLinesOf(event('permission_marker', { status: 'approved', title: 'ls' }))).toEqual([
      '✓ approved · ls',
    ])
    expect(rawLinesOf(event('permission_marker', { status: 'denied', title: 'ls' }))).toEqual([
      '✗ denied · ls',
    ])
    // Auto-approval by a standing rule is an approval, not a refusal.
    expect(rawLinesOf(event('permission_marker', { status: 'rule_approved', title: 'ls' }))).toEqual([
      '✓ rule_approved · ls',
    ])
  })

  it('never renders an event as nothing, whatever its kind', () => {
    // The raw view keeps everything; a kind falling through the switch must still
    // produce a line rather than disappearing from the transcript.
    const kinds: EventKind[] = [
      'prompt',
      'assistant_text',
      'summary',
      'tool_activity',
      'question',
      'permission_marker',
      'plan_marker',
      'error',
      'result',
      'raw_output',
    ]
    for (const kind of kinds) {
      expect(rawLinesOf(event(kind, { text: 'x', toolName: 't', status: 'approved' })).length)
        .toBeGreaterThan(0)
    }
  })
})

describe('toRawLines', () => {
  it('keys by event id and line offset, not by position in the flattened list', () => {
    const lines = toRawLines(
      [event('assistant_text', { text: 'one\ntwo' }, 'a'), event('prompt', { text: 'hi' }, 'b')],
      false,
    )
    expect(lines.map((l) => l.key)).toEqual(['a:0', 'a:1', 'b:0'])
  })

  it('stamps only an event first line, and only when timestamps are on', () => {
    const off = toRawLines([event('assistant_text', { text: 'one\ntwo' })], false)
    expect(off.map((l) => l.stamp)).toEqual(['', ''])

    const on = toRawLines([event('assistant_text', { text: 'one\ntwo' })], true)
    expect(on[0].stamp).toMatch(/^\d{2}:\d{2}$/)
    expect(on[1].stamp).toBe('')
  })

  it('tones a line by its event kind, and a tool result apart from its call', () => {
    const lines = toRawLines(
      [
        event('prompt', { text: 'hi' }, 'a'),
        event('tool_activity', { toolName: 'Read', inputPreview: 'x.ts', resultPreview: 'ok' }, 'b'),
        event('error', { text: 'boom' }, 'c'),
      ],
      false,
    )
    expect(lines.map((l) => l.tone)).toEqual(['prompt', 'tool', 'result', 'err'])
  })
})

// T039: swallow classifier — matching, ordering, and the
// categorical exemptions (FR-015a/017).
import { describe, expect, it } from 'vitest'
import type { EventKind, SessionEvent, SwallowRule } from '@shared/domain'
import { classifyNoise, defaultSwallowRules, displayTextOf } from '@main/stream/swallow-rules'

let seq = 0
function event(kind: EventKind, payload: unknown): SessionEvent {
  seq += 1
  return {
    id: `e${seq}`,
    sessionId: 's1',
    seq,
    kind,
    payload: payload as SessionEvent['payload'],
    noiseKind: null,
    createdAt: new Date().toISOString(),
  }
}

function rule(partial: Partial<SwallowRule>): SwallowRule {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    position: partial.position ?? 0,
    eventKindMatcher: partial.eventKindMatcher ?? '*',
    pattern: partial.pattern ?? '.*',
    noiseKind: partial.noiseKind ?? 'noise',
    enabled: partial.enabled ?? true,
  }
}

describe('classifyNoise', () => {
  it('tags matching swallowable events with the rule noiseKind', () => {
    const rules = [rule({ eventKindMatcher: 'raw_output', pattern: 'Compiling', noiseKind: 'build output' })]
    expect(classifyNoise(rules, event('raw_output', { text: 'Compiling module 4 of 90' }))).toBe(
      'build output',
    )
    expect(classifyNoise(rules, event('raw_output', { text: 'unrelated' }))).toBeNull()
  })

  it('never tags exempt kinds, whatever the rules say (FR-015a/017)', () => {
    const catchAll = [rule({ eventKindMatcher: '*', pattern: '.*' })]
    expect(classifyNoise(catchAll, event('error', { text: 'boom', fatal: false }))).toBeNull()
    expect(
      classifyNoise(
        catchAll,
        event('permission_marker', { requestId: 'r', title: 't', risk: 'low', status: 'pending' }),
      ),
    ).toBeNull()
    expect(
      classifyNoise(catchAll, event('plan_marker', { requestId: 'r', title: 't', status: 'pending' })),
    ).toBeNull()
    expect(classifyNoise(catchAll, event('question', { text: 'q', options: [] }))).toBeNull()
    expect(classifyNoise(catchAll, event('prompt', { text: 'hi' }))).toBeNull()
    expect(classifyNoise(catchAll, event('summary', { text: 's' }))).toBeNull()
    expect(
      classifyNoise(catchAll, event('result', { totalCostUsd: 0, usage: {}, durationMs: 0 })),
    ).toBeNull()
  })

  it('ignores rules that target exempt kinds directly', () => {
    const rules = [rule({ eventKindMatcher: 'error', pattern: '.*' })]
    expect(classifyNoise(rules, event('raw_output', { text: 'x' }))).toBeNull()
  })

  it('applies rules in position order, first match wins', () => {
    const rules = [
      rule({ position: 0, pattern: 'download', noiseKind: 'progress' }),
      rule({ position: 1, pattern: '.*', noiseKind: 'other' }),
    ]
    expect(classifyNoise(rules, event('raw_output', { text: 'downloading 3%' }))).toBe('progress')
  })

  it('skips disabled rules (toggling beats deleting)', () => {
    const rules = [rule({ enabled: false, pattern: '.*' })]
    expect(classifyNoise(rules, event('raw_output', { text: 'anything' }))).toBeNull()
  })

  it('treats invalid regular expressions as non-matching', () => {
    const rules = [rule({ pattern: '([' })]
    expect(classifyNoise(rules, event('raw_output', { text: 'anything' }))).toBeNull()
  })

  it('matches tool_activity on its composed display text', () => {
    const rules = [rule({ eventKindMatcher: 'tool_activity', pattern: '^Read\\b', noiseKind: 'file inspection' })]
    const e = event('tool_activity', { toolName: 'Read', inputPreview: 'a.txt' })
    expect(displayTextOf(e)).toContain('Read')
    expect(classifyNoise(rules, e)).toBe('file inspection')
  })
})

describe('default swallow rules', () => {
  const defaults = defaultSwallowRules()

  it('collapse typical build output and progress spam', () => {
    expect(classifyNoise(defaults, event('raw_output', { text: 'Compiling src/main.ts' }))).toBe(
      'build output',
    )
    expect(classifyNoise(defaults, event('raw_output', { text: 'Downloading 45%' }))).toBe('progress')
  })

  it('never hides a response that merely contains a percentage (e.g. /usage)', () => {
    // A bare percentage is not progress: the model's narrative and command
    // responses must stay visible in the clean view.
    expect(
      classifyNoise(defaults, event('assistant_text', { text: 'Current 5-hour usage: 45%', partial: false })),
    ).toBeNull()
    expect(classifyNoise(defaults, event('raw_output', { text: 'Weekly limit: 85% used' }))).toBeNull()
  })

  it('never tag errors', () => {
    expect(classifyNoise(defaults, event('error', { text: 'Compiling failed', fatal: false }))).toBeNull()
  })
})

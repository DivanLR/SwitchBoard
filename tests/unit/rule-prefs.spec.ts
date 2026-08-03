// Merging the developer's changes over the shipped rule defaults.
//
// The property being protected is the one the earlier seeded-table design lost:
// the shipped defaults stay authoritative, so changing one in code reaches every
// install that has not overridden that exact rule, while an override survives.
import { describe, expect, it } from 'vitest'
import { classifyRisk, defaultRiskRules } from '@main/inbox/risk-rules'
import { classifyNoise, defaultSwallowRules } from '@main/stream/swallow-rules'
import {
  effectiveRiskRules,
  effectiveSwallowRules,
  type RulePref,
} from '@main/inbox/rule-prefs'
import type { SessionEvent } from '@shared/domain'

const pref = (over: Partial<RulePref> & Pick<RulePref, 'id' | 'kind'>): RulePref => ({
  disabled: false,
  risk: null,
  body: null,
  position: null,
  ...over,
})

const rawOutput = (text: string): SessionEvent =>
  ({
    id: 'e1',
    sessionId: 's1',
    seq: 1,
    kind: 'raw_output',
    payload: { text },
    noiseKind: null,
    createdAt: '',
  }) as SessionEvent

describe('effectiveRiskRules', () => {
  it('is exactly the shipped defaults when nothing has been changed', () => {
    const effective = effectiveRiskRules([])
    expect(effective).toHaveLength(defaultRiskRules().length)
    expect(effective.map((r) => r.id)).toEqual(defaultRiskRules().map((r) => r.id))
  })

  it('ships stable ids, so an override can outlive a restart', () => {
    // Two separate calls must agree, or nothing could be keyed to a shipped rule.
    expect(defaultRiskRules().map((r) => r.id)).toEqual(defaultRiskRules().map((r) => r.id))
    expect(defaultRiskRules().every((r) => r.id.startsWith('builtin:'))).toBe(true)
  })

  it('drops a shipped rule the developer switched off', () => {
    const rules = effectiveRiskRules([pref({ id: 'builtin:tool-read', kind: 'risk', disabled: true })])
    expect(rules.some((r) => r.id === 'builtin:tool-read')).toBe(false)
    // Read now falls through to the fail-safe rather than reading as low risk.
    expect(classifyRisk(rules, 'Read', { file_path: 'a.ts' })).toBe('high')
  })

  it('applies a changed risk level to a shipped rule', () => {
    const rules = effectiveRiskRules([
      pref({ id: 'builtin:tool-write', kind: 'risk', risk: 'high' }),
    ])
    expect(classifyRisk(rules, 'Write', {})).toBe('high')
  })

  it("puts the developer's own rules ahead of the shipped ones", () => {
    // Bash rm -rf is high by default. A custom rule must be able to beat that,
    // or writing one achieved nothing.
    const custom = {
      id: 'custom-1',
      scope: 'global',
      position: 0,
      toolMatcher: 'Bash',
      inputMatcher: { field: 'command', pattern: '^rm -rf \\./tmp' },
      risk: 'low',
      builtin: false,
    }
    const rules = effectiveRiskRules([
      pref({ id: 'custom-1', kind: 'risk', body: JSON.stringify(custom), position: 0 }),
    ])
    expect(rules[0].id).toBe('custom-1')
    expect(classifyRisk(rules, 'Bash', { command: 'rm -rf ./tmp/build' })).toBe('low')
    // The shipped rule still governs everything it always did.
    expect(classifyRisk(rules, 'Bash', { command: 'rm -rf /' })).toBe('high')
  })

  it('ignores a custom rule that is switched off', () => {
    const body = JSON.stringify({
      id: 'custom-1',
      scope: 'global',
      position: 0,
      toolMatcher: 'WebFetch',
      inputMatcher: null,
      risk: 'low',
      builtin: false,
    })
    const rules = effectiveRiskRules([
      pref({ id: 'custom-1', kind: 'risk', body, disabled: true, position: 0 }),
    ])
    expect(rules.some((r) => r.id === 'custom-1')).toBe(false)
    expect(classifyRisk(rules, 'WebFetch', {})).toBe('high')
  })

  it('ignores an override for a rule that no longer ships', () => {
    // Retiring a rule must not resurrect it or throw; the row just does nothing.
    const rules = effectiveRiskRules([
      pref({ id: 'builtin:removed-long-ago', kind: 'risk', disabled: true }),
    ])
    expect(rules).toHaveLength(defaultRiskRules().length)
  })

  it('ignores a row whose body will not parse, leaving the defaults in force', () => {
    // Conservative direction on purpose: an unreadable rule must never widen
    // what is allowed.
    const rules = effectiveRiskRules([
      pref({ id: 'custom-broken', kind: 'risk', body: '{not json', position: 0 }),
    ])
    expect(rules).toHaveLength(defaultRiskRules().length)
  })

  it('does not let a swallow pref affect the risk rules', () => {
    const rules = effectiveRiskRules([
      pref({ id: 'builtin:tool-read', kind: 'swallow', disabled: true }),
    ])
    expect(rules.some((r) => r.id === 'builtin:tool-read')).toBe(true)
  })

  it('renumbers positions so the engine sorts in the merged order', () => {
    const rules = effectiveRiskRules([])
    expect(rules.map((r) => r.position)).toEqual(rules.map((_, i) => i))
  })
})

describe('effectiveSwallowRules', () => {
  it('is exactly the shipped defaults when nothing has been changed', () => {
    expect(effectiveSwallowRules([]).map((r) => r.id)).toEqual(
      defaultSwallowRules().map((r) => r.id),
    )
  })

  it('stops hiding output once the developer switches that rule off', () => {
    const buildLine = rawOutput('Compiling something')
    expect(classifyNoise(effectiveSwallowRules([]), buildLine)).toBe('build output')

    const rules = effectiveSwallowRules([
      pref({ id: 'builtin:build-output', kind: 'swallow', disabled: true }),
    ])
    expect(classifyNoise(rules, buildLine)).toBeNull()
  })

  it('applies a rule the developer wrote', () => {
    const body = JSON.stringify({
      id: 'custom-1',
      scope: 'global',
      projectId: null,
      position: 0,
      eventKindMatcher: 'raw_output',
      pattern: 'DEPRECATION WARNING',
      noiseKind: 'deprecations',
      enabled: true,
    })
    const rules = effectiveSwallowRules([
      pref({ id: 'custom-1', kind: 'swallow', body, position: 0 }),
    ])
    expect(classifyNoise(rules, rawOutput('DEPRECATION WARNING: x'))).toBe('deprecations')
  })
})

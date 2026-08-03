// rule_prefs round-trips: only the difference from the shipped defaults is stored,
// and forgetting a row restores the default because a missing row IS the default.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { effectiveRiskRules, effectiveSwallowRules } from '@main/inbox/rule-prefs'
import { classifyRisk, defaultRiskRules } from '@main/inbox/risk-rules'

function repos() {
  return createRepositories(openDatabase(':memory:'))
}

describe('RulePrefsRepo', () => {
  it('starts empty, so a fresh install runs the shipped defaults', () => {
    const r = repos()
    expect(r.rulePrefs.list()).toEqual([])
    expect(effectiveRiskRules(r.rulePrefs.list())).toHaveLength(defaultRiskRules().length)
  })

  it('records a switched-off shipped rule and takes it out of force', () => {
    const r = repos()
    r.rulePrefs.setDisabled('builtin:tool-read', 'risk', true)

    expect(r.rulePrefs.list()).toEqual([
      {
        id: 'builtin:tool-read',
        kind: 'risk',
        disabled: true,
        risk: null,
        body: null,
        position: null,
      },
    ])
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'Read', {})).toBe('high')
  })

  it('switches the same rule back on without creating a second row', () => {
    const r = repos()
    r.rulePrefs.setDisabled('builtin:tool-read', 'risk', true)
    r.rulePrefs.setDisabled('builtin:tool-read', 'risk', false)

    expect(r.rulePrefs.list()).toHaveLength(1)
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'Read', {})).toBe('low')
  })

  it('keeps risk and disabled independent on the same rule', () => {
    // Both write the same row, so one must not clear the other.
    const r = repos()
    r.rulePrefs.setRisk('builtin:tool-write', 'high')
    r.rulePrefs.setDisabled('builtin:tool-write', 'risk', true)

    const [row] = r.rulePrefs.list()
    expect(row).toMatchObject({ risk: 'high', disabled: true })
  })

  it('restores the shipped default when the override is forgotten', () => {
    const r = repos()
    r.rulePrefs.setRisk('builtin:tool-write', 'high')
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'Write', {})).toBe('high')

    r.rulePrefs.remove('builtin:tool-write', 'risk')
    expect(r.rulePrefs.list()).toEqual([])
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'Write', {})).toBe('medium')
  })

  it('stores a rule the developer wrote and puts it in force', () => {
    const r = repos()
    const body = JSON.stringify({
      id: 'ignored',
      scope: 'global',
      position: 0,
      toolMatcher: 'WebFetch',
      inputMatcher: null,
      risk: 'low',
      builtin: false,
    })
    const added = r.rulePrefs.addCustom('risk', body)

    expect(added.position).toBe(0)
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'WebFetch', {})).toBe('low')

    r.rulePrefs.remove(added.id, 'risk')
    expect(classifyRisk(effectiveRiskRules(r.rulePrefs.list()), 'WebFetch', {})).toBe('high')
  })

  it('numbers each kind of custom rule independently', () => {
    const r = repos()
    const a = r.rulePrefs.addCustom('risk', '{}')
    const b = r.rulePrefs.addCustom('risk', '{}')
    const c = r.rulePrefs.addCustom('swallow', '{}')

    expect([a.position, b.position, c.position]).toEqual([0, 1, 0])
  })

  it('keeps risk and swallow prefs for the same id apart', () => {
    // The primary key is (id, kind); one id can legitimately appear under both.
    const r = repos()
    r.rulePrefs.setDisabled('builtin:progress', 'swallow', true)
    r.rulePrefs.setDisabled('builtin:progress', 'risk', true)

    expect(r.rulePrefs.list()).toHaveLength(2)
    expect(effectiveSwallowRules(r.rulePrefs.list()).some((x) => x.id === 'builtin:progress')).toBe(
      false,
    )
  })
})

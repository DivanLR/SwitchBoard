import { describe, expect, it } from 'vitest'
import { subagentsAllowed, EFFORT_LEVELS } from '@shared/domain'
import { modelDeviation, nextStrongestModel } from '@main/sessions/model-fallback'

describe('nextStrongestModel (usage-limit fallback ladder)', () => {
  it('drops the account default and unknown ids to the Sonnet workhorse', () => {
    expect(nextStrongestModel('default')).toBe('sonnet')
    expect(nextStrongestModel(undefined)).toBe('sonnet')
    expect(nextStrongestModel('some-future-model')).toBe('sonnet')
  })

  it('walks one family down and stops at the floor', () => {
    expect(nextStrongestModel('claude-fable-5')).toBe('opus')
    expect(nextStrongestModel('claude-sonnet-5')).toBe('haiku')
    expect(nextStrongestModel('claude-haiku-4-5-20251001')).toBeNull()
  })

  it('is keyed by family, so any release of a family takes the same rung', () => {
    expect(nextStrongestModel('claude-opus-4-8')).toBe('sonnet')
    expect(nextStrongestModel('claude-opus-5[1m]')).toBe('sonnet')
    expect(nextStrongestModel('claude-opus-9-fictional')).toBe('sonnet')
    expect(nextStrongestModel('opus')).toBe('sonnet')
  })
})

describe('subagentsAllowed (subagents are a max-effort feature)', () => {
  it('is true at max and nowhere else', () => {
    expect(EFFORT_LEVELS.filter(subagentsAllowed)).toEqual(['max'])
  })
})

describe('modelDeviation (a skill naming its own model)', () => {
  it('is false when nothing was reported, nothing is wanted, or the account default is wanted', () => {
    expect(modelDeviation(undefined, 'claude-opus-5')).toBe(false)
    expect(modelDeviation('claude-sonnet-5', undefined)).toBe(false)
    expect(modelDeviation('claude-sonnet-5', 'default')).toBe(false)
  })

  it('is false when the reported model is the same family as the one configured', () => {
    expect(modelDeviation('claude-opus-5[1m]', 'claude-opus-4-8')).toBe(false)
  })

  it('is true when a turn ran on a different family than the one configured', () => {
    expect(modelDeviation('claude-haiku-4-5', 'claude-opus-5')).toBe(true)
  })
})

// Intent heuristic for automatic model routing.
import { describe, expect, it } from 'vitest'
import { subagentsAllowed, EFFORT_LEVELS } from '@shared/domain'
import {
  classifyIntent,
  classifyWorkload,
  mainLoopModel,
  nextStrongestModel,
} from '@main/sessions/model-routing'

describe('classifyIntent', () => {
  it('routes questions and discussion to the plan model', () => {
    expect(classifyIntent('What does this function do?')).toBe('plan')
    expect(classifyIntent('Why is the session resetting?')).toBe('plan')
    expect(classifyIntent('Explain the permission broker to me')).toBe('plan')
    expect(classifyIntent('')).toBe('plan')
  })

  it('routes code changes and script runs to the work model', () => {
    expect(classifyIntent('Fix the off-by-one in the pager')).toBe('work')
    expect(classifyIntent('implement a stop button')).toBe('work')
    expect(classifyIntent('run the test suite')).toBe('work')
    expect(classifyIntent('add white-space: pre-wrap to StreamEvent.vue')).toBe('work')
  })

  it('treats a file path or code fence as work', () => {
    expect(classifyIntent('look at src/main/sessions/session.ts')).toBe('work')
    expect(classifyIntent('```ts\nconst a = 1\n```')).toBe('work')
  })
})

describe('classifyWorkload (Advisor/Orchestrator auto mode)', () => {
  it('keeps questions on plan', () => {
    expect(classifyWorkload('why does the pager skip the last row?')).toBe('plan')
    expect(classifyWorkload('what is the difference between the two views?')).toBe('plan')
  })

  it('routes scoped mechanical work to advisor', () => {
    expect(classifyWorkload('Fix the off-by-one in the pager')).toBe('advisor')
    expect(classifyWorkload('rename the helper in src/shared/markdown.ts')).toBe('advisor')
    expect(classifyWorkload('add white-space: pre-wrap to StreamEvent.vue')).toBe('advisor')
  })

  it('routes broad multi-step goals to orchestrator', () => {
    expect(classifyWorkload('audit the whole app for accessibility issues')).toBe('orchestrator')
    expect(classifyWorkload('restyle every component to match the new design')).toBe('orchestrator')
    expect(classifyWorkload('migrate all files across the repo to the new API')).toBe('orchestrator')
    expect(classifyWorkload('research the best approach and implement it end-to-end')).toBe('orchestrator')
    expect(
      classifyWorkload('do all of the following\n- fix the header\n- add a toggle\n- update the tests'),
    ).toBe('orchestrator')
  })
})

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

// Effort is the developer's own bar now (Settings.effort), not a per-role
// derivation. The one rule left to hold is the rung at which subagents exist.
describe('subagentsAllowed (subagents are a max-effort feature)', () => {
  it('is true at max and nowhere else', () => {
    expect(EFFORT_LEVELS.filter(subagentsAllowed)).toEqual(['max'])
  })
})

describe('mainLoopModel (one model per session, never switched)', () => {
  const models = { intelligentModel: 'claude-opus-5', workerModel: 'claude-sonnet-5' }

  it('runs the cheap model in Advisor mode — the strong tier is the advisor subagent', () => {
    expect(mainLoopModel('advisor', models)).toBe('claude-sonnet-5')
  })

  it('runs the intelligent model for Orchestrator and auto', () => {
    expect(mainLoopModel('orchestrator', models)).toBe('claude-opus-5')
    expect(mainLoopModel('auto', models)).toBe('claude-opus-5')
    expect(mainLoopModel(undefined, models)).toBe('claude-opus-5')
  })

  it('falls back to the intelligent model when no worker is configured', () => {
    expect(mainLoopModel('advisor', { intelligentModel: 'claude-opus-5' })).toBe('claude-opus-5')
  })
})

// BASIC MODE EXISTS TO COST LESS, so its guarantees are about what does NOT
// happen: no strong model, no second model registered, no delegation protocol.
// Each of those is a separate mechanism, and any one of them left on would let
// the expensive tier back in while the setting still said "basic".
describe('basic mode', () => {
  const models = { intelligentModel: 'opus', workerModel: 'haiku' }

  it('runs the cheap model, like advisor and unlike the rest', () => {
    expect(mainLoopModel('basic', models)).toBe('haiku')
    expect(mainLoopModel('advisor', models)).toBe('haiku')
    expect(mainLoopModel('orchestrator', models)).toBe('opus')
    expect(mainLoopModel('auto', models)).toBe('opus')
  })

  // With no worker configured there is still only one model to run, and it is
  // the account's. Falling back to the strong one is right: a mode that cannot
  // find its cheap model must still produce a working session.
  it('falls back to the intelligent model when no worker is set', () => {
    expect(mainLoopModel('basic', { intelligentModel: 'opus' })).toBe('opus')
  })
})

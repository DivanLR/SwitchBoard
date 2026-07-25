// Intent heuristic for automatic model routing.
import { describe, expect, it } from 'vitest'
import {
  classifyIntent,
  classifyWorkload,
  maxEffortUnlessFable,
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

describe('maxEffortUnlessFable (ultra effort for non-Fable models)', () => {
  it('pushes non-Fable models to max effort', () => {
    expect(maxEffortUnlessFable('claude-opus-4-8')).toBe('max')
    expect(maxEffortUnlessFable('claude-sonnet-5')).toBe('max')
    expect(maxEffortUnlessFable('claude-haiku-4-5-20251001')).toBe('max')
    expect(maxEffortUnlessFable('some-future-model')).toBe('max')
  })

  it('leaves the Fable family and the account default at their default effort', () => {
    expect(maxEffortUnlessFable('claude-fable-5')).toBeNull()
    expect(maxEffortUnlessFable('claude-fable-5[1m]')).toBeNull()
    expect(maxEffortUnlessFable('default')).toBeNull()
    expect(maxEffortUnlessFable(undefined)).toBeNull()
    expect(maxEffortUnlessFable('')).toBeNull()
  })
})

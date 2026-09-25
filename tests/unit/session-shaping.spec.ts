import { describe, expect, it } from 'vitest'
import {
  promptPattern,
  modeAgents,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
} from '@main/sessions/session-shaping'

describe('promptPattern', () => {
  it('teaches the advisor pattern in Jev and nothing in Basic, where there is no advisor', () => {
    expect(promptPattern('jev')).toBe('advisor')
    expect(promptPattern('basic')).toBe('none')
  })
})

describe('modesSystemPromptAppend', () => {
  it('teaches scoped work and no longer carries a broad work or fan out protocol', () => {
    const advisor = modesSystemPromptAppend('advisor')
    expect(advisor).toContain('SCOPED WORK')
    expect(advisor).not.toContain('BROAD WORK')
    expect(advisor).not.toContain('DIVIDE AND CONQUER')
  })

  it('names both subagents so either tier can reach for them', () => {
    const text = modesSystemPromptAppend('advisor')
    expect(text).toContain('`advisor`')
    expect(text).toContain('`worker`')
  })

  it('states the advisor cap once, in the agent description, not again in the protocol text', () => {
    expect(modeAgents({}).advisor?.description ?? '').toContain('at most 3 consults')
    expect(modesSystemPromptAppend('advisor')).not.toContain('at most 3')
  })

  it('appends nothing for none', () => {
    expect(modesSystemPromptAppend('none')).toBe('')
    expect(modesSystemPromptAppend('advisor')).not.toBe('')
  })
})

describe('the subagents each mode registers', () => {
  it('registers only the worker, on the cheaper tier, in Basic', () => {
    const agents = modeAgents({ strongModel: 'opus', cheapModel: 'sonnet', mode: 'basic' })
    expect(Object.keys(agents)).toEqual(['worker'])
    expect(agents.worker.model).toBe('sonnet')
  })

  it('registers the advisor on the Model and the worker on the cheaper tier in Jev', () => {
    const agents = modeAgents({ strongModel: 'opus', cheapModel: 'sonnet', mode: 'jev' })
    expect(Object.keys(agents).sort()).toEqual(['advisor', 'worker'])
    expect(agents.advisor.model).toBe('opus')
    expect(agents.worker.model).toBe('sonnet')
  })

  it('sets no effort of their own, so subagents inherit the one effort flag', () => {
    const agents = modeAgents({ mode: 'jev' })
    expect(agents.advisor.effort).toBeUndefined()
    expect(agents.worker.effort).toBeUndefined()
  })
})

describe('sandboxSystemPromptAppend prose', () => {
  it('drops the build-per-platform mechanism aside, keeps the actionable instruction', () => {
    const append = sandboxSystemPromptAppend([{ container: '/workspace' }], null, true) ?? ''
    expect(append).not.toContain('ship a build per platform')
    expect(append).toContain('npm ci')
  })
})

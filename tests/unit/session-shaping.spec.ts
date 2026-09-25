import { describe, expect, it } from 'vitest'
import {
  promptPattern,
  heavySubagentSystemPromptAppend,
  modeAgents,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
} from '@main/sessions/session-shaping'

describe('heavySubagentSystemPromptAppend', () => {
  it('adds nothing unless the setting is on', () => {
    expect(heavySubagentSystemPromptAppend(false)).toBeNull()
  })

  it('demands one batched dispatch, in the divide-and-conquer terms it was asked for', () => {
    const append = heavySubagentSystemPromptAppend(true)
    expect(append).toContain('DIVIDE AND CONQUER')
    expect(append).toContain('as many dynamic subagents')
    expect(append).toContain('ONE batch')
  })

  it('exempts only single actions, never "it would be quicker to just do it"', () => {
    const append = heavySubagentSystemPromptAppend(true) ?? ''
    expect(append).toContain('single action')
    expect(append).toContain('is not an exemption')
    expect(append).not.toContain('Do NOT fan out for a one-line change')
  })
})

describe('promptPattern', () => {
  it('teaches the advisor pattern in Jev when heavy subagents are off', () => {
    expect(promptPattern(false, 'jev')).toBe('advisor')
  })

  it('pins to orchestrator when heavy subagents are on, so the two appends cannot contradict', () => {
    expect(promptPattern(true, 'jev')).toBe('orchestrator')
    expect(modesSystemPromptAppend(promptPattern(true, 'jev'))).not.toContain(
      'implement directly yourself',
    )
  })

  it('turns off for basic no matter the heavy-subagent setting, since there is no second tier', () => {
    expect(promptPattern(false, 'basic')).toBe('none')
    expect(promptPattern(true, 'basic')).toBe('none')
  })
})

describe('modesSystemPromptAppend', () => {
  it('teaches only the pattern it is given', () => {
    const advisor = modesSystemPromptAppend('advisor')
    const orchestrator = modesSystemPromptAppend('orchestrator')
    expect(advisor).toContain('SCOPED WORK')
    expect(advisor).not.toContain('BROAD WORK')
    expect(orchestrator).toContain('BROAD WORK')
    expect(orchestrator).not.toContain('SCOPED WORK')
  })

  it('names both subagents so either tier can reach for them', () => {
    for (const mode of ['advisor', 'orchestrator'] as const) {
      const text = modesSystemPromptAppend(mode)
      expect(text).toContain('`advisor`')
      expect(text).toContain('`worker`')
    }
  })

  it('states the advisor cap once, in the agent description, not again in the protocol text', () => {
    const description = modeAgents({}).advisor?.description ?? ''
    expect(description).toContain('at most 3 consults')
    for (const mode of ['advisor', 'orchestrator'] as const) {
      expect(modesSystemPromptAppend(mode)).not.toContain('at most 3')
    }
  })

  it('keeps the orchestrator "own turns" clause out of the heavy-subagent append', () => {
    const heavy = heavySubagentSystemPromptAppend(true) ?? ''
    const orchestrator = modesSystemPromptAppend('orchestrator')
    expect(orchestrator).toContain('Keep your own turns')
    expect(heavy).not.toContain('Keep your own turns')
  })

  it('appends nothing for none, because there is no second tier to describe', () => {
    expect(modesSystemPromptAppend('none')).toBe('')
    for (const mode of ['advisor', 'orchestrator'] as const) {
      expect(modesSystemPromptAppend(mode)).not.toBe('')
    }
  })
})

describe('heavySubagentSystemPromptAppend prose', () => {
  it('drops justification prose while keeping the token-cost closer', () => {
    const append = heavySubagentSystemPromptAppend(true) ?? ''
    expect(append).not.toContain('grinding through a list')
    expect(append).not.toContain('ask what the other four are')
    expect(append).toContain('fan-out spends more tokens')
  })

  it('sends the fan-out to the same worker the model modes register', () => {
    expect(heavySubagentSystemPromptAppend(true)).toContain('subagent_type "worker"')
    expect(Object.keys(modeAgents({ mode: 'jev' }))).toContain('worker')
    expect(Object.keys(modeAgents({ mode: 'basic' }))).toContain('worker')
  })
})

describe('basic mode shaping', () => {
  it('registers only the worker, on the cheaper tier, and no advisor', () => {
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

  it('gives both agents the subagent effort bar, and inherits when it is unset', () => {
    const set = modeAgents({ mode: 'jev', effort: 'medium' })
    expect(set.advisor.effort).toBe('medium')
    expect(set.worker.effort).toBe('medium')
    const unset = modeAgents({ mode: 'jev' })
    expect(unset.advisor.effort).toBeUndefined()
    expect(unset.worker.effort).toBeUndefined()
  })
})

describe('sandboxSystemPromptAppend prose', () => {
  it('drops the build-per-platform mechanism aside, keeps the actionable instruction', () => {
    const append = sandboxSystemPromptAppend([{ container: '/workspace' }], null, true) ?? ''
    expect(append).not.toContain('ship a build per platform')
    expect(append).toContain('npm ci')
  })
})

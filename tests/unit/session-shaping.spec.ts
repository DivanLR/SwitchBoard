import { describe, expect, it } from 'vitest'
import {
  heavySubagentModelMode,
  heavySubagentSystemPromptAppend,
  modeAgents,
  modesSystemPromptAppend,
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

describe('heavySubagentModelMode', () => {
  it('leaves an explicitly chosen mode alone when the setting is off', () => {
    expect(heavySubagentModelMode(false, 'advisor')).toBe('advisor')
    expect(heavySubagentModelMode(false, 'orchestrator')).toBe('orchestrator')
    expect(heavySubagentModelMode(false, 'basic')).toBe('basic')
  })

  it('drops auto to advisor when off, so nothing still tells the loop to delegate', () => {
    expect(heavySubagentModelMode(false, 'auto')).toBe('advisor')
    expect(modesSystemPromptAppend(heavySubagentModelMode(false, 'auto'))).not.toContain(
      'delegate each chunk',
    )
  })

  it('pins to orchestrator when on, so the two appends cannot contradict', () => {
    for (const chosen of ['auto', 'advisor', 'orchestrator'] as const) {
      expect(heavySubagentModelMode(true, chosen)).toBe('orchestrator')
    }
    expect(modesSystemPromptAppend(heavySubagentModelMode(true, 'advisor'))).not.toContain(
      'implement directly yourself',
    )
  })
})

describe('modesSystemPromptAppend', () => {
  it('teaches only the forced pattern, and both under auto', () => {
    const advisor = modesSystemPromptAppend('advisor')
    const orchestrator = modesSystemPromptAppend('orchestrator')
    const auto = modesSystemPromptAppend('auto')
    expect(advisor).toContain('SCOPED WORK')
    expect(advisor).not.toContain('BROAD WORK')
    expect(orchestrator).toContain('BROAD WORK')
    expect(orchestrator).not.toContain('SCOPED WORK')
    expect(auto).toContain('SCOPED WORK')
    expect(auto).toContain('BROAD WORK')
  })

  it('names both subagents so either tier can reach for them', () => {
    for (const mode of ['advisor', 'orchestrator', 'auto'] as const) {
      const text = modesSystemPromptAppend(mode)
      expect(text).toContain('`advisor`')
      expect(text).toContain('`worker`')
    }
  })

  it('states the advisor cap once, in the agent description, not again in the protocol text', () => {
    const description = modeAgents({}).advisor?.description ?? ''
    expect(description).toContain('at most 3 consults')
    for (const mode of ['advisor', 'orchestrator', 'auto'] as const) {
      expect(modesSystemPromptAppend(mode)).not.toContain('at most 3')
    }
  })

  it('keeps the orchestrator "own turns" clause out of the heavy-subagent append', () => {
    const heavy = heavySubagentSystemPromptAppend(true) ?? ''
    const orchestrator = modesSystemPromptAppend('orchestrator')
    expect(orchestrator).toContain('Keep your own turns')
    expect(heavy).not.toContain('Keep your own turns')
  })
})

describe('heavySubagentSystemPromptAppend prose', () => {
  it('drops justification prose while keeping the token-cost closer', () => {
    const append = heavySubagentSystemPromptAppend(true) ?? ''
    expect(append).not.toContain('grinding through a list')
    expect(append).not.toContain('ask what the other four are')
    expect(append).toContain('fan-out spends more tokens')
  })
})

describe('basic mode shaping', () => {
  it('appends no protocol, because there is no second tier to describe', () => {
    expect(modesSystemPromptAppend('basic')).toBe('')
    for (const mode of ['auto', 'advisor', 'orchestrator'] as const) {
      expect(modesSystemPromptAppend(mode)).not.toBe('')
    }
  })

  it('registers no subagents, so the expensive tier cannot be reached at all', () => {
    const agents = modeAgents({ strongModel: 'opus', cheapModel: 'haiku', mode: 'basic' })
    expect(Object.keys(agents)).toEqual([])
  })

  it('still registers both for every paired mode', () => {
    for (const mode of ['auto', 'advisor', 'orchestrator'] as const) {
      const agents = modeAgents({ strongModel: 'opus', cheapModel: 'haiku', mode })
      expect(Object.keys(agents).sort()).toEqual(['advisor', 'worker'])
      expect(agents.advisor.model).toBe('opus')
      expect(agents.worker.model).toBe('haiku')
    }
  })

  it('gives both agents the subagent effort bar, and inherits when it is unset', () => {
    const set = modeAgents({ mode: 'auto', effort: 'medium' })
    expect(set.advisor.effort).toBe('medium')
    expect(set.worker.effort).toBe('medium')
    const unset = modeAgents({ mode: 'auto' })
    expect(unset.advisor.effort).toBeUndefined()
    expect(unset.worker.effort).toBeUndefined()
  })
})

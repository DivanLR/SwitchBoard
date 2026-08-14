// What the app injects into every session: the sandbox note, heavy-subagent mode
// and the Advisor/Orchestrator mode protocol.
//
// The terse and ADHD output-style appends were removed on 2026-08-14, and the
// temp-directory fixtures went with them: only the ADHD accessor touched the
// filesystem, to read its opt-in flag file.
import { describe, expect, it } from 'vitest'
import {
  heavySubagentModelMode,
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
    // Sequential single dispatches are the failure this instruction exists to stop.
    expect(append).toContain('ONE batch')
  })

  it('exempts only single actions, never "it would be quicker to just do it"', () => {
    // The old text excused any work whose steps "depend on the previous result"
    // and anything where "dispatching costs more than doing" — two clauses that
    // fit almost any task, which is most of why the setting read as inert.
    const append = heavySubagentSystemPromptAppend(true) ?? ''
    expect(append).toContain('single action')
    expect(append).toContain('is not an exemption')
    expect(append).not.toContain('Do NOT fan out for a one-line change')
  })
})

describe('heavySubagentModelMode', () => {
  it('leaves the chosen mode alone when the setting is off', () => {
    expect(heavySubagentModelMode(false, 'advisor')).toBe('advisor')
    expect(heavySubagentModelMode(false, 'auto')).toBe('auto')
  })

  it('pins to orchestrator when on, so the two appends cannot contradict', () => {
    // Advisor's own protocol says to implement scoped work yourself, which is the
    // opposite instruction sitting in the same system prompt.
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
    // Heavy mode forces orchestrator (heavySubagentModelMode), so the two appends
    // are never apart; the instruction should live in exactly one of them.
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

describe('sandboxSystemPromptAppend prose', () => {
  it('drops the build-per-platform mechanism aside, keeps the actionable instruction', () => {
    const append = sandboxSystemPromptAppend([{ container: '/workspace' }], null, true) ?? ''
    expect(append).not.toContain('ship a build per platform')
    expect(append).toContain('npm ci')
  })
})


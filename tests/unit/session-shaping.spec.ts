// What the app injects into every session: output-style appends and the
// Advisor/Orchestrator mode protocol.
import { describe, expect, it } from 'vitest'
import {
  heavySubagentModelMode,
  heavySubagentSystemPromptAppend,
  modesSystemPromptAppend,
  terseSystemPromptAppend,
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

describe('terseSystemPromptAppend', () => {
  it('returns null when terse mode is off', () => {
    expect(terseSystemPromptAppend({ terseMode: false, terseLevel: 'full' })).toBeNull()
  })

  it('returns a level-specific instruction when on', () => {
    const lite = terseSystemPromptAppend({ terseMode: true, terseLevel: 'lite' })
    const full = terseSystemPromptAppend({ terseMode: true, terseLevel: 'full' })
    const ultra = terseSystemPromptAppend({ terseMode: true, terseLevel: 'ultra' })
    expect(lite).toContain('LITE')
    expect(full).toContain('OUTPUT STYLE')
    expect(ultra).toContain('ULTRA')
    expect(lite).not.toBe(full)
    expect(full).not.toBe(ultra)
  })

  it('always preserves code, commands, and errors byte-for-byte', () => {
    for (const level of ['lite', 'full', 'ultra'] as const) {
      const text = terseSystemPromptAppend({ terseMode: true, terseLevel: level })
      expect(text).toMatch(/code|commands|error/i)
      expect(text).toMatch(/reproduce|preserv|exactly/i)
    }
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
})

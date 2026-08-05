// What the app injects into every session: output-style appends and the
// Advisor/Orchestrator mode protocol.
import { describe, expect, it } from 'vitest'
import {
  heavySubagentSystemPromptAppend,
  modesSystemPromptAppend,
  terseSystemPromptAppend,
} from '@main/sessions/session-shaping'

describe('heavySubagentSystemPromptAppend', () => {
  it('adds nothing unless the setting is on', () => {
    expect(heavySubagentSystemPromptAppend(false)).toBeNull()
  })

  it('demands one batched dispatch, and names where fanning out is wrong', () => {
    const append = heavySubagentSystemPromptAppend(true)
    expect(append).toContain('FAN OUT BY DEFAULT')
    // Sequential single dispatches are the failure this instruction exists to stop.
    expect(append).toContain('ONE batch')
    // Without the counter-case it produces an agent spawned to read one line.
    expect(append).toContain('Do NOT fan out')
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

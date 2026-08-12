// What the app injects into every session: output-style appends and the
// Advisor/Orchestrator mode protocol.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adhdSystemPromptAppend,
  heavySubagentModelMode,
  heavySubagentSystemPromptAppend,
  modeAgents,
  modesSystemPromptAppend,
  sandboxSystemPromptAppend,
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

  it('never both forbids and mandates a closing summary on a default session', () => {
    // Default settings: terseMode true, terseLevel 'full', modelMode 'auto' — all three
    // fire together, so this is the combination an audit actually saw.
    const terse = terseSystemPromptAppend({ terseMode: true, terseLevel: 'full' }) ?? ''
    const modes = modesSystemPromptAppend('auto')
    expect(terse).not.toMatch(/no closing summary/i)
    expect(modes).toContain('ONE SUMMARY')
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

describe('adhdSystemPromptAppend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-adhd-'))
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    rmSync(join(dir, '.i-have-adhd-always'), { force: true })
  })

  it('returns null when the flag file is absent', () => {
    expect(adhdSystemPromptAppend()).toBeNull()
  })

  it('shares one output-style header with terse mode, not a competing one', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.i-have-adhd-always'), '')
    const adhd = adhdSystemPromptAppend() ?? ''
    const terse = terseSystemPromptAppend({ terseMode: true, terseLevel: 'lite' }) ?? ''
    // Same header text, not a second "THIS OVERRIDES" claim competing with it.
    const sharedHeader = 'MANDATORY OUTPUT STYLE — THIS OVERRIDES DEFAULT VERBOSITY AND FORMATTING.'
    expect(adhd).toContain(sharedHeader)
    expect(terse).toContain(sharedHeader)
    expect(adhd).not.toContain('ADHD READER')
  })

  it('routes the preserve rule through the shared constant instead of restating it', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.i-have-adhd-always'), '')
    const adhd = adhdSystemPromptAppend() ?? ''
    expect(adhd).toContain('Never abbreviate, reword, or omit code')
  })

  it('does not both mandate restating progress and forbid recaps', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.i-have-adhd-always'), '')
    const adhd = adhdSystemPromptAppend() ?? ''
    expect(adhd).not.toMatch(/restate progress/i)
    expect(adhd).toContain('No preamble, no recaps, no closers')
  })
})

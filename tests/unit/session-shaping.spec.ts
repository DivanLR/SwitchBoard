import { describe, expect, it } from 'vitest'
import {
  heavySubagentSystemPromptAppend,
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

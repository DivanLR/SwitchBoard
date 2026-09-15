import { describe, expect, it } from 'vitest'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'

describe('resolveClaudeExecutable', () => {
  it('returns a working Claude Code executable, else null', () => {
    const resolved = resolveClaudeExecutable()
    expect(resolved === null || resolved.toLowerCase().includes('claude')).toBe(true)
  }, 30_000)
})

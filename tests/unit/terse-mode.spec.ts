// Terse output mode instruction builder.
import { describe, expect, it } from 'vitest'
import { terseSystemPromptAppend } from '@main/sessions/terse-mode'

describe('terseSystemPromptAppend', () => {
  it('returns null when terse mode is off', () => {
    expect(terseSystemPromptAppend({ terseMode: false, terseLevel: 'full' })).toBeNull()
  })

  it('returns a level-specific instruction when on', () => {
    const lite = terseSystemPromptAppend({ terseMode: true, terseLevel: 'lite' })
    const full = terseSystemPromptAppend({ terseMode: true, terseLevel: 'full' })
    const ultra = terseSystemPromptAppend({ terseMode: true, terseLevel: 'ultra' })
    expect(lite).toContain('lite')
    expect(full).toContain('OUTPUT STYLE')
    expect(ultra).toContain('ultra')
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

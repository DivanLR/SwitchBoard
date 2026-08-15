// A diff comment that is carried out rather than recorded. The prompt is the
// whole safety surface: it is handed to a session with the working tree mounted
// read-write, so what it forbids matters as much as what it asks for.
import { describe, expect, it } from 'vitest'
import { applyToRegionPrompt } from '@shared/diff-apply'

const REGION = ['-  const timeout = 500', '+  const timeout = 5000', '   return timeout']

describe('applyToRegionPrompt', () => {
  it('names the file, the instruction and the region verbatim', () => {
    const prompt = applyToRegionPrompt({
      path: 'src/main/net.ts',
      lines: REGION,
      instruction: 'make this configurable',
    })
    expect(prompt).toContain('src/main/net.ts')
    expect(prompt).toContain('make this configurable')
    for (const line of REGION) expect(prompt).toContain(line)
  })

  // The markers say which side of the change each line is on, which is what makes
  // "revert this" meaningful. They must not be mistaken for file content.
  it('keeps the diff markers and says they are not part of the file', () => {
    const prompt = applyToRegionPrompt({
      path: 'a.ts',
      lines: REGION,
      instruction: 'x',
    })
    expect(prompt).toContain('+  const timeout = 5000')
    // Whitespace-tolerant: the sentence wraps, and where it wraps is not a
    // contract worth asserting.
    expect(prompt).toMatch(/not part of\s+the file/i)
  })

  // Each of these is a real failure mode of a general session handed a region.
  it('forbids widening the change, and forbids answering instead of editing', () => {
    const prompt = applyToRegionPrompt({ path: 'a.ts', lines: REGION, instruction: 'x' })
    expect(prompt).toMatch(/Change only that region/i)
    expect(prompt).toMatch(/not by line number/i)
    expect(prompt).toMatch(/not reply with a description/i)
    expect(prompt).toMatch(/not open a plan/i)
  })

  it('trims the instruction so stray whitespace cannot start the message', () => {
    const prompt = applyToRegionPrompt({ path: 'a.ts', lines: ['+x'], instruction: '  tidy  ' })
    expect(prompt).toContain('\ntidy\n')
  })

  // A whole-file selection would otherwise paste thousands of lines into a prompt.
  it('caps a huge selection and says how much it left out', () => {
    const lines = Array.from({ length: 450 }, (_, i) => `+line ${i}`)
    const prompt = applyToRegionPrompt({ path: 'a.ts', lines, instruction: 'x' })
    expect(prompt).toContain('+line 399')
    expect(prompt).not.toContain('+line 400')
    expect(prompt).toContain('50 more selected lines')
  })

  it('says "line" rather than "lines" when exactly one is left out', () => {
    const lines = Array.from({ length: 401 }, (_, i) => `+line ${i}`)
    expect(applyToRegionPrompt({ path: 'a.ts', lines, instruction: 'x' })).toContain(
      '1 more selected line',
    )
  })
})

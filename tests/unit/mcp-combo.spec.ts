// Combination keys + scan-doc paths for the per-combo MCP scans.
import { describe, expect, it } from 'vitest'
import { comboDocRelPath, comboKey, comboSlug } from '@shared/mcp-combo'

describe('mcp combos', () => {
  it('keys are order-independent', () => {
    expect(comboKey(['postgres — production', 'github'])).toBe('github + postgres — production')
    expect(comboKey(['github', 'postgres — production'])).toBe(
      comboKey(['postgres — production', 'github']),
    )
  })

  it('slugs are filesystem-safe and stable across order', () => {
    expect(comboSlug(['postgres — production', 'github'])).toMatch(
      /^github\+postgres-production-[a-z0-9]+$/,
    )
    expect(comboSlug(['github', 'postgres — production'])).toBe(
      comboSlug(['postgres — production', 'github']),
    )
    expect(comboSlug([])).toBe('none')
  })

  it('names that sanitise identically still get distinct slugs', () => {
    expect(comboSlug(['postgres — production'])).not.toBe(comboSlug(['postgres production']))
  })

  it('doc paths live under .switchboard/scans/', () => {
    expect(comboDocRelPath(['a b', 'c'])).toMatch(/^\.switchboard\/scans\/a-b\+c-[a-z0-9]+\.md$/)
  })
})

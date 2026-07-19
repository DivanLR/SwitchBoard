// Claude executable resolution: the asar path fixup that makes the bundled
// CLI spawnable in a packaged build, and resolution in the dev tree.
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolveClaudeExecutable, toUnpacked } from '@main/sessions/claude-executable'

describe('toUnpacked', () => {
  it('rewrites an asar-internal path to its unpacked counterpart (windows)', () => {
    const input = 'C:\\app\\resources\\app.asar\\node_modules\\@anthropic-ai\\x\\claude.exe'
    expect(toUnpacked(input)).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\x\\claude.exe',
    )
  })

  it('rewrites posix asar paths', () => {
    expect(toUnpacked('/app/resources/app.asar/node_modules/@anthropic-ai/x/claude')).toBe(
      '/app/resources/app.asar.unpacked/node_modules/@anthropic-ai/x/claude',
    )
  })

  it('leaves already-unpacked paths untouched', () => {
    const p = '/app/resources/app.asar.unpacked/node_modules/@anthropic-ai/x/claude'
    expect(toUnpacked(p)).toBe(p)
  })

  it('leaves non-asar paths untouched', () => {
    const p = 'C:\\project\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
    expect(toUnpacked(p)).toBe(p)
  })
})

describe('resolveClaudeExecutable', () => {
  it('resolves the bundled standalone executable in the dev tree', () => {
    const resolved = resolveClaudeExecutable()
    // The platform CLI package is installed in this repo, so a real path is expected.
    expect(resolved).not.toBeNull()
    expect(existsSync(resolved as string)).toBe(true)
    expect(resolved as string).toMatch(/claude(\.exe)?$/)
  })
})

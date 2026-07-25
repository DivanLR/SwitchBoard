// The app drives the user's own native Claude Code install; nothing else is
// accepted, because the packaged build ships no CLI of its own.
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'

describe('resolveClaudeExecutable', () => {
  it('returns the native install path when present, else null', () => {
    const expected = join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    )
    const resolved = resolveClaudeExecutable()
    if (existsSync(expected)) {
      expect(resolved).toBe(expected)
    } else {
      expect(resolved).toBeNull()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { defaultShell, launchCommand } from '@main/terminal/pty-host'

describe('launchCommand', () => {
  it('types nothing for a plain shell', () => {
    expect(launchCommand('shell')).toBeNull()
  })

  it('never emits the PowerShell call operator', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const command = launchCommand(engine)
      if (command === null) continue
      expect(command.startsWith('&')).toBe(false)
      expect(command.trim()).not.toBe('')
    }
  })

  it('quotes the Claude path, which lives under a home directory that may have spaces', () => {
    const command = launchCommand('claude')
    if (command === null) return
    expect(command.startsWith('"')).toBe(true)
    expect(command.endsWith('"')).toBe(true)
  })

  it('launches Codex by name, so the shell resolves the shim spawn cannot', () => {
    const command = launchCommand('codex')
    if (command === null) return
    expect(command).toBe('codex')
  })
})

describe('defaultShell', () => {
  it('is the developer own shell, not a fixed one', () => {
    const shell = defaultShell()
    expect(shell.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      expect(shell.toLowerCase()).toContain('cmd')
    } else {
      expect(shell.startsWith('/')).toBe(true)
    }
  })
})

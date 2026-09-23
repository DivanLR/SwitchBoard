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
  }, 30_000)

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

  it('continues a Claude conversation with --resume and ignores ids that are not plain tokens', () => {
    expect(launchCommand('shell', 'abc-123')).toBeNull()
    const command = launchCommand('claude', 'abc-123')
    if (command !== null) expect(command.endsWith('" --resume abc-123')).toBe(true)
    const unsafe = launchCommand('claude', 'abc; rm -rf /')
    if (unsafe !== null) expect(unsafe).not.toContain('--resume')
  })

  it('continues a Codex thread with the resume subcommand', () => {
    const command = launchCommand('codex', 'thread-1')
    if (command === null) return
    expect(command).toBe('codex resume thread-1')
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

// What gets typed into a freshly opened terminal.
//
// The command goes to the shell `defaultShell()` returns — cmd.exe on Windows,
// $SHELL elsewhere — so it has to be valid in THOSE. It previously began with
// `&`, which is PowerShell's call operator: a syntax error in both of the shells
// this actually opens, so the Claude launch failed on every platform.
import { describe, expect, it } from 'vitest'
import { defaultShell, launchCommand } from '@main/terminal/pty-host'

describe('launchCommand', () => {
  it('types nothing for a plain shell', () => {
    expect(launchCommand('shell')).toBeNull()
  })

  it('never emits the PowerShell call operator', () => {
    // Both engines, whether or not either CLI is installed on this machine: the
    // only outcomes allowed are null, or a command the opened shell can run.
    for (const engine of ['claude', 'codex'] as const) {
      const command = launchCommand(engine)
      if (command === null) continue
      expect(command.startsWith('&')).toBe(false)
      expect(command.trim()).not.toBe('')
    }
  })

  it('quotes the Claude path, which lives under a home directory that may have spaces', () => {
    const command = launchCommand('claude')
    // Null when Claude is not installed on the machine running the suite; the
    // shape is only assertable when there is one.
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

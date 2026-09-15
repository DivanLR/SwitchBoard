import { expect, it } from 'vitest'
import { PtyHost } from '@main/terminal/pty-host'

it('runs a real shell, accepts input, restores scrollback and reports exit', async () => {
  let output = ''
  let exitCode: number | undefined
  const host = new PtyHost({
    onData: (_id, data) => {
      output += data
    },
    onExit: (_id, code) => {
      exitCode = code
    },
  })
  const input = {
    id: 'terminal-smoke',
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    engine: 'shell' as const,
  }
  try {
    expect(host.open(input).reused).toBe(false)
    host.write(
      input.id,
      process.platform === 'win32'
        ? 'set "SB_PTY_TEST=PTY_READY"\recho SWITCHBOARD_%SB_PTY_TEST%\r'
        : "printf 'SWITCHBOARD_%s\\n' PTY_READY\r",
    )
    await expect.poll(() => output, { timeout: 10_000 }).toContain('SWITCHBOARD_PTY_READY')
    host.resize(input.id, 120, 30)
    const reopened = host.open({ ...input, cols: 120, rows: 30 })
    expect(reopened.reused).toBe(true)
    expect(reopened.scrollback).toContain('SWITCHBOARD_PTY_READY')
    host.write(input.id, 'exit\r')
    await expect.poll(() => exitCode, { timeout: 10_000 }).toBe(0)
  } finally {
    host.closeAll()
  }
}, 25_000)

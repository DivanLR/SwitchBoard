import { spawn, type IPty } from '@lydell/node-pty'
import type { SessionEngine } from '@shared/domain'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'
import { resolveCodexExecutable } from '@main/sessions/codex-executable'

export interface PtyCallbacks {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

interface LiveTerminal {
  pty: IPty
  scrollback: string
  cwd: string
}

const SCROLLBACK_LIMIT = 200_000

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

export function launchCommand(engine: SessionEngine | 'shell'): string | null {
  if (engine === 'shell') return null
  if (engine === 'codex') return resolveCodexExecutable() ? 'codex' : null
  const claude = resolveClaudeExecutable()
  return claude ? `& "${claude}"` : null
}

export class PtyHost {
  private terminals = new Map<string, LiveTerminal>()

  constructor(private callbacks: PtyCallbacks) {}

  open(input: {
    id: string
    cwd: string
    cols: number
    rows: number
    engine: SessionEngine | 'shell'
  }): { scrollback: string; reused: boolean } {
    const existing = this.terminals.get(input.id)
    if (existing) {
      existing.pty.resize(Math.max(2, input.cols), Math.max(2, input.rows))
      return { scrollback: existing.scrollback, reused: true }
    }
    const pty = spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cols: Math.max(2, input.cols),
      rows: Math.max(2, input.rows),
      cwd: input.cwd,
      env: { ...process.env } as Record<string, string>,
    })
    const terminal: LiveTerminal = { pty, scrollback: '', cwd: input.cwd }
    this.terminals.set(input.id, terminal)
    pty.onData((data) => {
      terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT)
      this.callbacks.onData(input.id, data)
    })
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(input.id)
      this.callbacks.onExit(input.id, exitCode)
    })
    const command = launchCommand(input.engine)
    if (command) pty.write(`${command}\r`)
    return { scrollback: '', reused: false }
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.pty.resize(Math.max(2, cols), Math.max(2, rows))
  }

  close(id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    this.terminals.delete(id)
    terminal.pty.kill()
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}

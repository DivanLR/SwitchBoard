import { spawn, type IPty } from '@lydell/node-pty'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'

interface PtyCallbacks {
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

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

export function launchCommand(engine: 'claude' | 'shell', resumeSessionId?: string): string | null {
  if (engine === 'shell') return null
  const resume = resumeSessionId && SAFE_SESSION_ID.test(resumeSessionId) ? resumeSessionId : null
  const claude = resolveClaudeExecutable()
  if (!claude) return null
  return resume ? `"${claude}" --resume ${resume}` : `"${claude}"`
}

export class PtyHost {
  private terminals = new Map<string, LiveTerminal>()

  constructor(private callbacks: PtyCallbacks) {}

  open(input: {
    id: string
    cwd: string
    cols: number
    rows: number
    engine: 'claude' | 'shell'
    resumeSessionId?: string
  }): { scrollback: string; reused: boolean } {
    const existing = this.terminals.get(input.id)
    if (existing) {
      this.resize(input.id, input.cols, input.rows)
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
      if (this.terminals.get(input.id) !== terminal) return
      terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT)
      this.callbacks.onData(input.id, data)
    })
    pty.onExit(({ exitCode }) => {
      if (this.terminals.get(input.id) !== terminal) return
      this.terminals.delete(input.id)
      this.callbacks.onExit(input.id, exitCode)
    })
    const command = launchCommand(input.engine, input.resumeSessionId)
    if (command) pty.write(`${command}\r`)
    return { scrollback: '', reused: false }
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const pty = this.terminals.get(id)?.pty
    const next = { cols: Math.max(2, cols), rows: Math.max(2, rows) }
    if (!pty || (pty.cols === next.cols && pty.rows === next.rows)) return
    pty.resize(next.cols, next.rows)
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

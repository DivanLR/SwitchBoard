// Real terminals, one per project.
//
// WHY THIS EXISTS ALONGSIDE THE SESSION STREAM: the session views reconstruct a
// terminal from normalised events, which is what makes the permission inbox, the
// diff panel and the stored transcript possible — but it is a reconstruction,
// and no reconstruction is the CLI's own interface. This is: a pseudo-terminal
// running the developer's real shell, rendered by a real terminal emulator, so
// what the Terminal tab shows is what a terminal shows, character for character.
//
// WHAT IT DOES NOT DO, deliberately: nothing here is parsed, classified,
// gated or stored. A command run in this terminal does not reach the permission
// inbox, because there is no protocol to intercept — the developer is talking to
// a shell on their own machine, exactly as they would in any other terminal
// window. The session stream remains the place where approvals and history live.
import { spawn, type IPty } from '@lydell/node-pty'
import type { SessionEngine } from '@shared/domain'
import { resolveClaudeExecutable } from '@main/sessions/claude-executable'
import { codexInstalled } from '@main/sessions/codex-executable'

export interface PtyCallbacks {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

interface LiveTerminal {
  pty: IPty
  /** Everything written so far, so re-opening the tab redraws what is on screen. */
  scrollback: string
  cwd: string
}

/**
 * How much output is replayed when the tab is re-opened.
 *
 * ponytail: a flat character budget, trimmed from the front. A real terminal
 * emulator keeps a line-based scrollback with its own buffer; this only has to
 * survive a tab switch. Raise it, or move the buffer into the renderer's own
 * xterm instance, if someone needs real history here.
 */
const SCROLLBACK_LIMIT = 200_000

/** The shell a terminal opens, the developer's own rather than a fixed one. */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

/**
 * The command typed into a fresh terminal for an engine, or null to leave the
 * developer at a bare shell prompt.
 *
 * The CLI is launched through the shell rather than spawned as the pty's own
 * process, so that when it exits the developer still has a terminal instead of a
 * pane that closed itself. On Windows the Codex launcher is a `.cmd` shim, which
 * only a shell can run — another reason the shell is the pty's process.
 */
export function launchCommand(engine: SessionEngine | 'shell'): string | null {
  if (engine === 'shell') return null
  // `codex` by name, not by resolved path: this goes to a SHELL, which finds it
  // on the PATH and can run the `.cmd` shim that `spawn` cannot (see
  // codex-executable.ts for why the spawn path needs more than a name).
  if (engine === 'codex') return codexInstalled() ? 'codex' : null
  const claude = resolveClaudeExecutable()
  if (!claude) return null
  // Quoted, because the Claude executable lives under the user's home directory
  // and that routinely contains a space. No leading `&`: that is PowerShell's
  // call operator, and defaultShell() returns cmd.exe on Windows and sh
  // elsewhere, where a bare `&` is a syntax error that kills the launch. A
  // quoted path on its own line is how both of those shells run a program.
  return `"${claude}"`
}

export class PtyHost {
  private terminals = new Map<string, LiveTerminal>()

  constructor(private callbacks: PtyCallbacks) {}

  /**
   * Open a terminal, or return what is already on screen for one that is open.
   *
   * Re-opening is the common case — the tab is switched away from and back — so
   * an existing terminal is never restarted: doing so would kill whatever the
   * developer had running in it.
   */
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
      // Same ownership rule as onExit below: a replaced pty's last bytes must not
      // be pushed into the pane now showing its successor.
      if (this.terminals.get(input.id) !== terminal) return
      terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT)
      this.callbacks.onData(input.id, data)
    })
    pty.onExit(({ exitCode }) => {
      // Only if this pty is still the one mapped to that id. `kill()` is
      // asynchronous and the Terminal tab's restart closes and immediately
      // reopens the same id, so a dead pty's exit can land after its replacement
      // is in the map — deleting it there would leave every later write, resize
      // and close silently targeting nothing.
      if (this.terminals.get(input.id) !== terminal) return
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
    // A zero or negative dimension is what a hidden pane reports mid-transition;
    // ConPTY rejects it outright, so clamp rather than pass it through.
    this.terminals.get(id)?.pty.resize(Math.max(2, cols), Math.max(2, rows))
  }

  close(id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    this.terminals.delete(id)
    terminal.pty.kill()
  }

  /** Every terminal, killed on app quit so no shell outlives the window. */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}

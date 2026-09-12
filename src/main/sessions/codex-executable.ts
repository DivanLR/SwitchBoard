// Resolves the Codex CLI this app drives, and answers whether it is installed.
//
// Unlike the Claude executable (a standalone binary at a known path, see
// claude-executable.ts), Codex ships as an npm package whose launcher is a shim:
// `codex.cmd` on Windows, `codex` elsewhere. The shim is a script, so it is
// spawned through the resolved absolute path rather than through a shell —
// passing a prompt as an argument to a shell is how a command substitution in
// someone's message becomes a command this app ran.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Launcher names, most specific first: on Windows the .cmd shim is the one that runs. */
function launcherNames(): string[] {
  return process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
}

/**
 * The Codex launcher's absolute path, or null when it is not installed.
 *
 * PATH is searched directly rather than shelling out to `where`/`which`: the
 * answer is a file test, and spawning a process to ask is both slower and one
 * more thing that can fail differently on a locked-down machine.
 */
export function resolveCodexExecutable(): string | null {
  const names = launcherNames()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  // The npm global bin is not always on the PATH a packaged Electron app
  // inherits, and it is where `npm i -g @openai/codex` puts the shim.
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  if (process.env.HOME) dirs.push(join(process.env.HOME, '.local', 'bin'))
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** What to tell the developer when a Codex session is asked for and no CLI exists. */
export const CODEX_MISSING_MESSAGE =
  'The Codex CLI was not found. Install it with `npm i -g @openai/codex` and sign in with `codex login`, then start the session again.'

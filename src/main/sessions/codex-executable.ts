// Resolves how to launch the Codex CLI, and answers whether it is installed.
//
// NOT just a path. Codex ships as an npm package, and on Windows what npm puts
// on the PATH is `codex.cmd` — a batch shim, which Node's `spawn` REFUSES to
// execute without `shell: true` (EINVAL, from the hardening added for
// CVE-2024-27980). So a resolver returning a bare path cannot be used: the
// caller would have to pass `shell: true`, and a prompt handed to a shell is how
// a command substitution in someone's message becomes a command this app ran.
//
// What is returned instead is a shell-free launch spec: the executable, the
// arguments that must precede the caller's own, and the environment it needs.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface CodexLaunch {
  /** The executable to spawn. Never a `.cmd`/`.bat` shim. */
  command: string
  /** Arguments that must come before the caller's own. */
  prefixArgs: string[]
  /** Environment additions the launcher needs, merged over `process.env`. */
  env: Record<string, string>
}

/** PATH, then the bin directories a packaged Electron app does not always
 *  inherit on its PATH but where a global npm install puts things. */
function candidateDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  if (process.env.HOME) dirs.push(join(process.env.HOME, '.local', 'bin'))
  return dirs
}

/**
 * How to launch Codex, or null when it is not installed.
 *
 * A real executable is preferred wherever one exists, because it needs nothing
 * explained. The package's own JavaScript entry point is the fallback, and on
 * Windows it is the case that actually fires for a standard
 * `npm i -g @openai/codex`, since the only other thing there is the batch shim.
 *
 * `ELECTRON_RUN_AS_NODE` is what makes that fallback work: under Electron
 * `process.execPath` is the Electron binary, so handing it a script would start
 * a second Electron rather than run the script. The variable makes that same
 * binary behave as plain Node for the child. (The Claude resolver sidesteps this
 * question entirely by spawning a standalone binary — claude-executable.ts.)
 */
export function resolveCodexLaunch(): CodexLaunch | null {
  const direct = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const dir of candidateDirs()) {
    const executable = join(dir, direct)
    if (existsSync(executable)) return { command: executable, prefixArgs: [], env: {} }
    // The npm shim's sibling: <prefix>/codex.cmd sits next to
    // <prefix>/node_modules/@openai/codex/bin/codex.js.
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(entry)) {
      return { command: process.execPath, prefixArgs: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }
  return null
}

/** Whether Codex can be launched at all. Checked before a session row is written,
 *  so a missing CLI is reported rather than left on screen claiming to work. */
export function codexInstalled(): boolean {
  return resolveCodexLaunch() !== null
}

/** What to tell the developer when a Codex session is asked for and no CLI exists. */
export const CODEX_MISSING_MESSAGE =
  'The Codex CLI was not found. Install it with `npm i -g @openai/codex` and sign in with `codex login`, then start the session again.'

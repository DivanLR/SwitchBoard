import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface CodexLaunch {
  command: string
  prefixArgs: string[]
  env: Record<string, string>
}

function candidateDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  if (process.env.HOME) dirs.push(join(process.env.HOME, '.local', 'bin'))
  return dirs
}

export function resolveCodexLaunch(): CodexLaunch | null {
  const direct = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const dir of candidateDirs()) {
    const executable = join(dir, direct)
    if (existsSync(executable)) return { command: executable, prefixArgs: [], env: {} }
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(entry)) {
      return { command: process.execPath, prefixArgs: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }
  return null
}

export function codexInstalled(): boolean {
  return resolveCodexLaunch() !== null
}

export const CODEX_MISSING_MESSAGE =
  'The Codex CLI was not found. Install it with `npm i -g @openai/codex` and sign in with `codex login`, then start the session again.'

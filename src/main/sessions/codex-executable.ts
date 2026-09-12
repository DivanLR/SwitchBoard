import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

function launcherNames(): string[] {
  return process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
}

export function resolveCodexExecutable(): string | null {
  const names = launcherNames()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
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

export const CODEX_MISSING_MESSAGE =
  'The Codex CLI was not found. Install it with `npm i -g @openai/codex` and sign in with `codex login`, then start the session again.'

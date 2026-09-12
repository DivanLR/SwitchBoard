import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveClaudeExecutable(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidate = join(homedir(), '.local', 'bin', exe)
  return existsSync(candidate) ? candidate : null
}

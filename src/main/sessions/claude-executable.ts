import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

let found: string | null = null

export function resolveClaudeExecutable(): string | null {
  if (found && existsSync(found)) return found
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [join(homedir(), '.local', 'bin', exe)]

  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    )
  }

  found = candidates.find((candidate) => isClaudeCodeExecutable(candidate)) ?? null
  return found
}

function isClaudeCodeExecutable(candidate: string): boolean {
  if (!existsSync(candidate)) return false
  try {
    const version = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    return /Claude Code/i.test(version)
  } catch {
    return false
  }
}

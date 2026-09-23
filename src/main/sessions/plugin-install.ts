import { execFile } from 'node:child_process'
import type { IpcError } from '@shared/ipc-types'
import { resolveClaudeExecutable } from './claude-executable'

const INSTALL_TIMEOUT_MS = 120_000

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export function run(exe: string, args: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      { cwd, timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: number | null } | null)?.code ?? 0
        if (error && typeof code !== 'number') {
          reject(error)
          return
        }
        resolve({ code, stdout, stderr })
      },
    )
    child.stdin?.end()
  })
}

export function reason(result: RunResult): string {
  const text = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z0-9]/.test(line))
  return text.at(-1) ?? `exit code ${result.code}`
}

export async function installPlugin(marketplace: string, pkg: string): Promise<void> {
  const exe = resolveClaudeExecutable()
  if (!exe) {
    throw {
      code: 'NOT_FOUND',
      message:
        'Claude Code was not found. Install it from https://claude.com/claude-code, then try again.',
    } satisfies IpcError
  }

  try {
    await run(exe, ['plugin', 'marketplace', 'add', marketplace])
  } catch (error) {
    throw {
      code: 'INTERNAL',
      message: `Could not run the Claude Code CLI: ${(error as Error).message}`,
    } satisfies IpcError
  }

  const installed = await run(exe, ['plugin', 'install', pkg, '--scope', 'user'])
  if (installed.code !== 0) {
    throw {
      code: 'INTERNAL',
      message: `Installing ${pkg} failed: ${reason(installed)}`,
    } satisfies IpcError
  }
}

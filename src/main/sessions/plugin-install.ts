import { execFile } from 'node:child_process'
import type { IpcError } from '@shared/ipc-types'
import { resolveClaudeExecutable } from './claude-executable'

const INSTALL_TIMEOUT_MS = 120_000

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export function run(exe: string, args: readonly string[], cwd?: string, input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      {
        cwd,
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'string') {
          reject(error)
          return
        }
        const timedOut = error?.killed === true || Boolean(error?.signal)
        resolve({ code: error ? (typeof code === 'number' ? code : null) : 0, stdout, stderr, ...(timedOut ? { timedOut } : {}) })
      },
    )
    child.stdin?.end(input)
  })
}

export function reason(result: RunResult): string {
  if (result.timedOut) return `It timed out after ${INSTALL_TIMEOUT_MS / 1000} seconds and was stopped.`
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

// Installing a plugin, on the host, with the CLI's own non-interactive commands.
//
// This replaced sending `/plugin marketplace add …` and `/plugin install …` to a
// session as chat messages, which could not work for three independent reasons,
// each sufficient on its own:
//
//  1. `/plugin` is an interactive CLI command. An Agent SDK session answers it
//     with "/plugin isn't available in this environment", so the install never
//     ran at all.
//  2. The two messages were dispatched through two separate `runInSession`
//     calls, and on a project with no prior background work each call started
//     its OWN container. The marketplace was registered in one container's home
//     volume and the install ran in another's, which is empty. The volumes are
//     per session and nothing maps one into another, so they could never agree.
//  3. A containerised session cannot see host plugins in any case: the only
//     thing mounted from ~/.claude is .credentials.json, read-only.
//
// `claude plugin marketplace add` and `claude plugin install` are ordinary
// non-interactive subcommands, so the app runs them directly and waits for an
// exit code. One process, one home, one answer, and a real error when it fails.
import { execFile } from 'node:child_process'
import type { IpcError } from '@shared/ipc-types'
import { resolveClaudeExecutable } from './claude-executable'

/** The CLI is a ~250 MB standalone binary and a marketplace add clones a repo. */
const INSTALL_TIMEOUT_MS = 120_000

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(exe: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A non-zero exit arrives here as an error carrying its own code; that is
        // a result to report, not a failure to run. Only a spawn failure (no such
        // binary, timeout killed it) has no code at all.
        const code = (error as { code?: number | null } | null)?.code ?? 0
        if (error && typeof code !== 'number') {
          reject(error)
          return
        }
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** The last non-empty line, which is where the CLI puts the reason it refused. */
function reason(result: RunResult): string {
  const text = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return text.at(-1) ?? `exit code ${result.code}`
}

/**
 * Register the marketplace, then install the plugin from it.
 *
 * Sequential and in one process on purpose: `plugin install <pkg>@<marketplace>`
 * resolves the package through a marketplace that must already be registered, so
 * the order is a dependency rather than a preference.
 *
 * A marketplace that is already registered is not an error. The CLI reports that
 * case on its own exit code, and re-adding it on every install would be the
 * normal path, not the exception, so the step is allowed to fail SOFTLY and the
 * install below is what decides the outcome. If the marketplace genuinely could
 * not be added, the install fails immediately afterwards and reports why.
 */
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

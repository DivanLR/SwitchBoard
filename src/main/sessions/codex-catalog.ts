// The Codex models this account can select, read from the CLI rather than a
// hardcoded list — the same rule model-catalog.ts follows for Claude, for the
// same reason: a model released next month should appear in Settings without a
// release of this app, and a retired one should disappear.
//
// The source is the Codex app server's `model/list` method (`codex app-server`,
// JSON-RPC over stdio). `codex exec` has no model-listing flag, so this is the
// only way to ask the CLI itself instead of inventing an answer.
import { spawn } from 'node:child_process'
import type { AvailableModel } from '@shared/domain'
import { resolveCodexExecutable } from './codex-executable'

/** The fields of a reported model this app reads. A subset, because the report
 *  crosses a process boundary as JSON and the protocol is still marked
 *  experimental: a newer CLI may add fields, an older one may omit them. */
interface ReportedCodexModel {
  id?: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
}

/**
 * Map a `model/list` result to the selectable list, keyed by id so a paginated
 * repeat collapses to one row. Models the CLI marks `hidden` are left out: they
 * are hidden from its own picker, and offering them here would mean this app
 * claims a model the CLI would then refuse.
 */
export function toCodexModels(models: readonly ReportedCodexModel[]): AvailableModel[] {
  const byId = new Map<string, AvailableModel>()
  for (const model of models) {
    if (model.hidden === true) continue
    const id = model.id ?? model.model
    if (!id || byId.has(id)) continue
    byId.set(id, {
      id,
      label: model.displayName ?? id,
      description: model.description ?? '',
      engine: 'codex',
    })
  }
  return [...byId.values()]
}

// The app server boots a Rust binary and reads the user's config; generous for
// the same reason the Claude probe is.
const PROBE_TIMEOUT_MS = 30_000

/**
 * Ask the Codex CLI which models it offers. Returns an empty list when Codex is
 * not installed, is too old to serve `model/list`, or does not answer in time —
 * the caller keeps whatever it already had, exactly as the Claude probe behaves.
 */
export async function probeCodexModels(): Promise<AvailableModel[]> {
  const executable = resolveCodexExecutable()
  if (!executable) return []
  return new Promise<AvailableModel[]>((resolve) => {
    const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let settled = false
    const finish = (models: AvailableModel[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(models)
    }
    const timer = setTimeout(() => finish([]), PROBE_TIMEOUT_MS)
    timer.unref()

    child.on('error', () => finish([]))
    child.on('exit', () => finish([]))
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: { id?: number; result?: { data?: ReportedCodexModel[] } }
        try {
          message = JSON.parse(line)
        } catch {
          continue // The server also emits notifications; a partial line is not an error.
        }
        // 1 = initialize answered, so the session is ready for a real request.
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: {} })}\n`)
        } else if (message.id === 2) {
          finish(toCodexModels(message.result?.data ?? []))
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'switchboard', version: '1', title: 'Switchboard' } },
      })}\n`,
    )
  })
}

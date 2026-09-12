import { spawn } from 'node:child_process'
import type { AvailableModel } from '@shared/domain'
import { resolveCodexExecutable } from './codex-executable'

interface ReportedCodexModel {
  id?: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
}

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

const PROBE_TIMEOUT_MS = 30_000

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
          continue 
        }
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

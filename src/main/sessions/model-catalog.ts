import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { modelAlias, modelFamily, modelLabel, type AvailableModel } from '@shared/domain'
import { resolveClaudeExecutable } from './claude-executable'

type ReportedModel = Pick<ModelInfo, 'value'> &
  Partial<Pick<ModelInfo, 'resolvedModel' | 'displayName' | 'description'>>

function versionOf(id: string): number[] {
  return id
    .replace(/\[1m\]/i, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter((part) => /^\d+$/.test(part))
    .map(Number)
}

function newer(a: string, b: string): boolean {
  const x = versionOf(a)
  const y = versionOf(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const gap = (x[i] ?? 0) - (y[i] ?? 0)
    if (gap !== 0) return gap > 0
  }
  return false
}

export function toAvailableModels(models: readonly ReportedModel[]): AvailableModel[] {
  const latest = new Map<string, { resolved: string; model: AvailableModel }>()
  for (const model of models) {
    if (model.value === 'default') continue
    const resolved = model.resolvedModel ?? model.value
    if (!resolved) continue
    const family = modelFamily(resolved)
    const line = family ? `${family}${/\[1m\]/i.test(resolved) ? '[1m]' : ''}` : resolved
    const kept = latest.get(line)
    const preferred = newer(resolved, kept?.resolved ?? '') || (!newer(kept?.resolved ?? '', resolved) && model.value === modelAlias(resolved))
    if (kept && !preferred) continue
    latest.set(line, {
      resolved,
      model: { id: model.value, label: modelLabel(resolved), description: model.description ?? '', engine: 'claude' },
    })
  }
  return [...latest.values()].map((entry) => entry.model)
}

const PROBE_TIMEOUT_MS = 30_000

export async function probeAvailableModels(cwd: string): Promise<AvailableModel[]> {
  const claudeExecutablePath = resolveClaudeExecutable()
  const noPrompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }
  const q = query({
    prompt: noPrompt,
    options: {
      cwd,
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    },
  })
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('supportedModels timed out')), PROBE_TIMEOUT_MS).unref()
      }),
    ])
    return toAvailableModels(models)
  } catch {
    return []
  } finally {
    q.close()
  }
}

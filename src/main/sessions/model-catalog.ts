import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AvailableModel } from '@shared/domain'
import { resolveClaudeExecutable } from './claude-executable'

type ReportedModel = Pick<ModelInfo, 'value'> &
  Partial<Pick<ModelInfo, 'resolvedModel' | 'displayName' | 'description'>>

export function toAvailableModels(models: readonly ReportedModel[]): AvailableModel[] {
  const byId = new Map<string, AvailableModel>()
  for (const model of models) {
    if (model.value === 'default') continue
    const id = model.resolvedModel ?? model.value
    if (!id || byId.has(id)) continue
    byId.set(id, {
      id,
      label: model.displayName ?? id,
      description: model.description ?? '',
      engine: 'claude',
    })
  }
  return [...byId.values()]
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

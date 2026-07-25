// The models the subscription can actually select, read from the CLI instead of
// a hardcoded catalogue, so a newly released Claude model appears in Settings
// with no code change (and a retired one disappears).
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AvailableModel } from '@shared/domain'
import { resolveClaudeExecutable } from './claude-executable'

/** The fields of a reported model this app reads. Declared as a subset (rather
 *  than ModelInfo itself) because the report crosses a process boundary as JSON:
 *  an older or newer CLI may omit fields the current typings mark as required. */
type ReportedModel = Pick<ModelInfo, 'value'> &
  Partial<Pick<ModelInfo, 'resolvedModel' | 'displayName' | 'description'>>

/**
 * Map the SDK's supportedModels() report to the selectable list, keyed by the
 * canonical wire id so an alias row and a full-id row collapse to one. The
 * 'default' row is skipped: it is an alias for whichever model the account
 * defaults to, so keeping it would claim that model's id first and hide its real
 * row, and the picker already offers an "Account default" card of its own.
 */
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
    })
  }
  return [...byId.values()]
}

// Generous: the CLI is a ~250 MB standalone binary and a cold start is slow.
const PROBE_TIMEOUT_MS = 30_000

/**
 * Ask the CLI for its model list without starting a session, so Settings lists
 * the current models on a cold start (before any session has reported them). The
 * prompt never yields, so the CLI boots, answers the control request, and is
 * closed again without running a turn — no tokens are spent.
 */
export async function probeAvailableModels(cwd: string): Promise<AvailableModel[]> {
  const claudeExecutablePath = resolveClaudeExecutable()
  // A prompt stream that never produces a message, so no turn is ever started.
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
    // No CLI, an older CLI without the control request, or no answer in time:
    // the caller keeps whatever it already had.
    return []
  } finally {
    q.close()
  }
}

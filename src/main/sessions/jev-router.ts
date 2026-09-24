import { modelLabel } from '@shared/domain'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export const JEV_MODEL = 'jev-latest'

export const JEV_STATE_LIMIT = 8000

export const JEV_TIMEOUT_MS = 3000

export const JEV_MIN_CONFIDENCE = 0.6

export type JevTier = 'intelligent' | 'worker'

export type JevAnswer = { ok: true; tier: JevTier; confidence: number } | { ok: false; why: string }

export interface JevRoute {
  model: string
  switched: boolean
  note: string
}

const QUESTION = {
  type: 'choice',
  instructions:
    'Which model should answer this message? A developer sent it to a coding agent that can read and change their repository.',
  criteria: {
    intelligent:
      'Needs deep reasoning: design or architecture, a failure whose cause is unclear, changes across many files, ' +
      'security, concurrency or data migrations, vague requirements, or planning a feature.',
    worker:
      'Routine and well scoped: a small or mechanical edit, a rename, running a command or the tests, explaining or ' +
      'finding code, formatting, or a question with a clear answer.',
  },
}

const STATUS: Readonly<Record<number, string>> = {
  401: 'Jev rejected the API key',
  422: 'Jev refused the request',
  429: 'Jev is rate limiting this key',
  529: 'Jev is overloaded',
}

export async function askJev(
  apiKey: string,
  message: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = JEV_TIMEOUT_MS,
): Promise<JevAnswer> {
  try {
    const response = await fetcher(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: message.slice(0, JEV_STATE_LIMIT),
        model: JEV_MODEL,
        questions: { model: QUESTION },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, why: STATUS[response.status] ?? `Jev answered HTTP ${response.status}` }
    const body = (await response.json()) as { answers?: { model?: { choice?: unknown; confidence?: unknown } } }
    const answer = body.answers?.model
    const tier = answer?.choice === 'intelligent' || answer?.choice === 'worker' ? answer.choice : null
    const raw = answer?.confidence
    const confidence = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null
    if (!tier || confidence === null) return { ok: false, why: 'Jev gave no model choice' }
    return { ok: true, tier, confidence }
  } catch (error) {
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
    return { ok: false, why: timedOut ? `Jev did not answer within ${timeoutMs / 1000} s` : 'Jev could not be reached' }
  }
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`
}

export function jevRoute(input: {
  answer: JevAnswer
  current: string
  models: Readonly<Record<JevTier, string>>
  contextTokens: number | null
  limitTokens: number
}): JevRoute {
  const { answer, current, models, contextTokens, limitTokens } = input
  const keep = (note: string): JevRoute => ({ model: current, switched: false, note })
  if (!answer.ok) return keep(`${answer.why}, so the session stays on ${modelLabel(current)}.`)
  const wanted = models[answer.tier]
  const chose = `Jev chose ${modelLabel(wanted)} (${percent(answer.confidence)})`
  if (wanted === current) return keep(`${chose}.`)
  if (answer.confidence < JEV_MIN_CONFIDENCE) return keep(`${chose}, too unsure to leave ${modelLabel(current)}.`)
  if (contextTokens !== null && contextTokens >= limitTokens) {
    const held = Number.isFinite(contextTokens)
      ? `the context holds ${Math.round(contextTokens / 1000)}k tokens, over the ${Math.round(limitTokens / 1000)}k switch limit`
      : 'a resumed session keeps its model until its context size is known'
    return keep(`${chose}, but ${held}, so it stays on ${modelLabel(current)} and keeps its cache.`)
  }
  return { model: wanted, switched: true, note: `${chose}.` }
}

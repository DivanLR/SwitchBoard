import { describe, expect, it } from 'vitest'
import {
  JEV_ENDPOINT,
  JEV_MIN_CONFIDENCE,
  JEV_STATE_LIMIT,
  askJev,
  jevRoute,
  type JevAnswer,
} from '@main/sessions/jev-router'

type FetchArgs = { url: string; init: RequestInit }

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('askJev', () => {
  it('posts the state, the model and one choice question naming both tiers, with a bearer key', async () => {
    const calls: FetchArgs[] = []
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} })
      return fakeResponse(200, { answers: { model: { choice: 'worker', confidence: 0.8 } } })
    }
    const longMessage = 'x'.repeat(JEV_STATE_LIMIT + 500)
    const answer = await askJev('secret-key', longMessage, fetcher)

    expect(answer).toEqual({ ok: true, tier: 'worker', confidence: 0.8 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(JEV_ENDPOINT)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-key')
    const body = JSON.parse(calls[0].init.body as string) as {
      state: string
      model: string
      questions: { model: { type: string; criteria: { intelligent: string; worker: string } } }
    }
    expect(body.state).toHaveLength(JEV_STATE_LIMIT)
    expect(body.model).toBe('jev-latest')
    expect(body.questions.model.type).toBe('choice')
    expect(body.questions.model.criteria.intelligent).toBeTruthy()
    expect(body.questions.model.criteria.worker).toBeTruthy()
  })

  it('never puts the key anywhere in a failed answer', async () => {
    const key = 'sk-super-secret'
    const scenarios: (() => Promise<Response>)[] = [
      async () => fakeResponse(401, {}),
      async () => fakeResponse(422, {}),
      async () => fakeResponse(429, {}),
      async () => fakeResponse(529, {}),
      async () => fakeResponse(500, {}),
      async () => fakeResponse(200, { answers: {} }),
      async () => fakeResponse(200, { nonsense: true }),
      async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      },
      async () => {
        throw new TypeError('fetch failed')
      },
    ]
    for (const respond of scenarios) {
      const answer = await askJev(key, 'hello', respond)
      expect(answer.ok).toBe(false)
      expect(JSON.stringify(answer)).not.toContain(key)
    }
  })

  it('names the reason for each HTTP status', async () => {
    const fetcherFor = (status: number) => async () => fakeResponse(status, {})
    expect(await askJev('k', 'm', fetcherFor(401))).toEqual({ ok: false, why: 'Jev rejected the API key' })
    expect(await askJev('k', 'm', fetcherFor(422))).toEqual({ ok: false, why: 'Jev refused the request' })
    expect(await askJev('k', 'm', fetcherFor(429))).toEqual({ ok: false, why: 'Jev is rate limiting this key' })
    expect(await askJev('k', 'm', fetcherFor(529))).toEqual({ ok: false, why: 'Jev is overloaded' })
    expect(await askJev('k', 'm', fetcherFor(503))).toEqual({ ok: false, why: 'Jev answered HTTP 503' })
  })

  it('reports a malformed body as no model choice', async () => {
    expect(await askJev('k', 'm', async () => fakeResponse(200, { answers: {} }))).toEqual({
      ok: false,
      why: 'Jev gave no model choice',
    })
    expect(
      await askJev('k', 'm', async () => fakeResponse(200, { answers: { model: { choice: 'worker' } } })),
    ).toEqual({ ok: false, why: 'Jev gave no model choice' })
    expect(
      await askJev('k', 'm', async () => fakeResponse(200, { answers: { model: { choice: 'bogus', confidence: 0.9 } } })),
    ).toEqual({ ok: false, why: 'Jev gave no model choice' })
  })

  it('clamps a confidence outside 0 to 1 and rejects one that is not a finite number', async () => {
    const answer = (confidence: unknown): Promise<unknown> =>
      askJev('k', 'm', async () => fakeResponse(200, { answers: { model: { choice: 'worker', confidence } } }))
    expect(await answer(1.7)).toEqual({ ok: true, tier: 'worker', confidence: 1 })
    expect(await answer(-0.4)).toEqual({ ok: true, tier: 'worker', confidence: 0 })
    expect(await answer(Number.NaN)).toEqual({ ok: false, why: 'Jev gave no model choice' })
  })

  it('names a timeout distinctly from any other network error', async () => {
    const timeoutFetcher = async (): Promise<Response> => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }
    expect(await askJev('k', 'm', timeoutFetcher, 3000)).toEqual({
      ok: false,
      why: 'Jev did not answer within 3 s',
    })

    const networkFetcher = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    expect(await askJev('k', 'm', networkFetcher)).toEqual({ ok: false, why: 'Jev could not be reached' })
  })
})

describe('jevRoute', () => {
  const models = { intelligent: 'claude-opus-5', worker: 'claude-sonnet-5' }
  const base = { current: 'claude-opus-5', models, contextTokens: null as number | null, limitTokens: 60_000 }

  it('keeps the model and names why, when Jev could not answer', () => {
    const answer: JevAnswer = { ok: false, why: 'Jev could not be reached' }
    expect(jevRoute({ ...base, answer })).toEqual({
      model: 'claude-opus-5',
      switched: false,
      note: 'Jev could not be reached, so the session stays on Opus 5.',
    })
  })

  it('keeps the model when Jev picks the tier already running', () => {
    const answer: JevAnswer = { ok: true, tier: 'intelligent', confidence: 0.9 }
    expect(jevRoute({ ...base, answer })).toEqual({
      model: 'claude-opus-5',
      switched: false,
      note: 'Jev chose Opus 5 (90%).',
    })
  })

  it('keeps the model when confidence is under the minimum', () => {
    const answer: JevAnswer = { ok: true, tier: 'worker', confidence: JEV_MIN_CONFIDENCE - 0.01 }
    const route = jevRoute({ ...base, answer })
    expect(route.model).toBe('claude-opus-5')
    expect(route.switched).toBe(false)
    expect(route.note).toContain('too unsure to leave Opus 5')
  })

  it('keeps the model, and its cache, once the context is at or over the switch limit', () => {
    const answer: JevAnswer = { ok: true, tier: 'worker', confidence: 0.9 }
    const route = jevRoute({ ...base, answer, contextTokens: 61_000 })
    expect(route.model).toBe('claude-opus-5')
    expect(route.switched).toBe(false)
    expect(route.note).toContain('61k tokens, over the 60k switch limit')
    expect(route.note).toContain('keeps its cache')
  })

  it('keeps the model for a resumed session whose context size is not yet known', () => {
    const answer: JevAnswer = { ok: true, tier: 'worker', confidence: 0.9 }
    const route = jevRoute({ ...base, answer, contextTokens: Number.POSITIVE_INFINITY })
    expect(route.model).toBe('claude-opus-5')
    expect(route.switched).toBe(false)
    expect(route.note).toContain('a resumed session keeps its model until its context size is known')
  })

  it('switches when Jev is confident, picks the other tier, and the context is under the limit', () => {
    const answer: JevAnswer = { ok: true, tier: 'worker', confidence: 0.86 }
    expect(jevRoute({ ...base, answer, contextTokens: 10_000 })).toEqual({
      model: 'claude-sonnet-5',
      switched: true,
      note: 'Jev chose Sonnet 5 (86%).',
    })
  })
})

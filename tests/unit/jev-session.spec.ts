import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, EventKind, EventPayloadMap, ModelMode, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'
import type { JevAnswer, JevRoute } from '@main/sessions/jev-router'

function makeJevSession(options: {
  askJev?: (text: string) => Promise<JevAnswer>
  jevSwitchLimit?: number
} = {}) {
  const routing = {
    intelligentModel: 'claude-opus-5',
    workerModel: 'claude-sonnet-5',
    modelMode: 'jev' as ModelMode,
    autoModelRouting: true,
    effort: 'xhigh' as EffortLevel,
    jevSwitchLimit: options.jevSwitchLimit ?? 60,
  }
  const setModelCalls: (string | undefined)[] = []
  const turnModes: ('advisor' | 'orchestrator' | null)[] = []
  const routes: (JevRoute | null)[] = []
  const updateCalls: { eventId: string; pending: boolean; withdrawn?: boolean }[] = []
  const sink = {
    append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
      return {
        id: 'e', sessionId: 's', seq: 1, kind, payload, noiseKind: null, createdAt: '',
      } as SessionEvent<K>
    },
    update(...args: unknown[]): void {
      const [eventId, payload] = args as [string, { pending?: boolean; withdrawn?: boolean }]
      updateCalls.push({ eventId, pending: payload.pending ?? false, ...(payload.withdrawn ? { withdrawn: true } : {}) })
    },
  }
  const session = new HostedSession({
    sessionId: 's1',
    mode: 'auto',
    projectPath: '.',
    mainModel: routing.intelligentModel,
    autoModelRouting: true,
    modelMode: 'jev',
    resolveModels: () => ({ ...routing }),
    onTurnMode: (turnMode) => turnModes.push(turnMode),
    askJev: options.askJev,
    onRoute: (route) => routes.push(route),
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
  ;(session as unknown as { q: unknown }).q = {
    setModel: (model?: string) => {
      setModelCalls.push(model)
      return Promise.resolve()
    },
    applyFlagSettings: () => Promise.resolve(),
    interrupt: () => Promise.resolve(),
  }
  const inner = session as unknown as {
    deliverNow(eventId: string, text: string): void
    handleMessage(m: SDKMessage): void
  }
  let sent = 0
  const send = (text: string): string => {
    const eventId = `e-${sent}`
    sent += 1
    inner.deliverNow(eventId, text)
    return eventId
  }
  const feed = (m: unknown): void => inner.handleMessage(m as SDKMessage)
  return { session, routing, setModelCalls, turnModes, routes, updateCalls, send, feed }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const usageMessage = (tokens: number, model = 'claude-sonnet-5'): unknown => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { model, usage: { input_tokens: tokens } },
})

describe('Jev mode delivery', () => {
  it('delivers the message to the SDK only after askJev resolves', async () => {
    let resolveAsk: ((answer: JevAnswer) => void) | undefined
    const askJev = (): Promise<JevAnswer> =>
      new Promise((resolve) => {
        resolveAsk = resolve
      })
    const { send, updateCalls } = makeJevSession({ askJev })
    const eventId = send('Fix the typo in SessionView.vue')
    expect(updateCalls).toEqual([])

    resolveAsk?.({ ok: true, tier: 'worker', confidence: 0.9 })
    await flush()
    expect(updateCalls).toEqual([{ eventId, pending: false }])
  })

  it('sets the worker model on the first turn when Jev picks it', async () => {
    const askJev = async (): Promise<JevAnswer> => ({ ok: true, tier: 'worker', confidence: 0.9 })
    const { send, setModelCalls, routes } = makeJevSession({ askJev })
    send('Fix the typo in SessionView.vue')
    await flush()
    expect(setModelCalls).toEqual(['claude-sonnet-5'])
    expect(routes.at(-1)).toMatchObject({ model: 'claude-sonnet-5', switched: true })
  })

  it('keeps the model on a later turn once the context is over the switch limit', async () => {
    let call = 0
    const askJev = async (): Promise<JevAnswer> => {
      call += 1
      return call === 1
        ? { ok: true, tier: 'worker', confidence: 0.9 }
        : { ok: true, tier: 'intelligent', confidence: 0.9 }
    }
    const { send, feed, setModelCalls } = makeJevSession({ askJev, jevSwitchLimit: 60 })
    send('Fix the typo in SessionView.vue')
    await flush()
    expect(setModelCalls).toEqual(['claude-sonnet-5'])

    feed(usageMessage(70_000))
    send('Now do a broad refactor across the whole app')
    await flush()
    expect(setModelCalls).toEqual(['claude-sonnet-5'])
  })

  it('keeps the model and reports the Auto chip when Jev fails', async () => {
    const askJev = async (): Promise<JevAnswer> => ({ ok: false, why: 'Jev could not be reached' })
    const { send, setModelCalls, turnModes, routes } = makeJevSession({ askJev })
    send('Fix the typo in SessionView.vue')
    await flush()
    expect(setModelCalls).toEqual(['claude-opus-5'])
    expect(routes.at(-1)?.switched).toBe(false)
    expect(turnModes.at(-1)).toBe('advisor')
  })

  it('delivers synchronously, as before, when the session has no askJev callback', () => {
    const { send, updateCalls } = makeJevSession()
    const eventId = send('Fix the typo in SessionView.vue')
    expect(updateCalls).toEqual([{ eventId, pending: false }])
  })
})

describe('Jev mode edge cases', () => {
  it('withdraws a message that is still waiting on Jev when the session is interrupted', async () => {
    let resolveAsk: ((answer: JevAnswer) => void) | undefined
    const askJev = (): Promise<JevAnswer> =>
      new Promise((resolve) => {
        resolveAsk = resolve
      })
    const { session, send, updateCalls, setModelCalls } = makeJevSession({ askJev })
    const eventId = send('Refactor every store')
    await session.interrupt()
    expect(updateCalls).toEqual([{ eventId, pending: false, withdrawn: true }])

    resolveAsk?.({ ok: true, tier: 'worker', confidence: 0.9 })
    await flush()
    expect(updateCalls).toEqual([{ eventId, pending: false, withdrawn: true }])
    expect(setModelCalls).toEqual([])
  })

  it('clears the Jev chip when a usage limit downgrades the session', async () => {
    const askJev = async (): Promise<JevAnswer> => ({ ok: true, tier: 'worker', confidence: 0.9 })
    const { send, feed, routes } = makeJevSession({ askJev })
    send('Fix the typo in SessionView.vue')
    await flush()
    expect(routes.at(-1)).toMatchObject({ switched: true })

    feed({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'usage limit' })
    expect(routes.at(-1)).toBeNull()
  })
})

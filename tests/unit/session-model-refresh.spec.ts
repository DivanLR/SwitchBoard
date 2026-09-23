import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

function makeSession() {
  const routing = { model: 'claude-opus-5[1m]', effort: 'xhigh' as EffortLevel }
  const setModelCalls: (string | undefined)[] = []
  const effortCalls: unknown[] = []
  const sink = {
    append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
      return {
        id: 'e', sessionId: 's', seq: 1, kind, payload, noiseKind: null, createdAt: '',
      } as SessionEvent<K>
    },
    update(): void {},
  }
  const session = new HostedSession({
    sessionId: 's1',
    mode: 'auto',
    projectPath: '.',
    mainModel: routing.model,
    effort: routing.effort,
    resolveModels: () => ({ effort: routing.effort }),
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
    applyFlagSettings: (settings: unknown) => {
      effortCalls.push(settings)
      return Promise.resolve()
    },
  }
  const inner = session as unknown as {
    deliverNow(eventId: string, text: string): void
    handleMessage(m: SDKMessage): void
    gateSubagents(): Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>
  }
  const send = (text: string): void => inner.deliverNow('e1', text)
  const feed = (m: unknown): void => inner.handleMessage(m as SDKMessage)
  const gate = (): Promise<string | undefined> =>
    inner.gateSubagents().then((out) => out.hookSpecificOutput?.permissionDecision)
  return { routing, setModelCalls, effortCalls, send, feed, gate }
}

const limitResult = (): unknown => ({
  type: 'result', subtype: 'success', is_error: true, api_error_status: 429, session_id: 'sdk-1',
  result: 'Claude AI usage limit reached|1790000000', total_cost_usd: 0, duration_ms: 1, usage: {},
})

describe('the main-loop model is pinned for the session', () => {
  it('never switches on an ordinary turn, however the settings model looks afterwards', () => {
    const { routing, setModelCalls, send } = makeSession()
    send('What does this function do?')
    routing.model = 'claude-fable-5'
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls).toEqual([])
  })

  it('sets the main loop to the Effort bar on every turn', () => {
    const { effortCalls, send } = makeSession()
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app')
    expect(effortCalls).toEqual([{ effortLevel: 'xhigh' }])
  })
})

describe('the Effort bar', () => {
  it('reaches a running session on its next message', () => {
    const { routing, effortCalls, send } = makeSession()
    send('Fix the typo in SessionView.vue')
    routing.effort = 'low'
    send('Fix the other typo')
    expect(effortCalls).toEqual([{ effortLevel: 'xhigh' }, { effortLevel: 'low' }])
  })

  it('still moves after a usage-limit downgrade pinned the model', () => {
    const { routing, effortCalls, send, feed } = makeSession()
    feed(limitResult())
    routing.effort = 'medium'
    send('Carry on')
    expect(effortCalls.at(-1)).toEqual({ effortLevel: 'medium' })
  })

  it('refuses the Agent tool below max and allows it at max, read live', async () => {
    const { routing, gate } = makeSession()
    expect(await gate()).toBe('deny')
    routing.effort = 'max'
    expect(await gate()).toBeUndefined()
    routing.effort = 'high'
    expect(await gate()).toBe('deny')
  })
})

describe('a usage-limit downgrade', () => {
  it('drops one rung and keeps it, instead of re-reading the settings model back up', () => {
    const { setModelCalls, send, feed } = makeSession()
    feed(limitResult())
    expect(setModelCalls.at(-1)).toBe('sonnet')

    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls.at(-1)).toBe('sonnet')
    expect(setModelCalls).not.toContain('claude-opus-5[1m]')
  })

  it('recognises a 429 by its status alone, whatever the result text says', () => {
    const { setModelCalls, feed } = makeSession()
    feed({ ...(limitResult() as object), result: 'Request failed' })
    expect(setModelCalls).toEqual(['sonnet'])
  })

  it('leaves the model alone on a successful turn that only talks about limits', () => {
    const { setModelCalls, feed } = makeSession()
    feed({
      type: 'result', subtype: 'success', is_error: false, api_error_status: null, session_id: 'sdk-1',
      result: 'Fixed the rate limit handling.', total_cost_usd: 0, duration_ms: 1, usage: {},
    })
    expect(setModelCalls).toEqual([])
  })
})

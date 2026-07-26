// A model changed in Settings must reach a RUNNING session on its next turn
// (the Settings note promises it), while a usage-limit downgrade must survive
// that re-read instead of climbing back onto the limited model.
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, ModelMode, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

function makeSession() {
  const routing = {
    intelligentModel: 'claude-opus-5[1m]',
    workerModel: 'claude-sonnet-5',
    modelMode: 'auto' as ModelMode,
    autoModelRouting: true,
  }
  const setModelCalls: (string | undefined)[] = []
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
    projectId: 'p1',
    projectPath: '.',
    workModel: routing.intelligentModel,
    planModel: routing.intelligentModel,
    workerModel: routing.workerModel,
    autoModelRouting: true,
    modelMode: 'auto',
    resolveModels: () => ({ ...routing }),
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
  // Stand in for the live query: the routing paths only setModel/applyFlagSettings.
  ;(session as unknown as { q: unknown }).q = {
    setModel: (model?: string) => {
      setModelCalls.push(model)
      return Promise.resolve()
    },
    applyFlagSettings: () => Promise.resolve(),
  }
  const inner = session as unknown as {
    deliverNow(eventId: string, text: string): void
    handleMessage(m: SDKMessage): void
  }
  const send = (text: string): void => inner.deliverNow('e1', text)
  const feed = (m: unknown): void => inner.handleMessage(m as SDKMessage)
  return { routing, setModelCalls, send, feed }
}

const limitResult = (): unknown => ({
  type: 'result', subtype: 'error_during_execution', session_id: 'sdk-1',
  result: 'Usage limit reached — resets at 7pm', total_cost_usd: 0, duration_ms: 1, usage: {},
})

describe('model routing re-read per turn', () => {
  it('routes scoped work to the worker and broad work to the intelligent model', () => {
    const { setModelCalls, send } = makeSession()
    send('Fix the typo in SessionView.vue')
    expect(setModelCalls.at(-1)).toBe('claude-sonnet-5')

    // Broad, multi-step work: the intelligent model runs the orchestrator loop.
    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls.at(-1)).toBe('claude-opus-5[1m]')
  })

  it('picks up a Settings change on the next turn of a running session', () => {
    const { routing, setModelCalls, send } = makeSession()
    send('Fix the typo in SessionView.vue')
    expect(setModelCalls.at(-1)).toBe('claude-sonnet-5')

    // Settings: pin the pairing mode to Orchestrator — work now runs on the
    // intelligent model without restarting the session.
    routing.modelMode = 'orchestrator'
    send('Fix the other typo in SessionView.vue')
    expect(setModelCalls.at(-1)).toBe('claude-opus-5[1m]')

    // Settings: a different intelligent model reaches the same running session.
    routing.intelligentModel = 'claude-fable-5'
    send('Fix a third typo in SessionView.vue')
    expect(setModelCalls.at(-1)).toBe('claude-fable-5')
  })

  it('keeps a usage-limit downgrade instead of re-reading back up', () => {
    const { setModelCalls, send, feed } = makeSession()
    feed(limitResult())
    expect(setModelCalls.at(-1)).toBe('sonnet') // opus → sonnet, one rung down

    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls.at(-1)).toBe('sonnet')
    expect(setModelCalls).not.toContain('claude-opus-5[1m]')
  })
})

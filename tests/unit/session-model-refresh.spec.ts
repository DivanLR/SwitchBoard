// Two rules about the main-loop model, both of which cost real money if broken:
//   1. It NEVER changes mid-session. Switching it invalidates the tools, system
//      and message prompt-cache tiers, so the whole prefix is re-written at the
//      cache-write rate on the next turn. The cheap tier is a subagent instead.
//   2. A model changed in Settings still reaches a RUNNING session (the Settings
//      note promises it) — and a usage-limit downgrade survives that re-read.
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, ModelMode, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'
import { mainLoopModel } from '@main/sessions/model-routing'

function makeSession(mode: ModelMode = 'auto') {
  const routing = {
    intelligentModel: 'claude-opus-5[1m]',
    workerModel: 'claude-sonnet-5',
    modelMode: mode,
    autoModelRouting: true,
  }
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
    // Every session spawns in one resolved mode; 'auto' is the app default.
    mode: 'auto',
    projectPath: '.',
    mainModel: mainLoopModel(mode, routing),
    strongModel: routing.intelligentModel,
    workerModel: routing.workerModel,
    autoModelRouting: true,
    modelMode: mode,
    resolveModels: () => ({ ...routing }),
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
  // Stand in for the live query: the routing path only setModel/applyFlagSettings.
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
  }
  const send = (text: string): void => inner.deliverNow('e1', text)
  const feed = (m: unknown): void => inner.handleMessage(m as SDKMessage)
  return { routing, setModelCalls, effortCalls, send, feed }
}

const limitResult = (): unknown => ({
  type: 'result', subtype: 'error_during_execution', session_id: 'sdk-1',
  result: 'Usage limit reached — resets at 7pm', total_cost_usd: 0, duration_ms: 1, usage: {},
})

describe('the main-loop model is pinned for the session', () => {
  it('never switches between question and work turns (auto)', () => {
    const { setModelCalls, send } = makeSession('auto')
    send('What does this function do?')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app and restyle all of them')
    send('And what about the sidebar?')
    // One setModel for the whole session — every later turn is already on it.
    expect(setModelCalls).toEqual(['claude-opus-5[1m]'])
  })

  it('runs the cheap model in Advisor mode, and stays there', () => {
    const { setModelCalls, send } = makeSession('advisor')
    send('What does this function do?')
    send('Fix the typo in SessionView.vue')
    expect(setModelCalls).toEqual(['claude-sonnet-5'])
  })

  it('sets the main loop to xhigh once, not per turn', () => {
    const { effortCalls, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app')
    expect(effortCalls).toEqual([{ effortLevel: 'xhigh' }])
  })
})

describe('settings changes reach a running session', () => {
  it('picks up a new intelligent model on the next turn', () => {
    const { routing, setModelCalls, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    expect(setModelCalls).toEqual(['claude-opus-5[1m]'])

    routing.intelligentModel = 'claude-fable-5'
    send('Fix the other typo in SessionView.vue')
    expect(setModelCalls.at(-1)).toBe('claude-fable-5')
  })

  it('follows a pairing-mode change to the other tier', () => {
    const { routing, setModelCalls, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    routing.modelMode = 'advisor'
    send('Fix the other typo in SessionView.vue')
    expect(setModelCalls).toEqual(['claude-opus-5[1m]', 'claude-sonnet-5'])
  })

  it('keeps a usage-limit downgrade instead of re-reading back up', () => {
    const { setModelCalls, send, feed } = makeSession('auto')
    feed(limitResult())
    expect(setModelCalls.at(-1)).toBe('sonnet') // opus → sonnet, one rung down

    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls.at(-1)).toBe('sonnet')
    expect(setModelCalls).not.toContain('claude-opus-5[1m]')
  })
})

import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, EventKind, EventPayloadMap, ModelMode, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'
import { mainLoopModel } from '@main/sessions/model-routing'

function makeSession(mode: ModelMode = 'auto') {
  const routing = {
    intelligentModel: 'claude-opus-5[1m]',
    workerModel: 'claude-sonnet-5',
    modelMode: mode,
    autoModelRouting: true,
    effort: 'xhigh' as EffortLevel,
  }
  const setModelCalls: (string | undefined)[] = []
  const effortCalls: unknown[] = []
  const turnModes: ('advisor' | 'orchestrator' | null)[] = []
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
    mainModel: mainLoopModel(mode, routing),
    autoModelRouting: true,
    modelMode: mode,
    resolveModels: () => ({ ...routing }),
    onTurnMode: (turnMode) => turnModes.push(turnMode),
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
  return { routing, setModelCalls, effortCalls, turnModes, send, feed, gate }
}

const limitResult = (): unknown => ({
  type: 'result', subtype: 'success', is_error: true, api_error_status: 429, session_id: 'sdk-1',
  result: 'Claude AI usage limit reached|1790000000', total_cost_usd: 0, duration_ms: 1, usage: {},
})

describe('the main-loop model is pinned for the session', () => {
  it('never switches between question and work turns (auto)', () => {
    const { setModelCalls, send } = makeSession('auto')
    send('What does this function do?')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app and restyle all of them')
    send('And what about the sidebar?')
    expect(setModelCalls).toEqual(['claude-opus-5[1m]'])
  })

  it('runs the cheap model in Advisor mode, and stays there', () => {
    const { setModelCalls, send } = makeSession('advisor')
    send('What does this function do?')
    send('Fix the typo in SessionView.vue')
    expect(setModelCalls).toEqual(['claude-sonnet-5'])
  })

  it('sets the main loop to the Effort bar once, not per turn', () => {
    const { effortCalls, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app')
    expect(effortCalls).toEqual([{ effortLevel: 'xhigh' }])
  })
})

describe('the per-turn mode report', () => {
  it('names the pattern each turn picks, and clears it on a question', () => {
    const { turnModes, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app and restyle all of them')
    send('What does this function do?')
    expect(turnModes).toEqual(['advisor', 'orchestrator', null])
  })

  it('keeps a forced mode for every work turn', () => {
    const { turnModes, send } = makeSession('orchestrator')
    send('Fix the typo in SessionView.vue')
    expect(turnModes).toEqual(['orchestrator'])
  })

  it('reports no pattern in basic mode, where there is no second tier', () => {
    const { turnModes, send } = makeSession('basic')
    send('Fix the typo in SessionView.vue')
    send('Audit every view in the app and restyle all of them')
    expect(turnModes).toEqual([null, null])
  })
})

describe('the Effort bar', () => {
  it('reaches a running session on its next message', () => {
    const { routing, effortCalls, send } = makeSession('auto')
    send('Fix the typo in SessionView.vue')
    routing.effort = 'low'
    send('Fix the other typo')
    expect(effortCalls).toEqual([{ effortLevel: 'xhigh' }, { effortLevel: 'low' }])
  })

  it('still moves after a usage-limit downgrade pinned the model', () => {
    const { routing, effortCalls, send, feed } = makeSession('auto')
    feed(limitResult())
    routing.effort = 'medium'
    send('Carry on')
    expect(effortCalls.at(-1)).toEqual({ effortLevel: 'medium' })
  })

  it('refuses the Agent tool below max and allows it at max, read live', async () => {
    const { routing, gate } = makeSession('auto')
    expect(await gate()).toBe('deny')
    routing.effort = 'max'
    expect(await gate()).toBeUndefined()
    routing.effort = 'high'
    expect(await gate()).toBe('deny')
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
    expect(setModelCalls.at(-1)).toBe('sonnet')

    send('Audit every view in the app and restyle all of them')
    expect(setModelCalls.at(-1)).toBe('sonnet')
    expect(setModelCalls).not.toContain('claude-opus-5[1m]')
  })
})

describe('a usage-limit downgrade', () => {
  it('recognises a 429 by its status alone, whatever the result text says', () => {
    const { setModelCalls, feed } = makeSession('auto')
    feed({ ...(limitResult() as object), result: 'Request failed' })
    expect(setModelCalls).toEqual(['sonnet'])
  })

  it('leaves the model alone on a successful turn that only talks about limits', () => {
    const { setModelCalls, feed } = makeSession('auto')
    feed({
      type: 'result', subtype: 'success', is_error: false, api_error_status: null, session_id: 'sdk-1',
      result: 'Fixed the rate limit handling.', total_cost_usd: 0, duration_ms: 1, usage: {},
    })
    expect(setModelCalls).toEqual([])
  })
})

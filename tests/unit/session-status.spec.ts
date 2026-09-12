import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EventKind, EventPayloadMap, SessionEvent, SessionStatus } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

function makeSession() {
  const statuses: { status: SessionStatus; detail: string | null }[] = []
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
    projectPath: '.',
    mode: 'auto',
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: (status, detail) => statuses.push({ status, detail: detail ?? null }),
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
  const feed = (message: unknown): void =>
    (session as unknown as { handleMessage(m: SDKMessage): void }).handleMessage(message as SDKMessage)
  return { session, statuses, feed }
}

const bgChanged = (tasks: { task_id: string; task_type: string; description: string }[]): unknown => ({
  type: 'system', subtype: 'background_tasks_changed', session_id: 'sdk-1', uuid: 'u', tasks,
})
const resultSuccess = (): unknown => ({
  type: 'result', subtype: 'success', session_id: 'sdk-1', result: '',
  total_cost_usd: 0, duration_ms: 10, usage: {},
})

describe('session status with background tasks', () => {
  it('stays working (not done) when a turn completes while a background task runs', () => {
    const { session, statuses, feed } = makeSession()
    feed(bgChanged([{ task_id: 't1', task_type: 'workflow', description: 'deep research' }]))
    expect(statuses.at(-1)).toEqual({ status: 'working', detail: 'Running in background: deep research' })

    feed(resultSuccess())
    expect(session.currentStatus).toBe('working')

    feed(bgChanged([]))
    expect(session.currentStatus).toBe('done')
    expect(statuses.at(-1)).toEqual({ status: 'done', detail: null })
  })

  it('summarises the count when several background tasks run', () => {
    const { statuses, feed } = makeSession()
    feed(
      bgChanged([
        { task_id: 't1', task_type: 'workflow', description: 'a' },
        { task_id: 't2', task_type: 'workflow', description: 'b' },
      ]),
    )
    expect(statuses.at(-1)).toEqual({ status: 'working', detail: '2 background tasks running…' })
  })
})

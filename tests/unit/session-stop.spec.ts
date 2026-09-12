import { describe, expect, it } from 'vitest'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

function makeSession() {
  const sink = {
    append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
      return {
        id: 'e', sessionId: 's', seq: 1, kind, payload, noiseKind: null, createdAt: '',
      } as SessionEvent<K>
    },
    update(): void {},
  }
  return new HostedSession({
    sessionId: 's1',
    mode: 'auto',
    projectPath: '.',
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
}

function setRunLoop(session: HostedSession, loop: Promise<void>): void {
  ;(session as unknown as { runLoop: Promise<void> }).runLoop = loop
}

describe('HostedSession.stop', () => {
  it('waits for the run loop to end before resolving', async () => {
    const session = makeSession()
    let loopEnded = false
    setRunLoop(
      session,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          loopEnded = true
          resolve()
        }, 30),
      ),
    )

    await session.stop()

    expect(loopEnded).toBe(true)
  })

  it('resolves without a run loop, so stopping a session that never started is safe', async () => {
    await expect(makeSession().stop()).resolves.toBeUndefined()
  })
})

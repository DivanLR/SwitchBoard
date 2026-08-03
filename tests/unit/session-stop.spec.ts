// stop() must not resolve until the SDK message loop has actually ended.
//
// It used to await only interrupt(), so app exit went on to finalise the session
// row, close the database and quit while the `for await` loop was still running —
// and the loop's own onExit then wrote to a closed handle.
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
    projectId: 'p1',
    projectPath: '.',
    sink,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })
}

/** The loop promise start() would have stored; set directly so no CLI is spawned. */
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

    // The whole point: the caller that finalises rows and closes the database
    // cannot observe stop() as done while the loop is still live.
    expect(loopEnded).toBe(true)
  })

  it('resolves without a run loop, so stopping a session that never started is safe', async () => {
    await expect(makeSession().stop()).resolves.toBeUndefined()
  })
})

// The turn lifecycle, which is where the races live.
//
// `codex exec` runs one turn and exits, so a session is a SEQUENCE of child
// processes. `kill()` is asynchronous, so a killed child's `close` can arrive
// after the next turn has already started — and Node emits `close` after `error`
// for a spawn failure. Both used to settle a turn that was already spoken for:
// flushing the wrong buffer, clearing the replacement's handle, and draining the
// queue a second time.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import type { EventSink } from '@main/sessions/message-mapper'

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): void {
    this.killed = true
  }
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new FakeChild()
    spawned.push(child)
    return child
  },
}))

vi.mock('@main/sessions/codex-executable', () => ({
  resolveCodexLaunch: () => ({ command: 'codex', prefixArgs: [], env: {} }),
  codexInstalled: () => true,
  CODEX_MISSING_MESSAGE: 'missing',
}))

const { CodexSession } = await import('@main/sessions/codex-session')

class FakeSink implements EventSink {
  seq = 0
  appended: SessionEvent[] = []
  append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
    this.seq += 1
    const event: SessionEvent = {
      id: `e${this.seq}`,
      sessionId: 's1',
      seq: this.seq,
      kind,
      payload,
      noiseKind: null,
      createdAt: new Date().toISOString(),
    }
    this.appended.push(event)
    return event as SessionEvent<K>
  }
  update(): void {}
}

function makeSession() {
  const sink = new FakeSink()
  let turnsComplete = 0
  const statuses: string[] = []
  const session = new CodexSession({
    sessionId: 's1',
    projectPath: 'C:/repo',
    mode: 'auto',
    sink,
    onStatusChange: (status) => statuses.push(status),
    onSdkSessionId: () => {},
    onTurnComplete: () => {
      turnsComplete += 1
    },
    onExit: () => {},
  })
  return { session, sink, statuses, turns: () => turnsComplete }
}

beforeEach(() => {
  spawned.length = 0
})

describe('CodexSession turn lifecycle', () => {
  it('ignores the close of a turn that interrupt already replaced', async () => {
    const { session, turns } = makeSession()
    session.start()
    session.send('first').deliver('p1')
    expect(spawned).toHaveLength(1)
    const first = spawned[0]

    await session.interrupt()
    expect(first.killed).toBe(true)

    // A replacement starts immediately, before the killed child has emitted.
    session.send('second').deliver('p2')
    expect(spawned).toHaveLength(2)
    expect(session.isMidTask).toBe(true)

    // The late close from the FIRST child must change nothing.
    first.emit('close', null)
    expect(session.isMidTask).toBe(true)
    expect(turns()).toBe(0)

    // The replacement still settles normally.
    spawned[1].emit('close', 0)
    expect(session.isMidTask).toBe(false)
    expect(turns()).toBe(1)
  })

  it('counts a spawn failure once, though Node emits error and then close', () => {
    const { session, turns } = makeSession()
    session.start()
    session.send('go').deliver('p1')
    const child = spawned[0]

    child.emit('error', new Error('ENOENT'))
    child.emit('close', null)

    expect(turns()).toBe(1)
    expect(session.isMidTask).toBe(false)
  })

  it('does not drain the queue twice when a turn ends', () => {
    const { session } = makeSession()
    session.start()
    session.send('first').deliver('p1')
    // Queued behind the running turn.
    session.send('second').deliver('p2')
    expect(spawned).toHaveLength(1)

    const first = spawned[0]
    first.emit('close', 0)
    expect(spawned).toHaveLength(2)

    // A second close from the same, already-settled child must not start a third.
    first.emit('close', 0)
    expect(spawned).toHaveLength(2)
  })
})

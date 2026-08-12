// Rewording or withdrawing a composer message that is still queued behind the
// running turn.
//
// The case worth protecting is the race, not the happy path: the turn can finish
// between the developer opening the editor and saving it, and at that point the
// session has already been told. editQueuedSend must report that rather than
// appear to succeed, or they are left believing they changed what ran.
import { describe, expect, it } from 'vitest'
import type { EventKind, EventPayloadMap, SessionEvent } from '@shared/domain'
import { HostedSession } from '@main/sessions/session'

interface Appended {
  id: string
  kind: string
  payload: Record<string, unknown>
}

function makeSession() {
  const appended: Appended[] = []
  const updates: { id: string; payload: Record<string, unknown> }[] = []
  let n = 0
  const sink = {
    append<K extends EventKind>(kind: K, payload: EventPayloadMap[K]): SessionEvent<K> {
      const id = `e${++n}`
      appended.push({ id, kind, payload: payload as unknown as Record<string, unknown> })
      return { id, sessionId: 's1', seq: n, kind, payload, noiseKind: null, createdAt: '' } as SessionEvent<K>
    },
    update(id: string, payload: Record<string, unknown>): void {
      updates.push({ id, payload })
    },
  }
  const session = new HostedSession({
    sessionId: 's1',
    // Every session spawns in one resolved mode; 'auto' is the app default.
    mode: 'auto',
    projectPath: '.',
    sink: sink as never,
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onStatusChange: () => {},
    onSdkSessionId: () => {},
    onTurnComplete: () => {},
    onExit: () => {},
  })

  const internals = session as unknown as {
    turnInFlight: boolean
    queuedSends: { eventId: string; text: string }[]
    flushQueuedSends(): void
  }

  /** Queue a message the way sendMessage does: send(), then deliver(eventId). */
  const queue = (text: string): string => {
    internals.turnInFlight = true
    const handle = session.send(text)
    expect(handle.queued).toBe(true)
    const event = sink.append('prompt', { text, pending: true })
    handle.deliver(event.id)
    return event.id
  }

  return { session, internals, updates, queue }
}

describe('HostedSession.editQueuedSend', () => {
  it('rewords a message still waiting for the turn', () => {
    const { session, internals, updates, queue } = makeSession()
    const id = queue('run the tests')

    expect(session.editQueuedSend(id, 'run the tests, then lint')).toBe(true)
    expect(internals.queuedSends).toEqual([{ eventId: id, text: 'run the tests, then lint' }])
    // The stream shows the new text, still marked queued.
    expect(updates.at(-1)).toEqual({ id, payload: { text: 'run the tests, then lint', pending: true } })
  })

  it('delivers the edited text, not the original, when the turn finishes', () => {
    const { session, internals, updates, queue } = makeSession()
    const id = queue('old plan')
    session.editQueuedSend(id, 'new plan')

    internals.flushQueuedSends()

    // deliverNow marks it delivered with the text that was actually sent.
    expect(updates.at(-1)).toMatchObject({ id, payload: { text: 'new plan', pending: false } })
    expect(internals.queuedSends).toEqual([])
  })

  it('withdraws it on empty text, keeping the row because events are append-only', () => {
    const { session, internals, updates, queue } = makeSession()
    const id = queue('never mind this')

    expect(session.editQueuedSend(id, '   ')).toBe(true)
    expect(internals.queuedSends).toEqual([])
    // The original text is preserved: what was typed is part of the record, and
    // it is flagged so it cannot read as something the session was told.
    expect(updates.at(-1)).toEqual({
      id,
      payload: { text: 'never mind this', pending: false, withdrawn: true },
    })
  })

  it('never delivers a withdrawn message', () => {
    const { session, internals, updates, queue } = makeSession()
    const id = queue('do not send me')
    session.editQueuedSend(id, '')
    const after = updates.length

    internals.flushQueuedSends()

    expect(updates.length).toBe(after) // nothing further happened
  })

  it('refuses once the turn has finished and the message has gone', () => {
    const { session, internals, queue } = makeSession()
    const id = queue('already on its way')
    internals.flushQueuedSends() // the race: the turn ended mid-edit

    expect(session.editQueuedSend(id, 'too late')).toBe(false)
  })

  it('refuses an event id that was never queued', () => {
    const { session } = makeSession()
    expect(session.editQueuedSend('e-nonexistent', 'anything')).toBe(false)
  })

  it('edits the right message when several are queued', () => {
    const { session, internals, queue } = makeSession()
    const first = queue('one')
    const second = queue('two')
    const third = queue('three')

    session.editQueuedSend(second, 'two, corrected')

    expect(internals.queuedSends).toEqual([
      { eventId: first, text: 'one' },
      { eventId: second, text: 'two, corrected' },
      { eventId: third, text: 'three' },
    ])
  })

  it('withdrawing one keeps the order of the rest', () => {
    const { session, internals, queue } = makeSession()
    const first = queue('one')
    const second = queue('two')
    const third = queue('three')

    session.editQueuedSend(second, '')

    expect(internals.queuedSends).toEqual([
      { eventId: first, text: 'one' },
      { eventId: third, text: 'three' },
    ])
  })

  it('trims the saved text, so trailing whitespace is not sent', () => {
    const { session, internals, queue } = makeSession()
    const id = queue('x')
    session.editQueuedSend(id, '  tidy  ')
    expect(internals.queuedSends).toEqual([{ eventId: id, text: 'tidy' }])
  })
})

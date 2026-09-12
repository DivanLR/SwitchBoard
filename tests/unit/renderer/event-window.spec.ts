import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shared/domain'
import { useActiveSessionStore } from '@renderer/stores/activeSession'

const event = (seq: number): SessionEvent => ({
  id: `e${seq}`,
  sessionId: 's1',
  seq,
  kind: 'assistant_text',
  payload: { text: `line ${seq}` },
  noiseKind: null,
  createdAt: '2026-07-31T08:00:00.000Z',
})

function streamed(held: number, pushes: number): ReturnType<typeof useActiveSessionStore> {
  const store = useActiveSessionStore()
  store.sessionId = 's1'
  store.events = Array.from({ length: held }, (_, i) => event(i + 1))
  store.oldestSeq = held > 0 ? 1 : null
  store.hasMoreHistory = false
  for (let n = 1; n <= pushes; n += 1) store.applyEventPush(event(held + n))
  return store
}

describe('the live event tail', () => {
  it('keeps everything while the session is short', () => {
    const store = streamed(40, 10)
    expect(store.events).toHaveLength(50)
    expect(store.hasMoreHistory).toBe(false)
  })

  it('caps the array and keeps the NEWEST events, in order', () => {
    const store = streamed(3_000, 25)
    expect(store.events).toHaveLength(3_000)
    expect(store.events[0].seq).toBe(26)
    expect(store.events[store.events.length - 1].seq).toBe(3_025)
  })

  it('says history is pageable again, from the new oldest event', () => {
    const store = streamed(3_000, 25)
    expect(store.hasMoreHistory).toBe(true)
    expect(store.oldestSeq).toBe(26)
  })

  it('still replaces a streaming event in place rather than appending it', () => {
    const store = streamed(10, 0)
    store.applyEventPush({ ...event(10), payload: { text: 'final' } })
    expect(store.events).toHaveLength(10)
    expect(store.events[9].payload).toEqual({ text: 'final' })
  })
})

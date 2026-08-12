// A section's work runs in a background session the developer never opens, so
// for the length of a verify pass or a diagram the panel said "Running…" and
// nothing else. The events were crossing the wire the whole time — the store
// dropped every one that did not belong to the OPEN conversation.
//
// The tail is what those events feed. It has to stay separate from `events`:
// the open conversation and the session doing background work are different
// sessions, and merging them would put a verify run's output in the chat.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@shared/domain'

vi.mock('@renderer/ipc', () => ({
  invoke: vi.fn(async () => []),
  errorMessage: (e: unknown) => String(e),
}))

const { useActiveSessionStore } = await import('@renderer/stores/activeSession')

const event = (sessionId: string, seq: number, text: string): SessionEvent => ({
  id: `${sessionId}-${seq}`,
  sessionId,
  seq,
  kind: 'assistant_text',
  payload: { text },
  noiseKind: null,
  createdAt: '2026-08-12T09:00:00.000Z',
})

describe('watching a background session without opening it', () => {
  beforeEach(() => {
    const store = useActiveSessionStore()
    store.sessionId = 'chat'
    store.events = []
    for (const id of Object.keys(store.tails)) store.unwatchTail(id)
  })

  it('collects a watched session’s output without touching the open conversation', async () => {
    const store = useActiveSessionStore()
    await store.watchTail('bg')

    store.applyEventPush(event('bg', 1, 'npm test'))
    store.applyEventPush(event('bg', 2, '12 passed'))

    expect(store.tails.bg?.map((e) => (e.payload as { text: string }).text)).toEqual([
      'npm test',
      '12 passed',
    ])
    // The chat is untouched: this is the whole reason the tail is a separate array.
    expect(store.events).toEqual([])
  })

  it('still delivers the open conversation’s own events', async () => {
    const store = useActiveSessionStore()
    await store.watchTail('bg')

    store.applyEventPush(event('chat', 1, 'hello'))

    expect(store.events).toHaveLength(1)
    expect(store.tails.bg).toEqual([])
  })

  it('replaces an event in place rather than repeating it as it streams', async () => {
    const store = useActiveSessionStore()
    await store.watchTail('bg')

    store.applyEventPush(event('bg', 1, 'partial'))
    store.applyEventPush(event('bg', 1, 'partial, finished'))

    expect(store.tails.bg).toHaveLength(1)
    expect((store.tails.bg?.[0].payload as { text: string }).text).toBe('partial, finished')
  })

  it('ignores a session nobody is watching, which is nearly all of them', () => {
    const store = useActiveSessionStore()
    store.applyEventPush(event('someone-else', 1, 'noise'))
    expect(store.tails['someone-else']).toBeUndefined()
  })

  it('frees the tail when the panel showing it goes away', async () => {
    const store = useActiveSessionStore()
    await store.watchTail('bg')
    store.applyEventPush(event('bg', 1, 'work'))

    store.unwatchTail('bg')
    expect(store.tails.bg).toBeUndefined()

    // And a later push for it is a no-op rather than resurrecting the tail.
    store.applyEventPush(event('bg', 2, 'more work'))
    expect(store.tails.bg).toBeUndefined()
  })

  it('keeps only the recent lines, because a tail is not a transcript', async () => {
    const store = useActiveSessionStore()
    await store.watchTail('bg')
    for (let seq = 1; seq <= 400; seq++) store.applyEventPush(event('bg', seq, `line ${seq}`))

    const tail = store.tails.bg ?? []
    expect(tail.length).toBeLessThanOrEqual(150)
    // The NEWEST lines are the ones kept: a trimmed tail showing the start of a
    // run would be worse than no tail at all.
    expect((tail.at(-1)?.payload as { text: string }).text).toBe('line 400')
  })
})

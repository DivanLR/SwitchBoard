// The diagrams store polls the folder for a file the app does not write itself,
// so the wait has two endings and they must not be confused for one another.
//
// This exists because they were. The success path broke out of the poll loop
// without clearing `pending`, fell into the branch that reports a five-minute
// timeout, and told the developer their diagram had failed at the exact moment
// it succeeded. The naming and repository tests in tests/unit/diagrams.spec.ts
// all passed throughout: none of them ran the loop.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagramEntry } from '@shared/domain'

const listed: DiagramEntry[][] = []

/**
 * The session's fate, as the poll now asks for it each round. Null by default —
 * "still going" — because these tests are about the file arriving or not.
 *
 * Dispatched BY METHOD rather than answered from one queue. It used to answer
 * every call with the next queued listing, so the moment the poll gained a second
 * call each round it ate two entries per round and every wait desynchronised.
 */
let fate: { endedAt: string | null; endReason: string | null; statusDetail: string | null } | null =
  null

vi.mock('@renderer/ipc', async () => {
  const actual = await vi.importActual<typeof import('@shared/ipc-types')>('@shared/ipc-types')
  return {
    invoke: vi.fn(async (method: string) => {
      if (method === 'sessions.fate') return fate
      return listed.shift() ?? []
    }),
    errorMessage: actual.errorMessage,
  }
})

const { useDiagramsStore } = await import('@renderer/stores/diagrams')

const entry = (file: string): DiagramEntry => ({
  file,
  path: `docs/diagrams/${file}`,
  description: 'Auth flow',
  sessionId: 's1',
  modifiedAt: '2026-08-12T09:00:00.000Z',
  plan: null,
  bytes: 2048,
})

/** The store as it stands the moment generate() has dispatched and the wait begins. */
function waiting(file: string): ReturnType<typeof useDiagramsStore> {
  const store = useDiagramsStore()
  store.byProject = {}
  store.error = null
  store.pending = { projectId: 'p1', file, description: 'Auth flow', sessionId: 's1' }
  return store
}

describe('diagrams store: waiting for the file to land', () => {
  beforeEach(() => {
    listed.length = 0
    fate = null
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports no error when the file lands, however long it took to arrive', async () => {
    const store = waiting('auth-flow.html')
    // Two empty polls first: arriving late is the normal case, not an edge one.
    listed.push([], [], [entry('auth-flow.html')])

    const wait = store.awaitFile('p1', 'auth-flow.html')
    // awaitFile (diagrams.ts) doubles the cadence after every empty round,
    // capped at 10s, rather than polling at a flat 2500ms — so the three
    // rounds below land at 2500, then 5000, then 10000ms, not 2500 x 3. This
    // used to advance a flat `3 * 2500` and hang until vitest's own 5000ms
    // test timeout, because the third setTimeout (10000ms) never fired.
    await vi.advanceTimersByTimeAsync(2500 + 5000 + 10_000)
    await wait

    expect(store.error).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.forProject('p1').map((d) => d.file)).toEqual(['auth-flow.html'])
  })

  it('says the file never arrived once the budget is spent, and stops claiming it is on its way', async () => {
    const store = waiting('auth-flow.html')

    const wait = store.awaitFile('p1', 'auth-flow.html')
    // The 20-minute deadline is wall clock, checked only BETWEEN rounds, so the
    // wait can run past it by up to one full round at the 10s cap, not by the
    // old flat 2500ms poll. Advancing only `+2500` therefore stopped short of
    // the round in which the loop actually notices the deadline has passed,
    // and the test hung waiting on a promise that could not yet have resolved.
    // Advance well past the worst-case overshoot; once the wait has already
    // settled, extra fake time here is a no-op.
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 20_000)
    await wait

    expect(store.error).toMatch(/has not appeared after twenty minutes/)
    expect(store.pending).toBeNull()
  })

  it('abandons the wait when the developer asks for a different diagram', async () => {
    const store = waiting('auth-flow.html')

    const wait = store.awaitFile('p1', 'auth-flow.html')
    store.pending = { projectId: 'p1', file: 'billing.html', description: 'Billing', sessionId: 's1' }
    await vi.advanceTimersByTimeAsync(2500)
    await wait

    // The superseded wait must not report on, or clear, the request that replaced it.
    expect(store.error).toBeNull()
    expect(store.pending?.file).toBe('billing.html')
  })
})

// The third ending, and the one that actually happened: the session drawing it
// died. The container was killed with exit 137 — out of memory — four minutes in,
// having read a few dozen source files, and nothing was ever written. The wait
// could not tell dead from slow, so it kept claiming the drawing was on its way
// for the remaining sixteen minutes and then blamed its own budget.
describe('diagrams store: the session drawing it dies', () => {
  beforeEach(() => {
    listed.length = 0
    fate = null
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the wait at once and reports the session’s own reason', async () => {
    const store = waiting('auth-flow.html')
    listed.push([])
    fate = {
      endedAt: '2026-08-13T10:30:30.630Z',
      endReason: 'crashed',
      statusDetail: 'The sandbox container was killed from outside the process: exit 137 is SIGKILL.',
    }

    const wait = store.awaitFile('p1', 'auth-flow.html')
    await vi.advanceTimersByTimeAsync(2600)
    await wait

    expect(store.pending).toBeNull()
    expect(store.error).toContain('exit 137')
  })

  // A file landing in the same beat the session ended is a SUCCESS. Reporting a
  // crash over a delivered diagram would be the worse of the two mistakes.
  it('prefers the delivered file when the session ended in the same beat', async () => {
    const store = waiting('auth-flow.html')
    listed.push([entry('auth-flow.html')])
    fate = { endedAt: '2026-08-13T10:30:30.630Z', endReason: 'completed', statusDetail: null }

    const wait = store.awaitFile('p1', 'auth-flow.html')
    await vi.advanceTimersByTimeAsync(2600)
    await wait

    expect(store.pending).toBeNull()
    expect(store.error).toBeNull()
    expect(store.selected).toEqual({ projectId: 'p1', file: 'auth-flow.html' })
  })
})

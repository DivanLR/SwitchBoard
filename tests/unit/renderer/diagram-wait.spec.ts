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

// The store's only transport. Queued answers are returned one per poll, so a
// test says "empty, empty, then the file" and reads like the wait it describes.
vi.mock('@renderer/ipc', async () => {
  const actual = await vi.importActual<typeof import('@shared/ipc-types')>('@shared/ipc-types')
  return {
    invoke: vi.fn(async () => listed.shift() ?? []),
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
    await vi.advanceTimersByTimeAsync(3 * 2500)
    await wait

    expect(store.error).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.forProject('p1').map((d) => d.file)).toEqual(['auth-flow.html'])
  })

  it('says the file never arrived once the budget is spent, and stops claiming it is on its way', async () => {
    const store = waiting('auth-flow.html')

    const wait = store.awaitFile('p1', 'auth-flow.html')
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 2500)
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

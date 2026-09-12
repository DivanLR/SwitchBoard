import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagramEntry } from '@shared/domain'

const listed: DiagramEntry[][] = []

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
    listed.push([], [], [entry('auth-flow.html')])

    const wait = store.awaitFile('p1', 'auth-flow.html')
    await vi.advanceTimersByTimeAsync(2500 + 5000 + 10_000)
    await wait

    expect(store.error).toBeNull()
    expect(store.pending).toBeNull()
    expect(store.forProject('p1').map((d) => d.file)).toEqual(['auth-flow.html'])
  })

  it('says the file never arrived once the budget is spent, and stops claiming it is on its way', async () => {
    const store = waiting('auth-flow.html')

    const wait = store.awaitFile('p1', 'auth-flow.html')
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

    expect(store.error).toBeNull()
    expect(store.pending?.file).toBe('billing.html')
  })
})

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

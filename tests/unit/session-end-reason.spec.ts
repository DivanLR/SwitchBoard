// "Sometimes my sessions just close with no message." They did, and this pins the
// fix: every way a session can end now records WHY on the row.
//
// Four paths reached the database with `statusDetail` null, so that afterwards
// nothing could tell them apart:
//   - the developer pressing End, or a stray click on a row's own close control
//   - a section session closing itself the moment its work finished
//   - a graceful quit whose grace period expired
//   - startup reconciliation, closing sessions the LAST run never closed at all
// The last of those was the largest by count and the least obvious, because the
// session did not close: the application did. Crashes were never silent
// (explainExit), which is why they are not here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A DRAINABLE run loop, unlike the never-yielding stub the other manager suites
// use. `stop()` waits for the for-await loop to actually finish (bounded by a 5s
// grace period, which is why a never-yielding stub makes every one of these tests
// time out rather than fail). `drainLoops()` ends the loop the way a real CLI
// exiting does, so the ordinary teardown path runs in full.
const pending: ((value: { value: undefined; done: true }) => void)[] = []
function drainLoops(): void {
  for (const resolve of pending.splice(0)) resolve({ value: undefined, done: true })
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve) => pending.push(resolve as never)),
    }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

vi.mock('@main/sessions/wslc-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/wslc-sandbox')>()
  return {
    ...actual,
    ensureSandboxImage: () => Promise.resolve(),
    ensureSandboxVolumes: () => Promise.resolve(),
  }
})

const { openDatabase } = await import('@main/store/db')
const { createRepositories } = await import('@main/store/repositories')
const { SessionManager } = await import('@main/sessions/session-manager')

const dirs: string[] = []
afterEach(() => {
  pending.length = 0
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // A temp directory the OS still holds open. The OS can have it.
    }
  }
})

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'end-reason-'))
  dirs.push(dir)
  const project = repos.projects.insert({ name: 'a', path: dir, source: 'manual' })
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { db, repos, project, manager }
}

/** The private turn-end path, reached the way a real session reaches it. */
function finishTurn(manager: unknown, sessionId: string): void {
  const m = manager as { hosted: Map<string, { session: { options: { onTurnComplete: () => void } } }> }
  m.hosted.get(sessionId)?.session.options.onTurnComplete()
}

describe('a session that ends says why', () => {
  it('records the note a deliberate stop was given', async () => {
    const { repos, project, manager } = setup()
    const session = await manager.startSession(project.id)

    const stopping = manager.stopSession(session.id, 'You ended this session.')
    drainLoops()
    await stopping

    const row = repos.sessions.byId(session.id)
    expect(row?.endedAt).toBeTruthy()
    expect(row?.endReason).toBe('stopped')
    // The whole point: not null. A row that only says 'stopped' cannot tell the
    // developer whether they did it, a section did it, or something else did.
    expect(row?.statusDetail).toBe('You ended this session.')
  })

  it('names the section session that closed itself, which nobody asked for', async () => {
    const { repos, project, manager } = setup()
    const inner = manager as unknown as {
      startBackground: (projectId: string, kind: string) => Promise<{ id: string }>
      handleStatusChange: (entry: unknown, status: string) => void
      hosted: Map<string, unknown>
    }
    // A section's own session: background, so endIfIdleBackground owns its life.
    const session = await inner.startBackground(project.id, 'cleanup')

    // It must have run a turn before it counts as idle, exactly as the real path
    // requires, and a settled 'done' is then what triggers the self-close.
    finishTurn(manager, session.id)
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    // The self-close awaits the same drain a deliberate stop does.
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    drainLoops()

    await vi.waitFor(() => expect(repos.sessions.byId(session.id)?.endedAt).toBeTruthy())
    const row = repos.sessions.byId(session.id)
    expect(row?.endReason).toBe('stopped')
    expect(row?.statusDetail).toMatch(/closed itself when that work finished/)
  })

  // The path that produced more silent rows than every other one put together.
  // Nothing here calls stop(): these are sessions a PREVIOUS run left open, which
  // is what makes them invisible — the session did not end, the application did.
  it('says so when the last run never closed the session at all', () => {
    const { repos, project } = setup()
    // Written straight to the table, because that is the only state this path ever
    // sees: a row with endedAt null and no manager holding it.
    const row = {
      id: 'left-open',
      projectId: project.id,
      sdkSessionId: null,
      status: 'working' as const,
      statusDetail: null,
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
    }
    repos.sessions.insert(row)

    const closed = repos.sessions.reconcileAllEnded('app_exit', 'Switchboard stopped without closing this session.')

    expect(closed).toBe(1)
    const after = repos.sessions.byId('left-open')
    expect(after?.endReason).toBe('app_exit')
    expect(after?.statusDetail).toBe('Switchboard stopped without closing this session.')
  })

  it('never overwrites a diagnosis a dying session already wrote for itself', () => {
    const { repos, project } = setup()
    repos.sessions.insert({
      id: 'already-explained',
      projectId: project.id,
      sdkSessionId: null,
      status: 'error',
      statusDetail: 'The sandbox container was killed from outside.',
      branch: null,
      diffAdds: null,
      diffDels: null,
      usageUtilization: null,
      usageResetsAt: null,
      usageLimitType: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
    })

    repos.sessions.reconcileAllEnded('app_exit', 'Switchboard stopped without closing this session.')

    // The session's own account of why it died beats the generic one.
    const after = repos.sessions.byId('already-explained')
    expect(after?.statusDetail).toBe('The sandbox container was killed from outside.')
    expect(after?.status).toBe('error')
  })
})

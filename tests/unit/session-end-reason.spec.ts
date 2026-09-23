import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pending: ((value: { value: undefined; done: true }) => void)[] = []
function drainLoops(): void {
  for (const resolve of pending.splice(0)) resolve({ value: undefined, done: true })
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
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
    onVerifyChanged: () => {},    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (() => {}) as never,
  })
  return { db, repos, project, manager }
}

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
    expect(row?.statusDetail).toBe('You ended this session.')
  })

  it('names the section session that closed itself, which nobody asked for', async () => {
    const { repos, project, manager } = setup()
    const inner = manager as unknown as {
      startBackground: (projectId: string, kind: string) => Promise<{ id: string }>
      handleStatusChange: (entry: unknown, status: string) => void
      hosted: Map<string, unknown>
    }
    const session = await inner.startBackground(project.id, 'flow')

    finishTurn(manager, session.id)
    inner.handleStatusChange(inner.hosted.get(session.id), 'done')
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    drainLoops()

    await vi.waitFor(() => expect(repos.sessions.byId(session.id)?.endedAt).toBeTruthy())
    const row = repos.sessions.byId(session.id)
    expect(row?.endReason).toBe('completed')
    expect(row?.statusDetail).toMatch(/closed itself when that work finished/)
    expect(row?.sectionKind).toBe('flow')
  })

  it('says so when the last run never closed the session at all', () => {
    const { repos, project } = setup()
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

    const after = repos.sessions.byId('already-explained')
    expect(after?.statusDetail).toBe('The sandbox container was killed from outside.')
    expect(after?.status).toBe('error')
  })
})

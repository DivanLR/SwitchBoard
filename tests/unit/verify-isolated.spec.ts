import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlannedSuite } from '@main/evals/verify-dispatch'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({ type: 'sdk', name: 'switchboard', instance: {} }),
  tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
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

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const dir = mkdtempSync(join(tmpdir(), 'verify-isolated-'))
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

function teardown(repos: { events: { flush: () => void } }, db: { close: () => void }): void {
  repos.events.flush()
  db.close()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
    }
  }
}

function planned(id: string): PlannedSuite {
  return {
    suite: { id, kind: 'unit', label: id, acceptance: `${id} works`, command: `run ${id}`, needs: 'node' },
    unavailable: null,
  }
}

function reportSuite(manager: unknown, sessionId: string, suiteId: string, status: string, detail: string): void {
  const m = manager as {
    hosted: Map<string, { session: { options: { sink: { append: (kind: string, payload: unknown) => void } } } }>
  }
  m.hosted.get(sessionId)?.session.options.sink.append('assistant_text', {
    text: `SWB_VERIFY: {"suites":[{"id":"${suiteId}","status":"${status}","detail":"${detail}"}]}`,
  })
}

describe('isolated verify suites run sequentially, one fresh container at a time', () => {
  it('never starts the second suite session before the first one was stopped', async () => {
    const { db, repos, project, manager } = setup()
    try {
      const order: string[] = []
      const originalStart = manager.startSession.bind(manager)
      vi.spyOn(manager, 'startSession').mockImplementation((...args: Parameters<typeof manager.startSession>) =>
        originalStart(...args).then((session) => {
          order.push(`start:${session.id}`)
          return session
        }),
      )
      vi.spyOn(manager, 'stopSession').mockImplementation(async (sessionId: string) => {
        order.push(`stop:${sessionId}`)
      })

      const run = repos.verifyRuns.start({
        projectId: project.id,
        stackId: 'node',
        sessionId: null,
        branch: null,
        requested: ['a', 'b'],
      })
      const done = manager.runSuitesIsolated({
        runId: run.id,
        projectId: project.id,
        plan: [planned('a'), planned('b')],
        stackLabel: 'node',
        sandboxed: null,
        dbServers: [],
      })

      await vi.waitFor(() => expect(order).toHaveLength(1))
      const sessionAId = order[0].split(':')[1]
      reportSuite(manager, sessionAId, 'a', 'pass', '3 passed')

      await vi.waitFor(() => expect(order).toHaveLength(3))
      expect(order[1]).toBe(`stop:${sessionAId}`)
      expect(order[2].startsWith('start:')).toBe(true)
      const sessionBId = order[2].split(':')[1]
      expect(sessionBId).not.toBe(sessionAId)

      reportSuite(manager, sessionBId, 'b', 'pass', '1 passed')
      await done

      expect(order).toEqual([
        `start:${sessionAId}`,
        `stop:${sessionAId}`,
        `start:${sessionBId}`,
        `stop:${sessionBId}`,
      ])
    } finally {
      teardown(repos, db)
    }
  })

  it('closes the run once, after every suite has settled — never per suite', async () => {
    const { db, repos, project, manager } = setup()
    try {
      vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)
      const finishSpy = vi.spyOn(repos.verifyRuns, 'finish')

      const run = repos.verifyRuns.start({
        projectId: project.id,
        stackId: 'node',
        sessionId: null,
        branch: null,
        requested: ['a', 'b'],
      })
      const done = manager.runSuitesIsolated({
        runId: run.id,
        projectId: project.id,
        plan: [planned('a'), planned('b')],
        stackLabel: 'node',
        sandboxed: null,
        dbServers: [],
      })

      await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
      const sessionAId = manager.liveSessionIds()[0]
      reportSuite(manager, sessionAId, 'a', 'pass', 'ok a')

      await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(2))
      expect(finishSpy).not.toHaveBeenCalled()

      const sessionBId = manager.liveSessionIds().find((id) => id !== sessionAId)
      reportSuite(manager, sessionBId!, 'b', 'fail', 'boom')

      await done
      expect(finishSpy).toHaveBeenCalledTimes(1)
      const finished = repos.verifyRuns.byId(run.id)
      expect(finished?.status).toBe('fail')
      expect(finished?.report?.suites.map((s) => s.id).sort()).toEqual(['a', 'b'])
    } finally {
      teardown(repos, db)
    }
  })

  it('records a suite that never reports rather than dropping it from the run', async () => {
    const { db, repos, project, manager } = setup()
    try {
      vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)

      const run = repos.verifyRuns.start({
        projectId: project.id,
        stackId: 'node',
        sessionId: null,
        branch: null,
        requested: ['a'],
      })
      const done = manager.runSuitesIsolated({
        runId: run.id,
        projectId: project.id,
        plan: [planned('a')],
        stackLabel: 'node',
        sandboxed: null,
        dbServers: [],
      })

      await vi.waitFor(() => expect(manager.liveSessionIds()).toHaveLength(1))
      const sessionId = manager.liveSessionIds()[0]

      const inner = manager as unknown as {
        handleStatusChange: (entry: unknown, status: string) => void
        hosted: Map<string, unknown>
      }
      inner.handleStatusChange(inner.hosted.get(sessionId), 'done')

      await done
      const finished = repos.verifyRuns.byId(run.id)
      expect(finished?.report?.suites).toHaveLength(1)
      expect(finished?.report?.suites[0]).toMatchObject({ id: 'a', status: 'not_run' })
      expect(finished?.status).not.toBe('pass')
      expect(finished?.note).toContain('a')
    } finally {
      teardown(repos, db)
    }
  })

  it('a cancel stops the queue: the next suite never starts', async () => {
    const { db, repos, project, manager } = setup()
    try {
      vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)
      const startSpy = vi.spyOn(manager, 'startSession')

      const run = repos.verifyRuns.start({
        projectId: project.id,
        stackId: 'node',
        sessionId: null,
        branch: null,
        requested: ['a', 'b'],
      })
      const done = manager.runSuitesIsolated({
        runId: run.id,
        projectId: project.id,
        plan: [planned('a'), planned('b')],
        stackLabel: 'node',
        sandboxed: null,
        dbServers: [],
      })

      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1))

      await manager.cancelVerifyRun(run.id)
      expect(repos.verifyRuns.byId(run.id)?.status).toBe('inconclusive')

      await done
      expect(startSpy).toHaveBeenCalledTimes(1)
    } finally {
      teardown(repos, db)
    }
  })
})

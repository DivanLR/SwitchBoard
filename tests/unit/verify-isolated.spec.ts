// Suites shared one container and one memory ceiling, and a heavy suite had
// been killing that container out from under the others (exit 137, SIGKILL, no
// stderr). runSuitesIsolated is the opt-in fix: each chosen suite gets its own
// fresh container, run one at a time, its container gone before the next
// starts. The method did not exist before this change — every assertion below
// is a compile error without it, which is as clean a "fails without the
// feature" as a test gets.
//
// This pins the four things the contract calls out: suites run one at a time
// (the second session never starts before the first was stopped), the run
// closes ONCE at the end rather than per suite, a suite that never reports is
// recorded rather than dropped, and a cancel stops the queue rather than only
// the suite already running.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlannedSuite } from '@main/evals/verify-dispatch'

// Same shape as diagram-watch.spec.ts / container-admission.spec.ts: the run
// loop is never really exercised (the mocked async iterator's next() never
// resolves), so a suite's report is injected straight through the manager's
// own sink rather than through a fabricated SDK message — see reportSuite
// below. interrupt() is real (Promise.resolve()) because the cancel test needs
// it to settle.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    supportedCommands: () => Promise.resolve([]),
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
    // sendMessage's deliver path applies the routed model/effort on every send
    // (applyModelForTurn / applyEffortForModel) — unlike the two tests this
    // harness is copied from, runSuitesIsolated actually calls sendMessage, so
    // both have to exist here or the call throws synchronously and the suite
    // never gets its prompt.
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
  }),
}))

vi.mock('@main/sessions/claude-executable', () => ({
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}))

vi.mock('@main/sessions/docker-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sessions/docker-sandbox')>()
  return { ...actual, ensureSandboxImage: () => Promise.resolve() }
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
  // Unlike diagram-watch.spec.ts / container-admission.spec.ts, this suite
  // actually calls sendMessage, which buffers an events-table insert behind an
  // unref'd 33ms timer (EventsRepo.insert). Closing the db without flushing
  // first left that timer to fire against an already-closed handle — the same
  // ordering main/index.ts's own before-quit handler is careful to avoid (see
  // EventsRepo.flush's doc comment).
  repos.events.flush()
  db.close()
  for (const d of dirs.splice(0)) {
    try {
      // Same EPERM dance as diagram-watch.spec.ts: observeBranch spawns git
      // against this directory on turn end, and Windows will not remove a
      // directory a live child process still holds onto.
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // A leftover temp directory is not worth failing this suite over.
    }
  }
}

/** A minimal runnable suite — the fields verifyPrompt/noteSuite actually read. */
function planned(id: string): PlannedSuite {
  return {
    suite: { id, kind: 'unit', label: id, acceptance: `${id} works`, command: `run ${id}`, needs: 'node' },
    unavailable: null,
  }
}

/**
 * Deliver one suite's SWB_VERIFY report straight through the manager's own
 * sink — the same object HostedSession was constructed with (makeSink), so it
 * exercises the real scanMarkers → scanIsolatedSuiteReport path without
 * needing a real SDK message to carry it. Mirrors diagram-watch.spec.ts's
 * `finishTurn`, which reaches into `session.options` the same way.
 */
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

      // Without the isolation fix (a shared container, or a suite 2 dispatch
      // that does not wait on suite 1's own stop()) this would see "start:B"
      // land before "stop:A" — two containers alive together is exactly the
      // bug this feature exists to remove.
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

      // Suite a settled and its own session is on its way out — this is the
      // isolated watch's whole reason to exist, distinct from the
      // shared-container watch that finishes the WHOLE run on its first
      // report (see watchVerifyReport's own comment for that bug).
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

      // The turn ends with no SWB_VERIFY line ever sent — reached the same way
      // diagram-watch.spec.ts reaches a turn end, by driving the private
      // status-change path directly rather than a fabricated SDK message.
      const inner = manager as unknown as {
        handleStatusChange: (entry: unknown, status: string) => void
        hosted: Map<string, unknown>
      }
      inner.handleStatusChange(inner.hosted.get(sessionId), 'done')

      await done
      const finished = repos.verifyRuns.byId(run.id)
      expect(finished?.report?.suites).toHaveLength(1)
      expect(finished?.report?.suites[0]).toMatchObject({ id: 'a', status: 'not_run' })
      // Never a pass, never silently dropped (FR-047's rule, held here too).
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
      // cancelVerifyRun's own finish() call is the last thing it does before
      // returning, so this is settled the instant the await above resolves —
      // no polling needed for the row itself.
      expect(repos.verifyRuns.byId(run.id)?.status).toBe('inconclusive')

      await done
      // The queue stopped: suite b's session was never started, whatever
      // order the interrupted suite a's own teardown happened to finish in.
      expect(startSpy).toHaveBeenCalledTimes(1)
    } finally {
      teardown(repos, db)
    }
  })
})

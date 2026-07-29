// A verification run's life: started against a session, finished by whatever the
// session reported, evidence attached afterwards, and history bounded. Drives the
// real repository and the real SessionManager scan — the e2e mock cannot prove
// either.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { VERIFY_MARKER, verifyPrompt, planSuites } from '@main/evals/verify-dispatch'
import { stackById } from '@shared/test-catalog'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: (projectId) => changed.push(projectId),
    onApiRequests: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const entry = { row: { id: 's1', projectId: project.id } }
  const drive = (name: 'scanVerifyReport' | 'closeUnreportedVerify') =>
    (kind?: string, payload?: unknown): void =>
      (manager as unknown as Record<string, (...args: unknown[]) => void>)[name](entry, kind, payload)
  const start = () =>
    repos.verifyRuns.start({
      projectId: project.id,
      stackId: 'node',
      sessionId: 's1',
      branch: 'main',
      requested: ['node-unit'],
    })
  return {
    repos,
    manager,
    projectId: project.id,
    changed,
    start,
    scan: drive('scanVerifyReport'),
    endTurn: () => drive('closeUnreportedVerify')(),
  }
}

/** An assistant_text payload carrying the run's report line. */
const line = (json: string): { text: string } => ({ text: `Done.\n${VERIFY_MARKER}: ${json}` })

describe('a verification run', () => {
  it('records what the session reported, with its figures intact', () => {
    const { repos, manager, projectId, changed, start, scan } = setup()
    const run = start()
    expect(run.status).toBe('running')
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan(
      'assistant_text',
      line('{"suites":[{"id":"node-unit","status":"pass","detail":"142 passed"}],"coverage":{"line":{"value":81,"source":"vitest"}}}'),
    )

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('pass')
    expect(stored?.report?.coverage.line).toEqual({ value: 81, source: 'vitest' })
    expect(stored?.requested).toEqual(['node-unit'])
    expect(stored?.finishedAt).not.toBeNull()
    expect(changed).toEqual([projectId])
  })

  it('is inconclusive, not passing, when the turn ends with no report', () => {
    const { repos, manager, start, endTurn } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    endTurn()
    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('inconclusive')
    expect(stored?.note).toContain('without reporting a result line')

    // And the run is closed once: a later turn ending cannot touch it again.
    endTurn()
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('inconclusive')
  })

  it('ignores the dispatch prompt, which names the sentinel itself', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    const node = stackById('node')!
    scan('prompt', { text: verifyPrompt(planSuites(node.suites, ['node-unit'], null), 'Node', null) })
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('running')
  })

  it('attaches evidence to the run it proves, without touching its verdict', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')
    scan('assistant_text', line('{"suites":[{"id":"node-unit","status":"pass","detail":"142 passed"}]}'))

    manager.watchVerifyReport('s1', run.id, 'evidence')
    scan(
      'assistant_text',
      line('{"evidence":[{"kind":"run","what":"POST /orders","result":"201","path":null}]}'),
    )

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('pass')
    expect(stored?.report?.evidence).toHaveLength(1)
    expect(stored?.report?.suites[0].detail).toBe('142 passed')
  })

  it('keeps the last 20 runs per project and drops the oldest first', () => {
    const { repos, projectId, start } = setup()
    const first = start()
    for (let i = 0; i < 20; i += 1) start()

    const list = repos.verifyRuns.listForProject(projectId)
    expect(list).toHaveLength(20)
    expect(repos.verifyRuns.byId(first.id)).toBeNull()
  })

  it('reports the newest still-running run, so a late report cannot rewrite a finished one', () => {
    const { repos, projectId, start } = setup()
    const older = start()
    repos.verifyRuns.finish(older.id, 'pass', null, null)
    const newer = start()

    expect(repos.verifyRuns.runningFor(projectId)?.id).toBe(newer.id)
  })
})

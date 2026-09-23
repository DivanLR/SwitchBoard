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
  const projectId = project.id
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onVerifyChanged: (projectId) => changed.push(projectId),    onDiagramsChanged: () => {},
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const entry = { row: { id: 's1', projectId: project.id } }
  const drive = (name: 'scanVerifyReport' | 'closeUnreportedVerify') =>
    (kind?: string, payload?: unknown): void =>
      (manager as unknown as Record<string, (...args: unknown[]) => void>)[name](entry, kind, payload)
  const start = () =>
    repos.verifyRuns.start({
      projectId,
      stackId: 'node',
      sessionId: 's1',
      branch: 'main',
      requested: ['node-unit'],
    })
  return {
    repos,
    manager,
    projectId,
    changed,
    start,
    scan: drive('scanVerifyReport'),
    endTurn: () => drive('closeUnreportedVerify')(),
    sweep: (deadlineMs: number): void =>
      (manager as unknown as Record<string, (ms: number) => void>).sweepStaleRuns(deadlineMs),
    backdate: (runId: string, minutes: number): void => {
      db.prepare('UPDATE verify_runs SET startedAt = ? WHERE id = ?').run(
        new Date(Date.now() - minutes * 60_000).toISOString(),
        runId,
      )
    },
  }
}

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

    endTurn()
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('inconclusive')
  })

  it('says the report line was unreadable, rather than that none arrived', () => {
    const { repos, manager, start, scan, endTurn } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', line('{"suites": [oops}'))
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('running')

    endTurn()
    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('inconclusive')
    expect(stored?.note).toContain('could not read as JSON')
  })

  it('still takes a clean report line that arrives after a broken one', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', line('{"suites": [oops}'))
    scan('assistant_text', line('{"suites":[{"id":"node-unit","status":"pass","detail":"142 passed"}]}'))

    expect(repos.verifyRuns.byId(run.id)?.status).toBe('pass')
  })

  it('ignores the dispatch prompt, which names the sentinel itself', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    const node = stackById('node')!
    scan('prompt', { text: verifyPrompt(planSuites(node.suites, ['node-unit']), 'Node') })
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

  it('closes a run whose session went quiet, without waiting for a restart', () => {
    const { repos, manager, projectId, changed, start, sweep, backdate } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')
    backdate(run.id, 90)

    sweep(45 * 60 * 1000)

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('inconclusive')
    expect(stored?.note).toContain('presumed dead')
    expect(stored?.finishedAt).not.toBeNull()
    expect(changed).toEqual([projectId])
  })

  it('leaves a run inside the deadline alone, however slow the suite is', () => {
    const { repos, changed, start, sweep, backdate } = setup()
    const run = start()
    backdate(run.id, 20)

    sweep(45 * 60 * 1000)

    expect(repos.verifyRuns.byId(run.id)?.status).toBe('running')
    expect(changed).toEqual([])
  })

  it('closes a cancelled run saying you stopped it, not that the session gave up', async () => {
    const { repos, manager, projectId, changed, start } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    await manager.cancelVerifyRun(run.id)

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('inconclusive')
    expect(stored?.note).toContain('You stopped this run')
    expect(changed).toEqual([projectId])
  })

  it('leaves a run that already finished exactly as it was', async () => {
    const { repos, manager, start } = setup()
    const run = start()
    repos.verifyRuns.finish(run.id, 'pass', null, null)

    await manager.cancelVerifyRun(run.id)

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('pass')
    expect(stored?.note).toBeNull()
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

describe('startup reconciliation of orphaned runs (FR-022)', () => {
  it('closes a verification run the previous launch never finished', () => {
    const { repos, manager, projectId } = setup()
    const run = repos.verifyRuns.start({
      projectId,
      stackId: 'node',
      sessionId: 'gone',
      branch: 'main',
      requested: ['node-unit'],
    })
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('running')

    manager.reconcileOnStartup()

    const after = repos.verifyRuns.byId(run.id)
    expect(after?.status).toBe('inconclusive')
    expect(after?.finishedAt).toBeTruthy()
    expect(after?.note).toContain('closed before this run reported')
    expect(repos.verifyRuns.runningFor(projectId)).toBeNull()
  })

  it('leaves an already-finished run exactly as it was', () => {
    const { repos, manager, projectId } = setup()
    const run = repos.verifyRuns.start({
      projectId,
      stackId: 'node',
      sessionId: 's',
      branch: 'main',
      requested: ['node-unit'],
    })
    repos.verifyRuns.finish(run.id, 'fail', null, 'one suite failed')
    manager.reconcileOnStartup()
    const after = repos.verifyRuns.byId(run.id)
    expect(after?.status).toBe('fail')
    expect(after?.note).toBe('one suite failed')
  })

})

describe('a second pass started before the first reported', () => {
  const REPORT = '{"suites":[{"id":"node-unit","status":"pass","detail":"12 passed"}]}'

  it('closes the abandoned run instead of misattributing the next report to it', () => {
    const { repos, manager, start, scan } = setup()
    const first = start()
    manager.watchVerifyReport('s1', first.id, 'suites')
    const second = start()
    manager.watchVerifyReport('s1', second.id, 'suites')

    const abandoned = repos.verifyRuns.byId(first.id)
    expect(abandoned?.status).toBe('inconclusive')
    expect(abandoned?.note).toContain('Another verification pass was started')
    expect(abandoned?.finishedAt).not.toBeNull()

    scan('assistant_text', line(REPORT))
    const landed = repos.verifyRuns.byId(second.id)
    expect(landed?.status).toBe('pass')
    expect(landed?.report?.suites[0].detail).toBe('12 passed')
    expect(repos.verifyRuns.byId(first.id)?.report).toBeNull()
  })

  it('leaves a run alone when the same run is watched again', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')
    manager.watchVerifyReport('s1', run.id, 'suites')
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('running')
    scan('assistant_text', line(REPORT))
    expect(repos.verifyRuns.byId(run.id)?.status).toBe('pass')
  })

  it('does not finish a run when the evidence pass is what gets abandoned', () => {
    const { repos, manager, start } = setup()
    const finished = start()
    manager.watchVerifyReport('s1', finished.id, 'evidence')
    const next = start()
    manager.watchVerifyReport('s1', next.id, 'suites')
    expect(repos.verifyRuns.byId(finished.id)?.status).toBe('running')
  })
})

describe('per-suite progress while the run is still going', () => {
  const suiteLine = (id: string, status: string): string =>
    `SWB_SUITE: {"id":"${id}","status":"${status}","detail":"done"}`

  it('records a suite the moment it reports, without settling the run', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', { text: suiteLine('node-unit', 'pass') })

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).toBe('running')
    expect(stored?.report?.suites).toEqual([
      { id: 'node-unit', label: 'node-unit', status: 'pass', detail: 'done' },
    ])
  })

  it('keeps every suite in the order they landed', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', { text: suiteLine('node-unit', 'pass') })
    scan('assistant_text', { text: suiteLine('node-e2e', 'fail') })

    expect(repos.verifyRuns.byId(run.id)?.report?.suites.map((s) => s.id)).toEqual([
      'node-unit',
      'node-e2e',
    ])
  })

  it('ignores a second announcement of the same suite', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', { text: suiteLine('node-unit', 'pass') })
    scan('assistant_text', { text: suiteLine('node-unit', 'fail') })

    expect(repos.verifyRuns.byId(run.id)?.report?.suites).toEqual([
      { id: 'node-unit', label: 'node-unit', status: 'pass', detail: 'done' },
    ])
  })

  it('lets the closing report overrule what progress claimed', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', { text: suiteLine('node-unit', 'pass') })
    scan('assistant_text', {
      text: 'SWB_VERIFY: {"suites":[{"id":"node-unit","status":"fail","detail":"1 failed"}]}',
    })

    const stored = repos.verifyRuns.byId(run.id)
    expect(stored?.status).not.toBe('running')
    expect(stored?.report?.suites).toEqual([
      { id: 'node-unit', label: 'node-unit', status: 'fail', detail: '1 failed' },
    ])
  })

  it('drops progress for a run that has already finished', () => {
    const { repos, manager, start, scan } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', {
      text: 'SWB_VERIFY: {"suites":[{"id":"node-unit","status":"pass","detail":"12 passed"}]}',
    })
    repos.verifyRuns.noteSuite(run.id, {
      id: 'node-e2e',
      label: 'node-e2e',
      status: 'pass',
      detail: 'late',
    })

    expect(repos.verifyRuns.byId(run.id)?.report?.suites.map((s) => s.id)).toEqual(['node-unit'])
  })
})

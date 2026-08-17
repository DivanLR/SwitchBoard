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
  const projectId = project.id
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: (projectId) => changed.push(projectId),
    onDiagramsChanged: () => {},
    onApiRequests: () => {},
    onApiChanged: () => {},
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
    /** Push a run's start time into the past, which is what the sweep reads. */
    backdate: (runId: string, minutes: number): void => {
      db.prepare('UPDATE verify_runs SET startedAt = ? WHERE id = ?').run(
        new Date(Date.now() - minutes * 60_000).toISOString(),
        runId,
      )
    },
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

  // "Never reported" and "reported something unreadable" used to close with the
  // same note, which sent the developer looking for output that was right there.
  it('says the report line was unreadable, rather than that none arrived', () => {
    const { repos, manager, start, scan, endTurn } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    scan('assistant_text', line('{"suites": [oops}'))
    // The watch stays open: a clean line may still be a moment behind.
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

  // The failure this exists for: a container killed by SIGKILL produces no turn
  // end, so nothing closed the run, and the launch-time reconcile could not reach
  // it while the app stayed up. The row read Running — with the Run button
  // disabled behind it — until the developer restarted the app.
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

  // Before this, a run the developer no longer wanted had to be waited out.
  it('closes a cancelled run saying you stopped it, not that the session gave up', async () => {
    const { repos, manager, projectId, changed, start } = setup()
    const run = start()
    manager.watchVerifyReport('s1', run.id, 'suites')

    // No hosted session here, so the interrupt fails — deliberately swallowed,
    // because the row still needs closing whether or not the session is alive.
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

// A run is closed by the session's turn ending. A container killed by SIGKILL (this
// app's bypass sessions have done that 18 times), an app that was killed, or a
// machine that slept never produces that turn end, so the row stayed 'running' for
// ever and the Tests section read it as a live run: the button said Running and
// refused to start another. Reproduced from a real stuck row dated 2026-07-29.
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
    // Inconclusive, never failed: nothing is known about what the suites did, and a
    // figure nothing measured is never reported as a result.
    expect(after?.status).toBe('inconclusive')
    expect(after?.finishedAt).toBeTruthy()
    expect(after?.note).toContain('closed before this run reported')
    // And the view's own "is a run live" question now answers no.
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

  it('closes an orphaned API eval run too, in that table’s own terminal word', () => {
    const { repos, manager, projectId } = setup()
    const run = repos.apiRuns.start({
      projectId,
      baseUrl: 'http://localhost:5000',
      target: 'local',
      sessionId: 'gone',
    })
    expect(repos.apiRuns.byId(run.id)?.status).toBe('running')
    manager.reconcileOnStartup()
    // api_runs has no 'inconclusive'; 'error' is its word for a run that proved nothing.
    expect(repos.apiRuns.byId(run.id)?.status).toBe('error')
  })
})

// One watch per session, so starting a second pass before the first has reported
// must close the first out rather than silently inherit its marker. Two ordinary
// clicks produce this: both buttons become live the moment a run finishes.
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
    // And it says so rather than sitting on a spinner forever.
    expect(abandoned?.finishedAt).not.toBeNull()

    scan('assistant_text', line(REPORT))
    const landed = repos.verifyRuns.byId(second.id)
    expect(landed?.status).toBe('pass')
    expect(landed?.report?.suites[0].detail).toBe('12 passed')
    // The first run keeps the honest outcome, never the second's figures.
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
    // An evidence watch has nothing to finish: the run it attaches to has already
    // reported, so replacing that watch must not mark anything inconclusive.
    const { repos, manager, start } = setup()
    const finished = start()
    manager.watchVerifyReport('s1', finished.id, 'evidence')
    const next = start()
    manager.watchVerifyReport('s1', next.id, 'suites')
    expect(repos.verifyRuns.byId(finished.id)?.status).toBe('running')
  })
})

// A run covering six suites used to be a spinner until every one of them had
// finished, so a slow suite and a stuck one looked identical. Each suite now
// announces itself as it lands, and the picker marks it.
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

  // Progress is allowed to be wrong in a way a verdict is not, so a suite states
  // its result once. A restatement later in the same turn is narration.
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

  // The closing report is the record: it overwrites the whole suites array, so a
  // suite ticked green by progress that the report calls failed loses.
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

  // A progress line arriving after the run settled must not reopen it.
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

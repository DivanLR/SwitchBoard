// An API eval set's life: started against a session, handed request data by the
// session's own output, then completed by the app making the calls. Drives the
// real repository and the real SessionManager scan.
//
// The point being protected here is the split. The session hands over DATA; the
// verdict is the app's. So a session that reports nothing must still finish the
// run (with a reason), and a run with nowhere to call must fail honestly rather
// than record calls it never made.
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/store/db'
import { createRepositories } from '@main/store/repositories'
import { SessionManager } from '@main/sessions/session-manager'
import { API_DATA_MARKER } from '@main/evals/api-dispatch'
import { completeApiRun, runApiCalls } from '@main/evals/api-runner'
import type { ApiRequestPlan } from '@shared/api-endpoints'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  const handed: { runId: string; requests: ApiRequestPlan[] }[] = []
  const changed: string[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onDiagramsChanged: () => {},
    onApiRequests: (_projectId, runId, requests) => handed.push({ runId, requests }),
    onApiChanged: (projectId) => changed.push(projectId),
    onProjectCommands: () => {},
    gate: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
  })
  const entry = { row: { id: 's1', projectId: project.id } }
  const drive =
    (name: 'scanApiRequests' | 'closeUnreportedApi') =>
    (kind?: string, payload?: unknown): void =>
      (manager as unknown as Record<string, (...args: unknown[]) => void>)[name](entry, kind, payload)
  return {
    repos,
    manager,
    projectId: project.id,
    handed,
    changed,
    sweep: (deadlineMs: number): void =>
      (manager as unknown as Record<string, (ms: number) => void>).sweepStaleRuns(deadlineMs),
    /** Push a run's start time into the past, which is what the sweep reads. */
    backdate: (runId: string, minutes: number): void => {
      db.prepare('UPDATE api_runs SET startedAt = ? WHERE id = ?').run(
        new Date(Date.now() - minutes * 60_000).toISOString(),
        runId,
      )
    },
    start: () =>
      repos.apiRuns.start({
        projectId: project.id,
        // Port 1 is never listening, which is what makes the honest-failure path
        // testable without a server.
        baseUrl: 'http://127.0.0.1:1',
        target: 'local',
        sessionId: 's1',
      }),
    scan: drive('scanApiRequests'),
    endTurn: () => drive('closeUnreportedApi')(),
  }
}

const DATA = `{"requests":[{"template":"/api/x/{id}","method":"GET","path":"/api/x/7","expect":{"status":200,"minItems":null,"mustContain":null},"note":"row 7 exists","dataSource":"oracle-sqlcl","dataQuery":"select 1 from dual"}]}`

describe('an API eval set', () => {
  it('hands the session request data to the app, and nothing else', () => {
    const { manager, projectId, handed, start, scan } = setup()
    const run = start()
    manager.watchApiRequests('s1', run.id)
    scan('assistant_text', { text: `Queried the database.\n${API_DATA_MARKER}: ${DATA}` })
    expect(handed).toEqual([
      {
        runId: run.id,
        requests: [
          expect.objectContaining({ method: 'GET', path: '/api/x/7', dataSource: 'oracle-sqlcl' }),
        ],
      },
    ])
    expect(projectId).toBeTruthy()
  })

  it('ignores the prompt that names the sentinel', () => {
    const { manager, handed, start, scan } = setup()
    const run = start()
    manager.watchApiRequests('s1', run.id)
    scan('prompt', { text: `Finish with ${API_DATA_MARKER}: ${DATA}` })
    expect(handed).toEqual([])
  })

  it('closes a run whose turn ended without data, with an empty set', () => {
    const { manager, handed, start, endTurn } = setup()
    const run = start()
    manager.watchApiRequests('s1', run.id)
    endTurn()
    expect(handed).toEqual([{ runId: run.id, requests: [] }])
  })

  it('records an error rather than a pass when there is nothing to call', async () => {
    const { repos, projectId, start } = setup()
    const run = start()
    await completeApiRun({
      repos,
      projectId,
      runId: run.id,
      requests: [],
      changed: () => {},
    })
    const finished = repos.apiRuns.byId(run.id)
    expect(finished?.status).toBe('error')
    expect(finished?.finishedAt).not.toBeNull()
  })

  it('keeps the newest run first and bounds the history', () => {
    const { repos, projectId, start } = setup()
    for (let i = 0; i < 22; i += 1) start()
    const list = repos.apiRuns.listForProject(projectId)
    expect(list).toHaveLength(20)
    expect(list[0].startedAt >= list[19].startedAt).toBe(true)
  })

  it('closes a cancelled eval set saying you stopped it', async () => {
    const { repos, manager, projectId, changed, start } = setup()
    const run = start()
    manager.watchApiRequests('s1', run.id)

    await manager.cancelApiRun(run.id)

    const stored = repos.apiRuns.byId(run.id)
    expect(stored?.status).toBe('error')
    expect(stored?.note).toContain('You stopped this run')
    expect(changed).toEqual([projectId])

    // And a second click cannot rewrite what the first one recorded.
    await manager.cancelApiRun(run.id)
    expect(repos.apiRuns.byId(run.id)?.note).toContain('You stopped this run')
    expect(changed).toEqual([projectId])
  })

  // Same orphan as a verification run, same cause, and the same repair: without
  // the sweep the row read Running until the app was restarted.
  it('closes a run whose session went quiet, and leaves a fresh one alone', () => {
    const { repos, projectId, changed, start, sweep, backdate } = setup()
    const stale = start()
    const fresh = start()
    backdate(stale.id, 90)

    sweep(45 * 60 * 1000)

    expect(repos.apiRuns.byId(stale.id)?.status).toBe('error')
    expect(repos.apiRuns.byId(stale.id)?.note).toContain('presumed dead')
    expect(repos.apiRuns.byId(fresh.id)?.status).toBe('running')
    expect(changed).toEqual([projectId])
  })
})

describe('runApiCalls', () => {
  const request: ApiRequestPlan = {
    template: '/api/x',
    method: 'GET',
    path: '/api/x',
    body: null,
    headers: null,
    expect: { status: 200, minItems: null, mustContain: null },
    note: null,
    dataSource: null,
    dataQuery: null,
  }

  it('says nothing is listening instead of marking the endpoint failed', async () => {
    const outcome = await runApiCalls(
      {
        baseUrl: 'http://127.0.0.1:1',
        startCmd: null,
        cwd: process.cwd(),
        from: 'test',
        target: 'local' as const,
        headers: null,
      },
      [request],
    )
    expect(outcome.launched).toBe(false)
    expect(outcome.note).toContain('Nothing is listening')
    // 'not_run', never 'fail': an unreachable port says nothing about the code.
    expect(outcome.calls[0].outcome).toBe('not_run')
    expect(outcome.calls[0].status).toBeNull()
  })

  it('reports an empty request set rather than a passing run', async () => {
    const outcome = await runApiCalls(
      {
        baseUrl: 'http://127.0.0.1:1',
        startCmd: null,
        cwd: process.cwd(),
        from: 'test',
        target: 'local' as const,
        headers: null,
      },
      [],
    )
    expect(outcome.calls).toEqual([])
    expect(outcome.note).toContain('No request data')
  })
})

/**
 * A stand-in for a deployed environment: a real socket, so the run takes the same
 * path it takes against QA, and a record of what actually arrived — which is the
 * only way to prove a blocked write was never sent rather than merely reported as
 * blocked.
 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  work: (baseUrl: string, seen: string[]) => Promise<void>,
): Promise<void> {
  // The run's own reachability probe (a bare GET /) is dropped: it is how the
  // runner decides whether a server is there at all, not a planned call.
  const seen: string[] = []
  const server = createServer((req, res) => {
    const line = `${req.method} ${req.url}`
    if (line !== 'GET /') seen.push(line)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await work(`http://127.0.0.1:${port}`, seen)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const qaHost = (baseUrl: string) => ({
  baseUrl,
  startCmd: null,
  cwd: process.cwd(),
  from: 'test',
  target: 'qa' as const,
  headers: { 'x-api-key': 'k' },
})

describe('a run against a deployed QA environment', () => {
  const request: ApiRequestPlan = {
    template: '/api/x',
    method: 'GET',
    path: '/api/x',
    body: null,
    headers: null,
    expect: { status: 200, minItems: null, mustContain: null },
    note: null,
    dataSource: null,
    dataQuery: null,
  }

  it('never puts a write on the wire, whatever the plan says', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
      },
      async (baseUrl, seen) => {
        const outcome = await runApiCalls(qaHost(baseUrl), [
          { ...request, method: 'GET', path: '/api/x' },
          { ...request, method: 'DELETE', path: '/api/x/1', expect: { status: 204, minItems: null, mustContain: null } },
          { ...request, method: 'POST', path: '/api/x', body: '{}', expect: { status: 201, minItems: null, mustContain: null } },
        ])
        // The read happened; neither write reached the server at all.
        expect(seen).toEqual(['GET /api/x'])
        expect(outcome.calls[1].outcome).toBe('not_run')
        expect(outcome.calls[2].outcome).toBe('not_run')
        expect(outcome.calls[1].detail).toContain('blocked')
        expect(outcome.note).toContain('2 write requests were not sent')
        // Blocked, not failed: nothing here says the write endpoint is broken.
        expect(outcome.calls[1].status).toBeNull()
      },
    )
  })

  it('sends the same writes on a local run, which the developer owns', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
      },
      async (baseUrl, seen) => {
        await runApiCalls({ ...qaHost(baseUrl), target: 'local', headers: null }, [
          { ...request, method: 'DELETE', path: '/api/x/1', expect: { status: 200, minItems: null, mustContain: null } },
        ])
        expect(seen).toEqual(['DELETE /api/x/1'])
      },
    )
  })

  it('judges the whole body, so a long correct response is not failed for its length', async () => {
    // 400 items is comfortably past the 2000-character display limit: the check
    // used to run on the truncated copy, which no longer parsed as JSON.
    const items = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` }))
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(items))
      },
      async (baseUrl) => {
        const outcome = await runApiCalls({ ...qaHost(baseUrl), target: 'local', headers: null }, [
          { ...request, expect: { status: 200, minItems: 400, mustContain: null } },
        ])
        expect(outcome.calls[0].outcome).toBe('pass')
        expect(outcome.calls[0].detail).toBeNull()
        // Stored truncated all the same: the report is evidence, not an archive.
        expect((outcome.calls[0].body ?? '').length).toBeLessThanOrEqual(2_000)
      },
    )
  })

  it('carries the environment headers on every call it does send', async () => {
    let apiKey: string | undefined
    await withServer(
      (req, res) => {
        apiKey = req.headers['x-api-key'] as string | undefined
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
      },
      async (baseUrl) => {
        await runApiCalls(qaHost(baseUrl), [request])
        expect(apiKey).toBe('k')
      },
    )
  })
})

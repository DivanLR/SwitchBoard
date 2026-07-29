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

function setup() {
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const project = repos.projects.insert({ name: 'a', path: 'C:\\a', source: 'manual' })
  const handed: { runId: string; requests: ApiRequestPlan[] }[] = []
  const manager = new SessionManager(repos, {
    onEvent: () => {},
    onSessionStatus: () => {},
    onCountersChanged: () => {},
    onSessionExit: () => {},
    onQueueChanged: () => {},
    onEvalsChanged: () => {},
    onVerifyChanged: () => {},
    onApiRequests: (_projectId, runId, requests) => handed.push({ runId, requests }),
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
    start: () =>
      repos.apiRuns.start({
        projectId: project.id,
        // Port 1 is never listening, which is what makes the honest-failure path
        // testable without a server.
        baseUrl: 'http://127.0.0.1:1',
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
      { baseUrl: 'http://127.0.0.1:1', startCmd: null, cwd: process.cwd(), from: 'test' },
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
      { baseUrl: 'http://127.0.0.1:1', startCmd: null, cwd: process.cwd(), from: 'test' },
      [],
    )
    expect(outcome.calls).toEqual([])
    expect(outcome.note).toContain('No request data')
  })
})

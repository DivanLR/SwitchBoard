// The test report, the duration estimate, and the headers a deployed environment
// carries.
//
// Each of these is a place where the app could start inventing things — a report
// that summarises rather than transcribes, an estimate presented as a measurement,
// an API key sent as the literal text "${VAR}" — so each is checked for the honest
// behaviour rather than only the happy one.
import { describe, expect, it } from 'vitest'
import { apiReportFileName, apiReportMarkdown, reportFindings } from '@shared/api-report'
import { estimateRunMs, humanDuration } from '@shared/domain'
import { resolveHeaders } from '@main/evals/api-scan'
import type { ApiCall, ApiEvalRun } from '@shared/api-endpoints'

const call = (over: Partial<ApiCall> & { path?: string } = {}): ApiCall => ({
  request: {
    template: '/api/customers/{id}',
    method: 'GET',
    path: over.path ?? '/api/customers/4417',
    body: null,
    headers: null,
    expect: { status: 200, minItems: 3, mustContain: null },
    note: 'customer 4417 has 3 contracts',
    dataSource: 'oracle-sqlcl',
    dataQuery: 'select count(*) from contract where customer_no = 4417',
    ...(over.request ?? {}),
  },
  status: 200,
  ms: 42,
  body: '[{"id":1},{"id":2},{"id":3}]',
  outcome: 'pass',
  detail: null,
  ...over,
})

const run = (over: Partial<ApiEvalRun> = {}): ApiEvalRun => ({
  id: 'run-1',
  projectId: 'p1',
  baseUrl: 'http://localhost:5057',
  target: 'local',
  launched: true,
  sessionId: 's1',
  status: 'pass',
  note: null,
  calls: [call()],
  startedAt: '2026-07-31T08:00:00.000Z',
  finishedAt: '2026-07-31T08:02:00.000Z',
  ...over,
})

describe('apiReportMarkdown', () => {
  it('reports the status and the query that were actually recorded', () => {
    const text = apiReportMarkdown(run(), { projectName: 'External API' })
    expect(text).toContain('/api/customers/4417')
    expect(text).toContain('200')
    expect(text).toContain('select count(*) from contract where customer_no = 4417')
    expect(text).toContain('oracle-sqlcl')
    expect(text).toContain('**Environment:** local')
  })

  it('names QA as the environment and says nothing was started there', () => {
    const text = apiReportMarkdown(
      run({ target: 'qa', baseUrl: 'https://qa.example.com', launched: false }),
      { projectName: 'External API' },
    )
    expect(text).toContain('QA (deployed)')
    expect(text).toContain('https://qa.example.com')
    expect(text).toMatch(/nothing was started/i)
  })

  it('never puts a header VALUE in the report, only its name', () => {
    const text = apiReportMarkdown(
      run({
        calls: [
          call({
            request: { ...call().request, headers: { 'x-api-key': 'super-secret-value' } },
          }),
        ],
      }),
      { projectName: 'External API' },
    )
    expect(text).toContain('x-api-key')
    expect(text).not.toContain('super-secret-value')
  })

  it('says a run that called nothing proved nothing', () => {
    const text = apiReportMarkdown(
      run({ calls: [], status: 'error', note: 'The API never started listening.' }),
      { projectName: 'External API' },
    )
    expect(text).toMatch(/proves nothing/i)
    expect(text).toContain('The API never started listening.')
  })

  it('names the run and the day in the file name', () => {
    expect(apiReportFileName(run())).toBe('api-customers-2026-07-31-Test-Report.md')
  })
})

describe('report redaction', () => {
  it('masks long identifiers in the body, the query and the path, keeping their length', () => {
    const text = apiReportMarkdown(
      run({
        calls: [
          call({
            path: '/v1/account/10201304100023231874',
            request: {
              ...call().request,
              path: '/v1/account/10201304100023231874',
              dataQuery: 'select * from account where account_no = 10201304100023231874',
            },
            body: '{"account_no":10201304100023231874,"notes":3}',
          }),
        ],
      }),
      { projectName: 'External API' },
    )
    expect(text).not.toContain('10201304100023231874')
    expect(text).toContain('<redacted:20 digits>')
    // The facts that make the report worth reading survive.
    expect(text).toContain('"notes":3')
    expect(text).toContain('select * from account where account_no =')
  })

  it('leaves counts, statuses and dates alone', () => {
    const text = apiReportMarkdown(run(), { projectName: 'External API' })
    expect(text).toContain('200')
    expect(text).toContain('2026-07-31')
    expect(text).toContain('4417')
  })

  it('says on the page that the file holds live data', () => {
    expect(apiReportMarkdown(run(), { projectName: 'External API' })).toContain('Live data')
  })

  it('names the split when some calls answered and others never went out', () => {
    const text = apiReportMarkdown(
      run({
        status: 'error',
        calls: [call(), call({ outcome: 'not_run', status: null, detail: 'timed out' })],
      }),
      { projectName: 'External API' },
    )
    expect(text).toContain('1 of 2 calls completed, 1 never went out')
  })
})

describe('reportFindings', () => {
  it('leads with the failure and quotes its reason', () => {
    const findings = reportFindings(
      run({
        status: 'fail',
        calls: [call({ outcome: 'fail', status: 404, detail: 'expected 200, got 404' })],
      }),
    )
    expect(findings[0]).toContain('Failure')
    expect(findings[0]).toContain('expected 200, got 404')
  })

  it('separates a call that never completed from one that failed', () => {
    const findings = reportFindings(
      run({ calls: [call({ outcome: 'not_run', status: null, detail: 'connection refused' })] }),
    )
    expect(findings[0]).toContain('Not run')
    expect(findings[0]).toMatch(/not a failure of the endpoint/i)
  })

  it('flags a pass that was checked on nothing but a status', () => {
    const findings = reportFindings(
      run({
        calls: [
          call({
            request: {
              ...call().request,
              expect: { status: 200, minItems: null, mustContain: null },
            },
          }),
        ],
      }),
    )
    expect(findings.some((f) => f.includes('Weak check'))).toBe(true)
  })

  it('flags inputs that trace to no query', () => {
    const findings = reportFindings(
      run({ calls: [call({ request: { ...call().request, dataQuery: null } })] }),
    )
    expect(findings.some((f) => f.includes('Weak evidence'))).toBe(true)
  })

  it('has nothing to say about a run where every check held', () => {
    expect(reportFindings(run())).toEqual([])
  })
})

describe('estimateRunMs', () => {
  const past = (seconds: number, requested: string[] = ['a']) => ({
    startedAt: '2026-07-31T08:00:00.000Z',
    finishedAt: new Date(Date.parse('2026-07-31T08:00:00.000Z') + seconds * 1000).toISOString(),
    requested,
  })

  it('returns nothing at all when there is no finished run to learn from', () => {
    expect(estimateRunMs([])).toBeNull()
    expect(estimateRunMs([{ startedAt: '2026-07-31T08:00:00.000Z', finishedAt: null }])).toBeNull()
  })

  it('takes the median, so one long run does not move it', () => {
    // 60, 65, 70 and a 50-minute outlier: the answer stays a bit over a minute.
    const estimate = estimateRunMs([past(60), past(70), past(65), past(3000)])
    expect(estimate?.ms).toBe(67_500)
  })

  it('prefers past runs of the same suites and says so', () => {
    const estimate = estimateRunMs(
      [past(600, ['unit', 'mutation']), past(30, ['unit']), past(34, ['unit'])],
      (r) =>
        JSON.stringify((r as unknown as { requested: string[] }).requested) ===
        JSON.stringify(['unit']),
    )
    expect(estimate?.ms).toBe(32_000)
    expect(estimate?.comparable).toBe(true)
    expect(estimate?.basis).toContain('same suites')
  })

  it('falls back to other runs, labelled as a different selection', () => {
    const estimate = estimateRunMs([past(120, ['unit'])], () => false)
    expect(estimate?.ms).toBe(120_000)
    expect(estimate?.comparable).toBe(false)
    expect(estimate?.basis).toContain('different suites')
  })

  it('ignores a duration a clock change made impossible', () => {
    const backwards = {
      startedAt: '2026-07-31T08:05:00.000Z',
      finishedAt: '2026-07-31T08:00:00.000Z',
    }
    expect(estimateRunMs([backwards])).toBeNull()
    expect(estimateRunMs([backwards, past(45)])?.ms).toBe(45_000)
  })
})

describe('humanDuration', () => {
  it('speaks in the units a developer plans in', () => {
    expect(humanDuration(1_000)).toBe('1s')
    expect(humanDuration(45_600)).toBe('46s')
    expect(humanDuration(150_000)).toBe('2m 30s')
    expect(humanDuration(120_000)).toBe('2m')
    expect(humanDuration(3_900_000)).toBe('1h 5m')
  })
})

describe('resolveHeaders', () => {
  it('resolves a ${VAR} reference from the environment', () => {
    const result = resolveHeaders('x-api-key: ${QA_KEY}', { QA_KEY: 'abc123' })
    expect(result).toEqual({ headers: { 'x-api-key': 'abc123' } })
  })

  it('refuses to send the reference itself when the variable is unset', () => {
    const result = resolveHeaders('x-api-key: ${QA_KEY}', {})
    expect('error' in result).toBe(true)
    expect('error' in result && result.error).toContain('QA_KEY')
  })

  it('treats an empty variable as unset rather than as an empty key', () => {
    expect('error' in resolveHeaders('x-api-key: ${QA_KEY}', { QA_KEY: '' })).toBe(true)
  })

  it('has no headers to add when none are configured', () => {
    expect(resolveHeaders(undefined, {})).toEqual({ headers: null })
    expect(resolveHeaders('   ', {})).toEqual({ headers: null })
  })

  it('reads several lines, and a value containing a colon', () => {
    const result = resolveHeaders('x-api-key: k\nauthorization: Bearer abc:def', {})
    expect(result).toEqual({
      headers: { 'x-api-key': 'k', authorization: 'Bearer abc:def' },
    })
  })
})

import { describe, expect, it } from 'vitest'
import { verifyVerdict } from '@shared/domain'
import { stackById, defaultSelection } from '@shared/test-catalog'
import {
  parseVerifyReport,
  planSuites,
  verifyMarkerBroken,
  verifyPrompt,
  VERIFY_MARKER,
} from '@main/verify/verify-dispatch'

const dotnet = stackById('dotnet')!

describe('planning a run', () => {
  it('leaves slow suites out of the default selection', () => {
    const chosen = defaultSelection(dotnet.suites)
    expect(chosen).toContain('dotnet-unit')
    expect(chosen).not.toContain('dotnet-mutation')
  })

  it('tells the session what to run and why, in order', () => {
    const prompt = verifyPrompt(planSuites(dotnet.suites, ['dotnet-unit']), '.NET')
    expect(prompt).toContain('STOP at the first one that fails')
    expect(prompt).toContain(VERIFY_MARKER)
  })
})

describe('reading the report back', () => {
  const line = (json: string): string => `Ran everything.\n\n${VERIFY_MARKER}: ${json}`

  it('reads suites, coverage and the quality gate off the marker line', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'node-unit', status: 'pass', detail: '142 passed' }],
          coverage: { line: { value: 81.4, source: 'vitest --coverage' }, changed: { value: 93, source: 'diff' }, files: [{ path: 'a.ts', pct: 40 }] },
          quality: { gate: 'pass', gateSource: 'sonarqube', duplication: { value: 1.2, source: 'sonarqube' }, debt: '2d 4h' },
        }),
      ),
    )
    expect(report?.suites[0]).toMatchObject({ id: 'node-unit', status: 'pass' })
    expect(report?.coverage.line.value).toBe(81.4)
    expect(report?.coverage.files).toEqual([{ path: 'a.ts', pct: 40 }])
    expect(report?.quality.gate).toBe('pass')
    expect(report?.quality.debt).toBe('2d 4h')
    expect(verifyVerdict(report!)).toBe('pass')
  })

  it('keeps an unmeasured figure null rather than turning it into zero', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"pass","detail":""}],"coverage":{"line":"unknown"},"quality":{"gate":"not_configured","mutation":null}}'),
    )
    expect(report?.coverage.line).toEqual({ value: null, source: null })
    expect(report?.quality.mutation.value).toBeNull()
    expect(report?.quality.gate).toBe('not_configured')
  })

  it('accepts the shapes a model actually emits: percent strings, fences, prose after', () => {
    const report = parseVerifyReport(
      `${VERIFY_MARKER}: \`\`\`json\n{"suites":[{"id":"py-unit","status":"PASS","detail":"9 passed"}],"coverage":{"line":"82%"}}\n\`\`\``,
    )
    expect(report?.suites[0].status).toBe('pass')
    expect(report?.coverage.line.value).toBe(82)
  })

  it('takes the LAST marker, so the prompt echoing the sentinel is never the answer', () => {
    const report = parseVerifyReport(
      `I will finish with ${VERIFY_MARKER}: {"suites":[{"id":"node-unit","status":"fail","detail":"echo"}]}\n` +
        `${VERIFY_MARKER}: {"suites":[{"id":"node-unit","status":"pass","detail":"real"}]}`,
    )
    expect(report?.suites[0].detail).toBe('real')
  })

  it('refuses a status it does not recognise, rather than reading it as a pass', () => {
    const report = parseVerifyReport(line('{"suites":[{"id":"node-unit","status":"probably fine","detail":""}]}'))
    expect(report?.suites[0].status).toBe('not_run')
    expect(verifyVerdict(report!)).toBe('inconclusive')
  })

  it('returns nothing when there is no marker or the JSON is broken', () => {
    expect(parseVerifyReport('All tests passed!')).toBeNull()
    expect(parseVerifyReport(line('{"suites": [oops}'))).toBeNull()
  })

  it('is not derailed by a closing brace in the prose after the report line', () => {
    const report = parseVerifyReport(
      `${VERIFY_MARKER}: {"suites":[{"id":"node-unit","status":"pass","detail":"41 passed"}],"coverage":{"line":88}}\n` +
        'Note: the coverage gate lives in vitest.config.ts (see the thresholds block }).',
    )
    expect(report?.suites[0].status).toBe('pass')
    expect(report?.coverage.line.value).toBe(88)
  })

  it('does not end the object early on a brace inside a string', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"fail","detail":"expected } got EOF"}]}'),
    )
    expect(report?.suites[0].detail).toBe('expected } got EOF')
  })

  it('tells a broken report line apart from no report line at all', () => {
    expect(verifyMarkerBroken('All tests passed!')).toBe(false)
    expect(verifyMarkerBroken(line('{"suites": [oops}'))).toBe(true)
    expect(verifyMarkerBroken(line('{"suites":[]}'))).toBe(false)
  })

  it('fails the run when any executed suite failed, whatever the quality figures say', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"pass","detail":""},{"id":"node-api","status":"fail","detail":"500 on /orders"}],"quality":{"gate":"pass"}}'),
    )
    expect(verifyVerdict(report!)).toBe('fail')
  })

  it('is inconclusive when everything was skipped — a skip is not a pass', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"dotnet-unit","status":"skipped","detail":"the CI has no browser installed"}]}'),
    )
    expect(verifyVerdict(report!)).toBe('inconclusive')
  })

  it('reads each endpoint call back with the row it was drawn from', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'dotnet-http', status: 'pass', detail: '4 calls' }],
          endpoints: [
            {
              method: 'get',
              path: '/api/v1/policies/{id}',
              status: 200,
              ms: 84,
              response: '{"id":"...","status":"Active"}',
              dataSource: 'postgres-prod (read only)',
              dataQuery: 'select id from policies limit 1',
              dataAssertion: 'status matches the row',
              outcome: 'PASS',
              detail: 'answered with the policy the query named',
            },
          ],
        }),
      ),
    )
    expect(report?.endpoints).toHaveLength(1)
    expect(report?.endpoints[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/policies/{id}',
      status: 200,
      ms: 84,
      outcome: 'pass',
      dataQuery: 'select id from policies limit 1',
    })
  })

  it('never invents a status, and never reads an unknown outcome as a pass', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'dotnet-http', status: 'fail', detail: 'timed out' }],
          endpoints: [
            { method: 'POST', path: '/api/v1/quotes', status: 'no response', outcome: 'probably fine' },
            { path: '/api/v1/orphan' },
            { method: 'GET', path: '/api/v1/health', status: 503, outcome: 'fail' },
          ],
        }),
      ),
    )
    expect(report?.endpoints).toHaveLength(2)
    expect(report?.endpoints[0]).toMatchObject({ status: null, ms: null, outcome: 'not_run' })
    expect(report?.endpoints[1]).toMatchObject({ status: 503, outcome: 'fail' })
  })

  it('has no endpoints at all when the run reported none', () => {
    const report = parseVerifyReport(line('{"suites":[{"id":"node-unit","status":"pass","detail":""}]}'))
    expect(report?.endpoints).toEqual([])
  })

  it('fails the run when a real call failed, even though every suite passed', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [
            { id: 'dotnet-unit', status: 'pass', detail: '318 passed' },
            { id: 'dotnet-http', status: 'pass', detail: 'all routes answered' },
          ],
          endpoints: [
            { method: 'GET', path: '/api/v1/policies/PL-1', status: 200, outcome: 'pass' },
            {
              method: 'GET',
              path: '/api/v1/policies/PL-0/contracts',
              status: 200,
              outcome: 'fail',
              detail: '200 with an empty list for an id that does not exist',
            },
          ],
        }),
      ),
    )
    expect(verifyVerdict(report!)).toBe('fail')
  })

  it('still passes when every real call passed alongside the suites', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'dotnet-http', status: 'pass', detail: 'ok' }],
          endpoints: [{ method: 'GET', path: '/api/v1/health', status: 200, outcome: 'pass' }],
        }),
      ),
    )
    expect(verifyVerdict(report!)).toBe('pass')
  })

  it('is not rescued from inconclusive by a call that never ran', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'dotnet-http', status: 'skipped', detail: 'no dotnet here' }],
          endpoints: [{ method: 'POST', path: '/api/v1/quotes', status: null, outcome: 'not_run' }],
        }),
      ),
    )
    expect(verifyVerdict(report!)).toBe('inconclusive')
  })

  it('does not report a quality shortfall as a failure, which is still not a test result', () => {
    const report = parseVerifyReport(
      line(
        JSON.stringify({
          suites: [{ id: 'dotnet-unit', status: 'pass', detail: 'ok' }],
          coverage: { line: { value: 4, source: 'coverlet' } },
          quality: { gate: 'fail', gateSource: 'sonarqube', duplication: { value: 40, source: 'sonarqube' } },
        }),
      ),
    )
    expect(verifyVerdict(report!)).toBe('pass')
  })
})

describe('asking for real endpoint calls', () => {
  const apiPlan = planSuites(dotnet.suites, ['dotnet-http'])

  it('names the connected database servers, and what to draw from them', () => {
    const prompt = verifyPrompt(apiPlan, '.NET', ['postgres-main', 'oracle-reporting'])
    expect(prompt).toContain('postgres-main')
    expect(prompt).toContain('oracle-reporting')
    expect(prompt).toContain('endpoints')
    expect(prompt).toMatch(/never (write|report) a status/i)
    expect(prompt).toContain('Read the schema through that server')
    expect(prompt).toMatch(/its dialect/i)
  })

  it('exempts the endpoint pass from the stop-at-first-failure rule', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-format', 'dotnet-http'])
    const prompt = verifyPrompt(plan, '.NET', ['postgres-main'])
    expect(prompt).toContain('STOP at the first one that fails')
    expect(prompt).toContain('exception to that stop rule')
    expect(prompt).toContain('even if an earlier suite failed')

    expect(verifyPrompt(planSuites(dotnet.suites, ['dotnet-format']), '.NET', [])).not.toContain(
      'exception to that stop rule',
    )
  })

  it('says plainly that there is no real data source, rather than staying silent', () => {
    const prompt = verifyPrompt(apiPlan, '.NET', [])
    expect(prompt).toContain('No database MCP server is connected')
    expect(prompt).toContain('Still call the endpoints')
    expect(prompt).toMatch(/"dataSource" and "dataQuery" to null/)
    expect(prompt).not.toContain('Get your inputs from the connected database MCP server')
  })

  it('does not ask for endpoint calls when no API suite is in the run', () => {
    const prompt = verifyPrompt(planSuites(dotnet.suites, ['dotnet-unit']), '.NET', ['postgres-main'])
    expect(prompt).not.toContain('postgres-main')
  })
})

describe('the Stryker invocation note', () => {
  it('is present whenever a mutation suite is in the run', () => {
    const dotnet = stackById('dotnet')!
    const plan = planSuites(dotnet.suites, ['dotnet-mutation'])
    const prompt = verifyPrompt(plan, '.NET')
    expect(prompt).toMatch(/must be started from a directory holding a TEST project/i)
    expect(prompt).toContain('--project')
  })

  it('is absent from a run with no mutation suite', () => {
    const dotnet = stackById('dotnet')!
    const plan = planSuites(dotnet.suites, ['dotnet-unit'])
    expect(verifyPrompt(plan, '.NET')).not.toMatch(/Running Stryker/i)
  })
})

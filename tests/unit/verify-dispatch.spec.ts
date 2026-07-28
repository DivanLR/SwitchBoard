// The verification run's contract with the session: what it is asked to run, and
// what is trusted from its answer. The rule under test throughout is FR-072 —
// a figure nothing measured must come back null, never a number.
import { describe, expect, it } from 'vitest'
import { verifyVerdict } from '@shared/domain'
import {
  stackById,
  defaultSelection,
  sandboxNeedsDotnet,
  sandboxTools,
  unavailableReason,
} from '@shared/test-catalog'
import { parseVerifyReport, planSuites, verifyPrompt, VERIFY_MARKER } from '@main/evals/verify-dispatch'

const dotnet = stackById('dotnet')!
const node = stackById('node')!

// The two sandbox images, as the planner sees them. `null` is a host session.
const NODE_BOX = sandboxTools(false)
const DOTNET_BOX = sandboxTools(true)

describe('planning a run', () => {
  it('marks the suites the bypass container cannot run, instead of attempting them', () => {
    const plan = planSuites(dotnet.suites, ['dotnet-unit', 'dotnet-arch'], NODE_BOX)
    expect(plan).toHaveLength(2)
    expect(plan.every((p) => p.unavailable?.includes('dotnet'))).toBe(true)

    // The same suites are fine when the session runs on the host.
    expect(planSuites(dotnet.suites, ['dotnet-unit'], null)[0].unavailable).toBeNull()
  })

  it('runs dotnet suites in the .NET sandbox image, which a .NET project gets', () => {
    expect(sandboxNeedsDotnet([{ stackId: 'dotnet', stackLabel: '.NET', suites: dotnet.suites }])).toBe(true)
    expect(sandboxNeedsDotnet([{ stackId: 'node', stackLabel: 'Node', suites: node.suites }])).toBe(false)
    expect(planSuites(dotnet.suites, ['dotnet-unit'], DOTNET_BOX)[0].unavailable).toBeNull()
    // Still no browser in there — a bigger image is not a different promise.
    expect(unavailableReason(node.suites.find((s) => s.id === 'node-e2e')!, DOTNET_BOX)).toContain('browser')
  })

  it('keeps node suites runnable in the container, but not browser ones', () => {
    expect(unavailableReason(node.suites.find((s) => s.id === 'node-unit')!, NODE_BOX)).toBeNull()
    expect(unavailableReason(node.suites.find((s) => s.id === 'node-e2e')!, NODE_BOX)).toContain('browser')
  })

  it('leaves slow suites out of the default selection, and unavailable ones too', () => {
    const chosen = defaultSelection(node.suites, NODE_BOX)
    expect(chosen).toContain('node-unit')
    expect(chosen).not.toContain('node-mutation') // heavy: opt in per run
    expect(chosen).not.toContain('node-e2e') // no browser in the container
  })

  it('tells the session what not to attempt, and why', () => {
    const prompt = verifyPrompt(planSuites(dotnet.suites, ['dotnet-unit'], NODE_BOX), '.NET', NODE_BOX)
    expect(prompt).toContain('Do NOT attempt these')
    expect(prompt).toContain('dotnet is not in the bypass container')
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

  it('fails the run when any executed suite failed, whatever the quality figures say', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"node-unit","status":"pass","detail":""},{"id":"node-api","status":"fail","detail":"500 on /orders"}],"quality":{"gate":"pass"}}'),
    )
    expect(verifyVerdict(report!)).toBe('fail')
  })

  it('is inconclusive when everything was skipped — a skip is not a pass', () => {
    const report = parseVerifyReport(
      line('{"suites":[{"id":"dotnet-unit","status":"skipped","detail":"dotnet is not in the bypass container"}]}'),
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
    // Method is normalised up, outcome down: the UI groups on both.
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
    // The unparseable status stays null rather than becoming 0, the outcome the
    // model made up drops to not_run, and the call with no method is discarded.
    expect(report?.endpoints).toHaveLength(2)
    expect(report?.endpoints[0]).toMatchObject({ status: null, ms: null, outcome: 'not_run' })
    expect(report?.endpoints[1]).toMatchObject({ status: 503, outcome: 'fail' })
  })

  it('has no endpoints at all when the run reported none', () => {
    const report = parseVerifyReport(line('{"suites":[{"id":"node-unit","status":"pass","detail":""}]}'))
    expect(report?.endpoints).toEqual([])
  })

  it('fails the run when a real call failed, even though every suite passed', () => {
    // This is the whole point of exercising real endpoints: the suite went green
    // against fixtures while the real request was wrong. A verdict blind to the
    // call would report the green suite and hide what was actually broken.
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
    // A skipped suite plus a not_run call proved nothing at all.
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
    // The endpoint change must not have widened FR-071: a missed coverage or
    // duplication threshold is reported and never flips the verdict.
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
  const apiPlan = planSuites(dotnet.suites, ['dotnet-http'], null)

  it('names the connected database servers, and what to draw from them', () => {
    const prompt = verifyPrompt(apiPlan, '.NET', null, ['postgres-main', 'oracle-reporting'])
    expect(prompt).toContain('postgres-main')
    expect(prompt).toContain('oracle-reporting')
    expect(prompt).toContain('endpoints')
    // The one figure that must never be invented is named as such.
    expect(prompt).toMatch(/never (write|report) a status/i)
    // And the schema is to be read, not guessed: a wrong table name fails in a way
    // that looks exactly like a broken API when the API is fine.
    expect(prompt).toContain('Read the schema through that server')
    expect(prompt).toMatch(/its dialect/i)
  })

  it('exempts the endpoint pass from the stop-at-first-failure rule', () => {
    // A formatting or coverage failure says nothing about whether the API
    // answers, so gating the one thing the developer came for behind it would
    // hide the answer. The exception is stated where the stop rule is given.
    const plan = planSuites(dotnet.suites, ['dotnet-format', 'dotnet-http'], null)
    const prompt = verifyPrompt(plan, '.NET', null, ['postgres-main'])
    expect(prompt).toContain('STOP at the first one that fails')
    expect(prompt).toContain('exception to that stop rule')
    expect(prompt).toContain('even if an earlier suite failed')

    // With no API suite, no exception is claimed — there is nothing to exempt.
    expect(verifyPrompt(planSuites(dotnet.suites, ['dotnet-format'], null), '.NET', null, [])).not.toContain(
      'exception to that stop rule',
    )
  })

  it('says plainly that there is no real data source, rather than staying silent', () => {
    // Asserting only that a name is absent would be vacuous: it was never an input.
    // What matters is that the section still asks for the calls AND labels the
    // inputs as not drawn from real rows, so an unseeded run cannot be mistaken
    // for a verified one.
    const prompt = verifyPrompt(apiPlan, '.NET', null, [])
    expect(prompt).toContain('No database MCP server is connected')
    expect(prompt).toContain('Still call the endpoints')
    expect(prompt).toMatch(/"dataSource" and "dataQuery" to null/)
    // And it must not claim a source it does not have.
    expect(prompt).not.toContain('Get your inputs from the connected database MCP server')
  })

  it('does not ask for endpoint calls when no API suite is in the run', () => {
    const prompt = verifyPrompt(planSuites(dotnet.suites, ['dotnet-unit'], null), '.NET', null, ['postgres-main'])
    expect(prompt).not.toContain('postgres-main')
  })
})

// Tests section — the verify surface: pick a stack, choose the suites, run them
// through the session, and read what the run actually measured. The rule under
// test throughout is that a figure nothing measured shows as "—" and names why,
// never as a number the app filled in (spec 002 FR-072).
import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

/** A report shaped like the one the session emits on its marker line. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    suites: [
      { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed' },
      { id: 'node-api', label: 'HTTP smoke', status: 'pass', detail: '9 routes, all 2xx' },
    ],
    coverage: {
      line: { value: 81.4, source: 'vitest --coverage' },
      changed: { value: 93, source: 'coverage vs git diff' },
      files: [{ path: 'src/main/store/db.ts', pct: 41 }],
    },
    quality: {
      gate: 'pass',
      gateSource: 'sonarqube',
      duplication: { value: 1.2, source: 'sonarqube' },
      debt: '2d 4h',
      mutation: { value: 74, source: 'stryker' },
      survivors: ['db.ts:88 — removed the WAL pragma'],
      archViolations: { value: 0, source: 'architecture suite' },
      findings: [],
    },
    evidence: [],
    endpoints: [],
    ...over,
  }
}

/** One real HTTP call as the run reports it, drawn from a real row. */
function call(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'GET',
    path: '/api/v1/policies/{id}',
    status: 200,
    ms: 84,
    response: '{"id":"P-4417","status":"Active","contracts":3}',
    dataSource: 'postgres reporting (read only)',
    dataQuery: 'select id from policies where status = \'Active\' limit 1',
    dataAssertion: 'the row lists 3 contracts; the response listed 3',
    outcome: 'pass',
    detail: 'answered with the policy the query named',
    ...over,
  }
}

async function openTests(page: Page, scenario: MockScenario = twoProjectScenario()): Promise<void> {
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-view')).toBeVisible()
}

test('the section opens on a stack picker seeded by detection', async ({ page }) => {
  await openTests(page)
  await expect(page.getByTestId('tests-detect-hint')).toContainText('Node / Vue / Electron')
  await expect(page.getByTestId('tests-stack-dotnet')).toBeVisible()
  await expect(page.getByTestId('tests-stack-angular')).toBeVisible()
  await expect(page.getByTestId('tests-stack-python')).toBeVisible()
  // Detection is a hint, not a decision: the detected stack is only marked.
  await expect(page.getByTestId('tests-stack-node')).toContainText('DETECTED')
  await expect(page.getByTestId('tests-stack-dotnet')).not.toContainText('DETECTED')
})

test('before any run, every gate says nothing measured it', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  for (const id of ['unit', 'integration', 'architecture', 'mutation', 'coverage', 'quality-service']) {
    await expect(page.getByTestId(`tests-gate-${id}`)).toContainText('no run yet')
  }
  // The gate's own threshold is on the tile, so the target is never implied.
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('≥ 80% line')
})

test('a run sends the chosen suites to the session, and its report fills the gates', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('node-unit')
  // Slow suites stay out of a default run until they are ticked.
  expect(sent).not.toContain('node-mutation')

  // While it runs, the run is running — no figures invented in the meantime.
  await expect(page.getByTestId('tests-run')).toContainText('Running')
  await expect(page.getByTestId('tests-panel-evidence')).toContainText('running')

  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await expect(page.getByTestId('tests-gate-unit')).toContainText('passed')
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('93%')
  await expect(page.getByTestId('tests-gate-mutation')).toContainText('74%')
  await expect(page.getByTestId('tests-gate-quality-service')).toContainText('1.2% duplication')
  await expect(page.getByTestId('tests-result-node-unit')).toContainText('142 passed')
})

test('a figure the run did not measure stays a dash and names why', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r),
    report({
      coverage: { line: { value: null, source: null }, changed: { value: null, source: null }, files: [] },
      quality: {
        gate: 'not_configured',
        gateSource: null,
        duplication: { value: null, source: null },
        debt: null,
        mutation: { value: null, source: null },
        survivors: [],
        archViolations: { value: null, source: null },
        findings: [],
      },
    }),
  )

  await page.getByTestId('tests-sub-coverage').click()
  await expect(page.getByTestId('tests-coverage-line')).toContainText('—')
  await expect(page.getByTestId('tests-coverage-line')).toContainText('nothing measured it')

  await page.getByTestId('tests-sub-quality').click()
  await expect(page.getByTestId('tests-quality-gate')).toContainText('not connected')
  await expect(page.getByTestId('tests-quality-mutation')).toContainText('—')
})

test('the quality panel shows the service report, the mutants and the rule breaks', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      quality: {
        gate: 'fail',
        gateSource: 'sonarqube',
        duplication: { value: 4.8, source: 'sonarqube' },
        debt: '2d 4h',
        mutation: { value: 61, source: 'stryker' },
        survivors: ['db.ts:88 — removed the WAL pragma'],
        archViolations: { value: 2, source: 'architecture suite' },
        findings: ['Application depends on Infrastructure (OrdersHandler.cs:14)'],
      },
    }),
  )

  await expect(page.getByTestId('tests-gate-architecture')).toContainText('OrdersHandler')
  await page.getByTestId('tests-gate-quality-service').click()
  await expect(page.getByTestId('tests-panel-quality')).toContainText('sonarqube')
  await expect(page.getByTestId('tests-quality-debt')).toContainText('2d 4h')
  await expect(page.getByTestId('tests-panel-quality')).toContainText('removed the WAL pragma')
})

test('evidence is captured against the run and shows what actually executed', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  // Nothing to attach evidence to until a run exists.
  await expect(page.getByTestId('tests-evidence')).toBeDisabled()

  await page.getByTestId('tests-run').click()
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())
  await page.getByTestId('tests-evidence').click()

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('Capture evidence')

  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r),
    report({
      evidence: [
        { kind: 'run', what: 'POST /orders {"qty":2}', result: '201, body {"id":"o-1"}', path: null },
        { kind: 'screenshot', what: 'Orders list after the change', result: 'row rendered', path: 'C:\\shots\\orders.png' },
      ],
    }),
  )

  await expect(page.getByTestId('tests-evidence-0')).toContainText('POST /orders')
  await expect(page.getByTestId('tests-evidence-1')).toContainText('orders.png')
})

test('Run verification survives the clone boundary that used to break it', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-dotnet').click()

  // The bug: the button handed invoke the reactive array of selected suite ids,
  // and Electron's structuredClone rejects a Proxy. All 7 suites are ticked here,
  // which is the exact state that failed. The mock enforces the same clone, so a
  // dispatch landing at all is proof the request crossed the real boundary.
  await expect(page.getByTestId('tests-run')).toContainText('Run verification')
  await page.getByTestId('tests-run').click()

  await expect(page.getByTestId('tests-run')).toContainText('Running')
  await expect(page.getByTestId('tests-panel-evidence')).not.toContainText('could not be cloned')

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('dotnet-unit')
  expect(sent).toContain('dotnet-http')

  // And the guard is genuinely armed: a Proxy handed over directly is rejected,
  // so this test cannot pass because the boundary was quietly removed.
  const rejected = await page.evaluate(async () => {
    const proxy = new Proxy({ projectId: 'p-alpha' }, {})
    try {
      await window.switchboard.invoke('verify.list', proxy as never)
      return null
    } catch (error) {
      return (error as { message?: string }).message ?? 'rejected'
    }
  })
  expect(rejected).toContain('could not be cloned')
})

test('an API run shows each real call, the row behind it, and what the row proved', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r),
    report({
      endpoints: [
        call(),
        call({
          method: 'GET',
          path: '/api/v1/policies/does-not-exist',
          status: 404,
          ms: 12,
          dataAssertion: 'no row with that id, so 404 is the right answer',
          outcome: 'pass',
          detail: 'the should-fail case',
        }),
      ],
    }),
  )

  const first = page.getByTestId('tests-endpoint-0')
  await expect(first).toContainText('GET')
  await expect(first).toContainText('/api/v1/policies/{id}')
  await expect(first).toContainText('200')
  await expect(first).toContainText('84 ms')
  // The provenance is the point: which server, which query, and what it proved.
  await expect(first).toContainText('postgres reporting')
  await expect(first).toContainText('select id from policies')
  await expect(first).toContainText('the response listed 3')
  await expect(first).toContainText('"contracts":3')

  // A call that SHOULD fail is reported with what it actually returned.
  await expect(page.getByTestId('tests-endpoint-1')).toContainText('404')
  await expect(page.getByTestId('tests-endpoint-1')).toContainText('404 is the right answer')
})

test('a failed real call fails the integration gate, even with the suite green', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      // The suite reports pass. Only the real call caught it — which is the entire
      // reason the endpoint pass exists.
      suites: [
        { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed' },
        { id: 'node-api', label: 'HTTP smoke', status: 'pass', detail: '9 routes, all 2xx' },
      ],
      endpoints: [call({ status: 200, outcome: 'fail', detail: 'empty body for a real id' })],
    }),
  )

  await expect(page.getByTestId('tests-gate-integration')).toContainText('failed')
  await expect(page.getByTestId('tests-gate-integration')).toContainText('/api/v1/policies/{id}')
  // Unit is untouched: only the API gate answers for the API.
  await expect(page.getByTestId('tests-gate-unit')).toContainText('passed')
})

test('a run that reported nothing does not claim the API suite ran', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  // Inconclusive with no report at all: the session ended its turn without a
  // result line. Saying anything about what the API suite did would be invented.
  await page.evaluate(() => window.__mock.reportVerifyResult('p-alpha', 'inconclusive', null))

  await page.getByTestId('tests-sub-evidence').click()
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('reported nothing')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('No database MCP server')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('ran but reported')
})

test('with a database server connected and still no calls, it says exactly that', async ({ page }) => {
  // The fourth reason: everything was in place and the run reported no calls.
  const scenario = twoProjectScenario()
  scenario.settings = { ...scenario.settings, databaseMcpServers: ['postgres — production'] }
  await openTests(page, scenario)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await page.getByTestId('tests-sub-evidence').click()
  const empty = page.getByTestId('tests-endpoints-empty')
  await expect(empty).toContainText('reported no individual endpoint calls')
  // And it names the server that WAS available, so the gap is unambiguous.
  await expect(empty).toContainText('postgres — production')
})

test('a call that never completed shows no status at all, and does not read as a pass', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      endpoints: [
        call({ status: null, ms: null, response: null, outcome: 'not_run', detail: 'connection refused on :5001' }),
      ],
    }),
  )

  const row = page.getByTestId('tests-endpoint-0')
  await expect(row).toContainText('not run')
  await expect(row).toContainText('connection refused')
  await expect(row).toContainText('—')
  await expect(row).not.toContainText('200')
})

test('with no endpoint calls, the panel says which of the reasons it was', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()

  // Mid-run there is no report yet. Reading the report's suites here would say
  // "no API suite in this run" while the API suite was running, so the panel has
  // to read what the run was ASKED to cover instead.
  await page.getByTestId('tests-sub-evidence').click()
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('still going')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('No API suite')

  // node-api is in this report, so the missing piece is the database server.
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('No database MCP server was connected')

  // With no API suite in the run at all, it says that instead. The reason comes
  // from what the run was asked to cover, so this unticks the suite rather than
  // editing the report — editing the report would test nothing real.
  await page.getByTestId('tests-suite-node-api').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('No API suite in this run')
})

test('a run that reports nothing is inconclusive, never a pass', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(() => window.__mock.reportVerifyResult('p-alpha', 'inconclusive', null))

  await expect(page.getByTestId('tests-panel-evidence')).toContainText('inconclusive')
  await expect(page.getByTestId('tests-gate-unit')).not.toContainText('passed')
})

// --- The API eval set: the deterministic path -------------------------------
// What separates these from the tests above: no report line decides anything.
// The app sends the requests and computes the verdict, so the session's only
// contribution is data, and the panel shows the calls the app actually made.

/** One call as the app records it: the request it sent, and what came back. */
function apiCall(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: {
      template: '/api/customers/{id}',
      method: 'GET',
      path: '/api/customers/4417',
      body: null,
      headers: null,
      expect: { status: 200, minItems: 3, mustContain: null },
      note: 'customer 4417 has 3 contracts',
      dataSource: 'oracle-sqlcl',
      dataQuery: 'select customer_id from customers where rownum = 1',
    },
    status: 200,
    ms: 84,
    body: '{"id":4417,"contracts":[1,2,3]}',
    outcome: 'pass',
    detail: null,
    ...over,
  }
}

async function openApiPanel(page: Page): Promise<void> {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-sub-api').click()
  await expect(page.getByTestId('tests-panel-api')).toBeVisible()
}

test('the API panel offers the last tested endpoints and a search over the rest', async ({ page }) => {
  await openApiPanel(page)
  // Last tested first, so the common case is one click and no typing.
  await expect(page.getByTestId('tests-api-recent-0')).toContainText('/api/customers/{id}')
  await expect(page.getByTestId('tests-api-endpoint-0')).toContainText('/api/customers')
  await page.getByTestId('tests-api-search').fill('search')
  await expect(page.getByTestId('tests-api-endpoint-0')).toContainText('/api/customers/search')
  await expect(page.getByTestId('tests-api-endpoint-1')).toHaveCount(0)
  // Where the calls would go, and where that came from — never an implied port.
  await expect(page.getByTestId('tests-api-host-from')).toContainText('launchSettings.json')
})

test('running the set asks the session for data only, and the app reports the calls', async ({ page }) => {
  await openApiPanel(page)
  await expect(page.getByTestId('tests-api-run')).toBeDisabled()
  await page.getByTestId('tests-api-recent-0').click()
  await page.getByTestId('tests-api-run').click()

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('/api/customers/{id}')
  // The instruction is for data, not for a verdict.
  expect(sent).toContain('request data')
  await expect(page.getByTestId('tests-api-run')).toContainText('Running')

  await page.evaluate(
    (c) => window.__mock.reportApiResult('p-alpha', 'pass', [c]),
    apiCall(),
  )
  await expect(page.getByTestId('tests-api-call-0')).toContainText('200')
  await expect(page.getByTestId('tests-api-call-0')).toContainText('84 ms')
  // The check the app performed, in the terms it performed it.
  await expect(page.getByTestId('tests-api-call-0')).toContainText('status 200 · at least 3 items')
  await expect(page.getByTestId('tests-api-call-0')).toContainText('oracle-sqlcl')
})

test('a call that never completed shows no status, and the run says why', async ({ page }) => {
  await openApiPanel(page)
  await page.getByTestId('tests-api-recent-0').click()
  await page.getByTestId('tests-api-run').click()
  await page.evaluate(
    (c) => window.__mock.reportApiResult('p-alpha', 'error', [c], 'Nothing is listening on http://localhost:5057.'),
    apiCall({ status: null, ms: null, body: null, outcome: 'not_run', detail: 'the call did not complete: fetch failed' }),
  )
  await expect(page.getByTestId('tests-api-note')).toContainText('Nothing is listening')
  const call0 = page.getByTestId('tests-api-call-0')
  await expect(call0).toContainText('not run')
  await expect(call0).toContainText('—')
  await expect(call0).not.toContainText('pass')
})

test('a bypass session marks the suites its container cannot run, before the run', async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.projects[0].session!.bypassPermissions = true
  await openTests(page, scenario)
  await page.getByTestId('tests-stack-dotnet').click()

  // The container has node and nothing else: every .NET suite is out, and says so.
  await expect(page.getByTestId('tests-suite-dotnet-unit')).toBeDisabled()
  await expect(page.getByTestId('tests-suite-dotnet-unit')).toContainText('not in the bypass container')
  // Nothing left to run, so the run cannot start on an empty selection.
  await expect(page.getByTestId('tests-run')).toBeDisabled()

  // The same project's node suites are runnable there.
  await page.getByTestId('tests-change-stack').click()
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-suite-node-unit')).toBeEnabled()
  await expect(page.getByTestId('tests-suite-node-e2e')).toBeDisabled()
  await expect(page.getByTestId('tests-suite-node-e2e')).toContainText('browser is not in the bypass container')
})

test('slow suites are opt-in, and ticking one puts it in the next run', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-suite-node-mutation').click()
  await page.getByTestId('tests-run').click()

  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('node-mutation')
})

test('Manual QA keeps the eval loop, and the gates jump to the panel behind them', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  await page.getByTestId('tests-sub-qa').click()
  await expect(page.getByTestId('evals-view')).toBeVisible()

  await page.getByTestId('tests-gate-coverage').click()
  await expect(page.getByTestId('tests-panel-coverage')).toBeVisible()
  await expect(page.getByTestId('evals-view')).toHaveCount(0)

  await page.getByTestId('tests-sub-skill').click()
  await expect(page.getByTestId('tests-dev-skill')).toContainText('in development')
})

test('the working tree is the only verify target offered', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-target-tree')).toBeEnabled()
  // Last-commit and spec-criteria targets were advertised as "in development" and
  // permanently disabled. A target the app cannot verify is not offered at all:
  // an inert control on the screen that reports what a run measured only misleads.
  await expect(page.getByTestId('tests-target-head')).toHaveCount(0)
  await expect(page.getByTestId('tests-target-spec')).toHaveCount(0)
})

test('the stack choice persists per project and can be changed', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  // Leave the section and come back: no picker, the choice stuck.
  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  await page.getByTestId('tests-change-stack').click()
  await expect(page.getByTestId('tests-stack-node')).toBeVisible()
})

// A figure the app read out of the runner's own report file is different evidence
// from the same number typed into the session's report line, and the tile says so.
// The mark is the visible half of the artefact reconciliation the main process does.
test('a figure checked against the runner’s own report file is marked as checked', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r),
    report({
      suites: [
        { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed, 0 failed, per TestResults/r.trx', verified: true },
      ],
      coverage: {
        // A Cobertura report carries TOTAL line coverage and nothing about which
        // lines this working tree changed, so the line figure is artefact-backed
        // and the changed-line figure stays unmeasured rather than being derived.
        line: { value: 78.2, source: 'coverage/cobertura-coverage.xml', verified: true },
        changed: { value: null, source: null },
        files: [],
      },
    }),
  )

  // Read from a file the app parsed itself.
  await expect(page.getByTestId('tests-gate-verified-unit')).toBeVisible()
  await expect(page.getByTestId('tests-gate-verified-coverage')).toBeVisible()
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('78.2%')
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('cobertura')

  // ...and taken on the session's word, so it carries no mark. The figure is still
  // shown: unverified is not the same as unmeasured.
  await expect(page.getByTestId('tests-gate-verified-mutation')).toHaveCount(0)
  await expect(page.getByTestId('tests-gate-mutation')).toContainText('74%')
})

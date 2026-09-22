import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

async function startRun(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('tests-run').click()
  await expect(page.getByTestId('tests-run')).toContainText('Running')
}

async function lastSend(
  page: import('@playwright/test').Page,
  contains?: string,
): Promise<string> {
  let text = ''
  const poll = expect.poll(async () => {
    text = (await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)) ?? ''
    return text
  })
  if (contains) await poll.toContain(contains)
  else await poll.not.toBe('')
  return text
}

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
      mutationKilled: 31,
      mutationSurvived: 11,
      survivors: ['db.ts:88 — removed the WAL pragma'],
      archViolations: { value: 0, source: 'architecture suite' },
      findings: [],
    },
    evidence: [],
    endpoints: [],
    ...over,
  }
}

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

test('the headline quality figure counts gates, and says what it left out', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-score')).toHaveText('—')
  await expect(page.getByTestId('tests-score-sub')).toContainText('nothing measured yet')

  await startRun(page)
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  const sub = await page.getByTestId('tests-score-sub').textContent()
  const clean = /(\d+)\/(\d+) gates clean/.exec(sub ?? '')
  expect(clean).not.toBeNull()
  const [, passed, measured] = clean as RegExpExecArray
  const expected = Math.round((Number(passed) / Number(measured)) * 100)
  await expect(page.getByTestId('tests-score')).toHaveText(`${expected}%`)
})

test('a run takes its own session and leaves the conversation where it was', async ({ page }) => {
  await openTests(page)
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)

  await page.getByTestId('tests-stack-node').click()
  await startRun(page)

  const rows = page.getByTestId('sidebar-subsessions-alpha').getByTestId(/^sidebar-subsession-/)
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toHaveClass(/sel/)

  const sent = await lastSend(page)
  expect(sent).toContain('node-unit')
  const target = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId)
  expect(target).not.toBe('s-alpha')
})

test('a second run reuses the tests session rather than spawning another', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  const first = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId)

  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())
  await expect(page.getByTestId('tests-run')).toContainText('Run verification')
  await startRun(page)

  const second = await page.evaluate(() => window.__mock.state().sends.at(-1)?.sessionId)
  expect(second).toBe(first)
  const rows = page.getByTestId('sidebar-subsessions-alpha').getByTestId(/^sidebar-subsession-/)
  await expect(rows).toHaveCount(2)
})

test('the section opens on a stack picker seeded by detection', async ({ page }) => {
  await openTests(page)
  await expect(page.getByTestId('tests-detect-hint')).toContainText('Node / Vue / Electron')
  await expect(page.getByTestId('tests-stack-dotnet')).toBeVisible()
  await expect(page.getByTestId('tests-stack-angular')).toBeVisible()
  await expect(page.getByTestId('tests-stack-python')).toBeVisible()
  await expect(page.getByTestId('tests-stack-node')).toContainText('DETECTED')
  await expect(page.getByTestId('tests-stack-dotnet')).not.toContainText('DETECTED')
})

test('before any run, every gate says nothing measured it', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  for (const id of ['unit', 'integration', 'architecture', 'mutation', 'coverage', 'quality-service']) {
    await expect(page.getByTestId(`tests-gate-${id}`)).toContainText('no run yet')
  }
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('≥ 80% line')
})

test('a gate nothing measured can be accepted, and then reads green', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  const gate = page.getByTestId('tests-gate-mutation')
  await expect(gate).toContainText('no run yet')

  await page.getByTestId('tests-gate-accept-mutation').click()

  await expect(gate).toHaveClass(/gate pass/)
  await expect(gate).toContainText('accepted')
  await expect(gate).toContainText('you accepted this')

  await page.getByTestId('tests-gate-accept-mutation').click()
  await expect(gate).toContainText('no run yet')
  await expect(gate).not.toHaveClass(/gate pass/)
})

test('accepting a gate survives leaving the section, because it is a project fact', async ({
  page,
}) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-gate-accept-mutation').click()
  await expect(page.getByTestId('tests-gate-mutation')).toContainText('accepted')

  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-tests').click()

  await expect(page.getByTestId('tests-gate-mutation')).toContainText('accepted')
})

test('a measured figure offers no way to accept it away', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({ coverage: { line: { value: 11, source: 'a real runner' }, changed: null, files: [] } }),
  )

  const gate = page.getByTestId('tests-gate-coverage')
  await expect(gate).toContainText('11%')
  await expect(gate).toContainText('under target')
  await expect(page.getByTestId('tests-gate-accept-coverage')).toHaveCount(0)
})

test('a run sends the chosen suites to the session, and its report fills the gates', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)

  const sent = await lastSend(page)
  expect(sent).toContain('node-unit')
  expect(sent).not.toContain('node-mutation')

  await expect(page.getByTestId('tests-run')).toContainText('Running')
  await expect(page.getByTestId('tests-panel-evidence')).toContainText('running')

  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await expect(page.getByTestId('tests-gate-unit')).toContainText('passed')
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('93%')
  await expect(page.getByTestId('tests-gate-mutation')).toContainText('74%')
  await expect(page.getByTestId('tests-gate-quality-service')).toContainText('1.2% duplication')
  await expect(page.getByTestId('tests-result-node-unit')).toContainText('142 passed')
})

test('no suite offers a per-suite re-run control', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-suite-node-unit')).toBeVisible()
  await expect(page.getByTestId('tests-suite-rerun-node-unit')).toHaveCount(0)

  await startRun(page)
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await expect(page.getByTestId('tests-suite-node-unit')).toHaveClass(/ran-pass/)
  await expect(page.getByTestId('tests-suite-rerun-node-unit')).toHaveCount(0)
})

test('a ticked suite is visibly ticked even when its outcome left it grey', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      suites: [
        { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed' },
        { id: 'node-api', label: 'HTTP smoke', status: 'not_run', detail: 'no test database' },
      ],
    }),
  )

  const grey = page.getByTestId('tests-suite-node-api')
  await expect(grey).toHaveClass(/ran-not_run/)
  await expect(grey).toHaveClass(/ on/)

  const ringed = await grey.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(ringed).not.toBe('none')

  await grey.click()
  await expect(grey).not.toHaveClass(/ on/)
  const bare = await grey.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(bare).toBe('none')
})

test('a run in progress can be stopped, and the panel says who stopped it', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await expect(page.getByTestId('tests-run')).toContainText('Running')

  await page.getByTestId('tests-cancel').click()

  await expect(page.getByTestId('tests-run')).toContainText('Run verification')
  await expect(page.getByTestId('tests-run')).toBeEnabled()
  await expect(page.getByTestId('tests-run-state')).toContainText('inconclusive')
  await expect(page.getByTestId('tests-cancel')).toHaveCount(0)
})

test('a suite command can be corrected, and that is what the run sends', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  await page.getByTestId('tests-suite-edit-node-unit').click()
  const field = page.getByTestId('tests-suite-command-node-unit')
  await expect(field).toHaveValue('npm test')
  await field.fill('npm test --workspace packages/api')
  await field.blur()

  await expect(page.getByTestId('tests-suite-node-unit')).toContainText('edited')
  await expect(page.getByTestId('tests-suite-node-unit')).toHaveAttribute(
    'title',
    'npm test --workspace packages/api',
  )

  await page.getByTestId('tests-suite-edit-node-unit').click()
  await page.getByTestId('tests-suite-command-node-unit').fill('')
  await page.getByTestId('tests-suite-command-node-unit').blur()
  await expect(page.getByTestId('tests-suite-node-unit')).not.toContainText('edited')
  await expect(page.getByTestId('tests-suite-node-unit')).toHaveAttribute('title', 'npm test')
})

test('a figure the run did not measure stays a dash and names why', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
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
  await startRun(page)
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      quality: {
        gate: 'fail',
        gateSource: 'sonarqube',
        duplication: { value: 4.8, source: 'sonarqube' },
        debt: '2d 4h',
        mutation: { value: 61, source: 'stryker' },
        mutationKilled: 39,
        mutationSurvived: 25,
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
  await expect(page.getByTestId('tests-panel-quality')).toContainText('39 killed · 25 survived')
})

test('evidence is captured against the run and shows what actually executed', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-evidence')).toBeDisabled()

  await startRun(page)
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())
  await page.getByTestId('tests-evidence').click()

  const sent = await lastSend(page)
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

  await expect(page.getByTestId('tests-run')).toContainText('Run verification')
  await startRun(page)

  await expect(page.getByTestId('tests-run')).toContainText('Running')
  await expect(page.getByTestId('tests-panel-evidence')).not.toContainText('could not be cloned')

  const sent = await lastSend(page)
  expect(sent).toContain('dotnet-unit')
  expect(sent).toContain('dotnet-http')

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
  await startRun(page)
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
  await expect(first).toContainText('postgres reporting')
  await expect(first).toContainText('select id from policies')
  await expect(first).toContainText('the response listed 3')
  await expect(first).toContainText('"contracts":3')

  await expect(page.getByTestId('tests-endpoint-1')).toContainText('404')
  await expect(page.getByTestId('tests-endpoint-1')).toContainText('404 is the right answer')
})

test('a failed real call fails the integration gate, even with the suite green', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'fail', r),
    report({
      suites: [
        { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed' },
        { id: 'node-api', label: 'HTTP smoke', status: 'pass', detail: '9 routes, all 2xx' },
      ],
      endpoints: [call({ status: 200, outcome: 'fail', detail: 'empty body for a real id' })],
    }),
  )

  await expect(page.getByTestId('tests-gate-integration')).toContainText('failed')
  await expect(page.getByTestId('tests-gate-integration')).toContainText('/api/v1/policies/{id}')
  await expect(page.getByTestId('tests-gate-unit')).toContainText('passed')
})

test('a run that reported nothing does not claim the API suite ran', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(() => window.__mock.reportVerifyResult('p-alpha', 'inconclusive', null))

  await page.getByTestId('tests-sub-evidence').click()
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('reported nothing')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('No database MCP server')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('ran but reported')
})

test('with a database server connected and still no calls, it says exactly that', async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.settings = { ...scenario.settings, databaseMcpServers: ['postgres — production'] }
  await openTests(page, scenario)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await page.getByTestId('tests-sub-evidence').click()
  const empty = page.getByTestId('tests-endpoints-empty')
  await expect(empty).toContainText('reported no individual endpoint calls')
  await expect(empty).toContainText('postgres — production')
})

test('a call that never completed shows no status at all, and does not read as a pass', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
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
  await startRun(page)

  await page.getByTestId('tests-sub-evidence').click()
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('still going')
  await expect(page.getByTestId('tests-endpoints-empty')).not.toContainText('No API suite')

  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())

  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('No database MCP server was connected')

  await page.getByTestId('tests-suite-node-api').click()
  await startRun(page)
  await page.evaluate((r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r), report())
  await expect(page.getByTestId('tests-endpoints-empty')).toContainText('No API suite in this run')
})

test('a run that reports nothing is inconclusive, never a pass', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(() => window.__mock.reportVerifyResult('p-alpha', 'inconclusive', null))

  await expect(page.getByTestId('tests-panel-evidence')).toContainText('inconclusive')
  await expect(page.getByTestId('tests-gate-unit')).not.toContainText('passed')
})

test('a bypass session marks the suites its container cannot run, before the run', async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.projects[0].session!.bypassPermissions = true
  await openTests(page, scenario)
  await page.getByTestId('tests-stack-dotnet').click()

  await expect(page.getByTestId('tests-suite-dotnet-unit')).toBeDisabled()
  await expect(page.getByTestId('tests-suite-dotnet-unit')).toContainText('not in the bypass container')
  await expect(page.getByTestId('tests-run')).toBeDisabled()

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
  await startRun(page)

  const sent = await lastSend(page)
  expect(sent).toContain('node-mutation')
})

test('the panels jump from a gate tile, and the skill tab is the dev fallback', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  await page.getByTestId('tests-gate-coverage').click()
  await expect(page.getByTestId('tests-panel-coverage')).toBeVisible()

  await page.getByTestId('tests-sub-skill').click()
  await expect(page.getByTestId('tests-dev-skill')).toContainText('in development')
})

test('the working tree is the only verify target offered', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-target-tree')).toBeEnabled()
  await expect(page.getByTestId('tests-target-head')).toHaveCount(0)
  await expect(page.getByTestId('tests-target-spec')).toHaveCount(0)
})

test('the section uses the width it is given, rather than an 840px column', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  const pane = await page.getByTestId('tests-view').evaluate((el) => el.clientWidth)
  expect(pane).toBeGreaterThan(880)

  for (const id of ['tests-gates', 'tests-suites']) {
    const width = await page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().width)
    expect(width, id).toBeGreaterThan(840)
  }

  const prose = await page
    .getByTestId('tests-view')
    .locator('.intro')
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(prose).toBeLessThanOrEqual(841)
})

test('the section can take the whole window, and give it back', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()

  const before = await page.getByTestId('tests-view').evaluate((el) => el.clientWidth)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.getByTestId('tests-full-screen').click()

  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)
  await expect(page.getByTestId('tab-tests')).toHaveCount(0)
  await expect(page.getByTestId('inbox-rail')).toHaveCount(0)
  const after = await page.getByTestId('tests-view').evaluate((el) => el.clientWidth)
  expect(after).toBeGreaterThan(before)

  await page.getByTestId('tests-full-screen').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('tab-tests')).toBeVisible()
})

test('Escape leaves full screen, so the chrome is never trapped away', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-full-screen').click()
  await expect(page.getByTestId('tab-tests')).toHaveCount(0)

  await page.keyboard.press('Escape')

  await expect(page.getByTestId('tab-tests')).toBeVisible()
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('leaving the project hands the chrome back rather than stranding the app', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-full-screen').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await page.getByTestId('sidebar-project-beta').click()

  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await expect(page.getByTestId('tab-tests')).toBeVisible()
})

test('the stack choice persists per project and can be changed', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  await page.getByTestId('tab-session').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('tests-run')).toBeVisible()

  await page.getByTestId('tests-change-stack').click()
  await expect(page.getByTestId('tests-stack-node')).toBeVisible()
})

test('a figure checked against the runner’s own report file is marked as checked', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await startRun(page)
  await page.evaluate(
    (r) => window.__mock.reportVerifyResult('p-alpha', 'pass', r),
    report({
      suites: [
        { id: 'node-unit', label: 'Unit tests', status: 'pass', detail: '142 passed, 0 failed, per TestResults/r.trx', verified: true },
      ],
      coverage: {
        line: { value: 78.2, source: 'coverage/cobertura-coverage.xml', verified: true },
        changed: { value: null, source: null },
        files: [],
      },
    }),
  )

  await expect(page.getByTestId('tests-gate-verified-unit')).toBeVisible()
  await expect(page.getByTestId('tests-gate-verified-coverage')).toBeVisible()
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('78.2%')
  await expect(page.getByTestId('tests-gate-coverage')).toContainText('cobertura')

  await expect(page.getByTestId('tests-gate-verified-mutation')).toHaveCount(0)
  await expect(page.getByTestId('tests-gate-mutation')).toContainText('74%')
})

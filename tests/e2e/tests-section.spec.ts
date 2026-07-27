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

test('a run that reports nothing is inconclusive, never a pass', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await page.getByTestId('tests-run').click()
  await page.evaluate(() => window.__mock.reportVerifyResult('p-alpha', 'inconclusive', null))

  await expect(page.getByTestId('tests-panel-evidence')).toContainText('inconclusive')
  await expect(page.getByTestId('tests-gate-unit')).not.toContainText('passed')
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

test('only the working tree is scopeable; the other targets are marked', async ({ page }) => {
  await openTests(page)
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('tests-target-tree')).toBeEnabled()
  await expect(page.getByTestId('tests-target-head')).toBeDisabled()
  await expect(page.getByTestId('tests-target-head')).toContainText('in development')
  await expect(page.getByTestId('tests-target-spec')).toBeDisabled()
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

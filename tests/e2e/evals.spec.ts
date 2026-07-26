// Tests tab — the eval loop for a small change (spec 002 US7) run as
// Coordinator-Implementor-Verifier: implement (optionally as N isolated
// attempts), let the check report through the session, judge it, then rule.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('evals-view')).toBeVisible()
})

/** The row id, so the test can report a result the way the gate would. */
async function rowId(page: import('@playwright/test').Page): Promise<string> {
  const testId = await page.locator('[data-testid^="eval-row-"]').first().getAttribute('data-testid')
  return (testId ?? '').replace('eval-row-', '')
}

test('a line is added, verified through the session, judged and rated', async ({ page }) => {
  await expect(page.getByTestId('eval-count')).toHaveText('0 lines')

  await page.getByTestId('eval-acceptance').fill('end-session shows a bar until the row ends')
  await page.getByTestId('eval-check').fill('npx playwright test tests/e2e/project-actions.spec.ts')
  await page.getByTestId('eval-add').click()

  await expect(page.getByTestId('eval-count')).toHaveText('1 line')
  const row = page.locator('[data-testid^="eval-row-"]').first()
  const id = await rowId(page)
  await expect(row).toContainText('end-session shows a bar until the row ends')
  // Nothing verified yet: stage implement, check not run, pass blocked.
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('implement')
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check not run')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeDisabled()
  await expect(page.getByTestId(`eval-gated-${id}`)).toContainText('gated')

  // Run check → dispatched to the session, and the view follows it there.
  await page.getByTestId(`eval-run-check-${id}`).click()
  await expect(page.getByTestId('stream')).toBeVisible()
  const sent = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(sent.at(-1)).toContain('npx playwright test tests/e2e/project-actions.spec.ts')
  expect(sent.at(-1)).toContain('Run exactly')

  // The session reports FAIL: still gated, and it is not a pass.
  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { checkStatus: 'fail' }),
    ['p-alpha', id],
  )
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check fail')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeDisabled()

  // It reports PASS: the gate opens.
  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { checkStatus: 'pass' }),
    ['p-alpha', id],
  )
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check pass')
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('verify')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeEnabled()
  await expect(page.getByTestId(`eval-gated-${id}`)).toHaveCount(0)

  // Judge pass: a second opinion lands on the row and the stage moves to review.
  await page.getByTestId(`eval-judge-run-${id}`).click()
  expect(await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)).toContain('Judge the current diff')
  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { judge: 'satisfies it; error path untested' }),
    ['p-alpha', id],
  )
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId(`eval-judge-${id}`)).toContainText('error path untested')
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('review')

  // Rule on it: done, with a rating.
  await page.getByTestId(`eval-verdict-pass-${id}`).click()
  await page.getByTestId(`eval-rate-${id}-4`).click()
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('done')
  await expect(page.getByTestId('eval-mean')).toContainText('mean rating 4/5')
})

test('a suite from the project\'s own tooling becomes a line', async ({ page }) => {
  await page.getByTestId('eval-suites-toggle').click()
  const suites = page.getByTestId('eval-suites')
  // API, unit and UI checks are all offered without writing a runner.
  await expect(suites.getByTestId('eval-suite-node-unit')).toBeVisible()
  await expect(suites.getByTestId('eval-suite-node-api')).toBeVisible()
  await expect(suites.getByTestId('eval-suite-node-e2e')).toBeVisible()

  await suites.getByTestId('eval-suite-node-api').click()
  const row = page.locator('[data-testid^="eval-row-"]').first()
  await expect(row).toContainText('every route answers with the status and shape it should')
  await expect(row).toContainText('start the server, then send one request per route')
})

test('attempts asks for isolated parallel work', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('the sidebar groups collapse')
  await page.getByTestId('eval-add').click()
  const id = await rowId(page)

  // Default is one straight run — parallel attempts are opt-in per line.
  await expect(page.getByTestId(`eval-attempts-run-${id}`)).toContainText('Implement')
  await page.getByTestId(`eval-attempts-${id}-3`).click()
  await expect(page.getByTestId(`eval-attempts-chip-${id}`)).toHaveText('3 attempts')

  await page.getByTestId(`eval-attempts-run-${id}`).click()
  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('3 INDEPENDENT attempts')
  expect(sent).toContain('git worktree')
})

test('a line with no check is gated by the manual pass instead', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('the model chip reads Opus 5 (1M)')
  await page.getByTestId('eval-add').click()
  const id = await rowId(page)

  await expect(page.getByTestId(`eval-run-check-${id}`)).toHaveCount(0)
  // Nothing to verify mechanically, so the pass is not blocked.
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeEnabled()

  await page.getByTestId(`eval-manual-${id}`).click()
  const sent = await page.evaluate(() => window.__mock.state().sends.at(-1)?.text)
  expect(sent).toContain('the model chip reads Opus 5 (1M)')
  expect(sent).toContain('npm run dev')
})

test('a rating of 3 or below asks for another loop', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('the pill is green while running')
  await page.getByTestId('eval-add').click()
  const id = await rowId(page)

  await page.getByTestId(`eval-rate-${id}-3`).click()
  await expect(page.getByTestId(`eval-reloop-${id}`)).toContainText('needs another loop')
  // Clicking the same star again clears the rating, and the banner goes with it.
  await page.getByTestId(`eval-rate-${id}-3`).click()
  await expect(page.getByTestId(`eval-reloop-${id}`)).toHaveCount(0)
})

test('lines are per project and survive leaving the section', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('alpha only')
  await page.getByTestId('eval-add').click()
  await expect(page.getByTestId('eval-count')).toHaveText('1 line')

  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('eval-count')).toHaveText('0 lines')

  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('eval-count')).toHaveText('1 line')
  await expect(page.locator('[data-testid^="eval-row-"]').first()).toContainText('alpha only')
})

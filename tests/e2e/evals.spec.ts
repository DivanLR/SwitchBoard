import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('evals-view')).toBeVisible()
})

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
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('implement')
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check not run')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeDisabled()
  await expect(page.getByTestId(`eval-gated-${id}`)).toContainText('gated')

  await page.getByTestId(`eval-run-check-${id}`).click()
  await expect(page.getByTestId('tab-tests')).toHaveClass(/sel/)
  await expect.poll(() => lastSend(page)).toContain('npx playwright test')
  const sent = await lastSend(page)
  expect(sent).toContain('npx playwright test tests/e2e/project-actions.spec.ts')
  expect(sent).toContain('Run exactly')

  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { checkStatus: 'fail' }),
    ['p-alpha', id],
  )
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check fail')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeDisabled()

  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { checkStatus: 'pass' }),
    ['p-alpha', id],
  )
  await expect(page.getByTestId(`eval-check-status-${id}`)).toHaveText('check pass')
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('verify')
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeEnabled()
  await expect(page.getByTestId(`eval-gated-${id}`)).toHaveCount(0)

  await page.getByTestId(`eval-judge-run-${id}`).click()
  expect(await lastSend(page, 'Judge the current diff')).toContain('Judge the current diff')
  await page.evaluate(
    ([pid, rid]) => window.__mock.reportEvalResult(pid, rid, { judge: 'satisfies it; error path untested' }),
    ['p-alpha', id],
  )
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId(`eval-judge-${id}`)).toContainText('error path untested')
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('review')

  await page.getByTestId(`eval-verdict-pass-${id}`).click()
  await page.getByTestId(`eval-rate-${id}-4`).click()
  await expect(page.getByTestId(`eval-stage-${id}`)).toHaveText('done')
  await expect(page.getByTestId('eval-mean')).toContainText('mean rating 4/5')
})

test('a suite from the project\'s own tooling becomes a line', async ({ page }) => {
  await page.getByTestId('eval-suites-toggle').click()
  const suites = page.getByTestId('eval-suites')
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

  await expect(page.getByTestId(`eval-attempts-run-${id}`)).toContainText('Implement')
  await page.getByTestId(`eval-attempts-${id}-3`).click()
  await expect(page.getByTestId(`eval-attempts-chip-${id}`)).toHaveText('3 attempts')

  await page.getByTestId(`eval-attempts-run-${id}`).click()
  const sent = await lastSend(page)
  expect(sent).toContain('3 INDEPENDENT attempts')
  expect(sent).toContain('git worktree')
})

test('a line with no check is gated by the manual pass instead', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('the model chip reads Opus 5 (1M)')
  await page.getByTestId('eval-add').click()
  const id = await rowId(page)

  await expect(page.getByTestId(`eval-run-check-${id}`)).toHaveCount(0)
  await expect(page.getByTestId(`eval-verdict-pass-${id}`)).toBeEnabled()

  await page.getByTestId(`eval-manual-${id}`).click()
  const sent = await lastSend(page)
  expect(sent).toContain('the model chip reads Opus 5 (1M)')
  expect(sent).toContain('npm run dev')
})

test('a rating of 3 or below asks for another loop', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('the pill is green while running')
  await page.getByTestId('eval-add').click()
  const id = await rowId(page)

  await page.getByTestId(`eval-rate-${id}-3`).click()
  await expect(page.getByTestId(`eval-reloop-${id}`)).toContainText('needs another loop')
  await page.getByTestId(`eval-rate-${id}-3`).click()
  await expect(page.getByTestId(`eval-reloop-${id}`)).toHaveCount(0)
})

test('lines are per project and survive leaving the section', async ({ page }) => {
  await page.getByTestId('eval-acceptance').fill('alpha only')
  await page.getByTestId('eval-add').click()
  await expect(page.getByTestId('eval-count')).toHaveText('1 line')

  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-stack-node').click()
  await expect(page.getByTestId('eval-count')).toHaveText('0 lines')

  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-tests').click()
  await expect(page.getByTestId('eval-count')).toHaveText('1 line')
  await expect(page.locator('[data-testid^="eval-row-"]').first()).toContainText('alpha only')
})

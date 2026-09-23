import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

async function openFlow(page: Page, extensions = { bug: true, assess: true }): Promise<void> {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate((ext) => window.__mock.setSpecKit('p-alpha', { installed: true, extensions: ext }), extensions)
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-view')).toBeVisible()
  await page.getByTestId('flow-new').click()
}

async function rail(page: Page): Promise<string[]> {
  return page
    .getByTestId('flow-stage-rail')
    .locator('[role="tab"]')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-testid') ?? ''))
}

test('the intake asks what it is first, Feature, Bug or Idea, before anything else', async ({ page }) => {
  await openFlow(page)
  const order = await page
    .getByTestId('flow-create')
    .locator('[data-testid]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
  expect(order.indexOf('flow-kind-feature')).toBe(0)
  expect(order.indexOf('flow-kind-idea')).toBeLessThan(order.indexOf('flow-source-text'))
  await expect(page.getByTestId('flow-kind-feature')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-checklist-new')).toBeVisible()

  await page.getByTestId('flow-kind-bug').click()
  await expect(page.getByTestId('flow-source-text')).toHaveCount(0)
  await expect(page.getByTestId('flow-checklist-new')).toHaveCount(0)
  await expect(page.getByTestId('flow-start-reason')).toHaveText('Give the bug a title to start.')
  await page.getByTestId('flow-bug-title').fill('Login times out')
  await expect(page.getByTestId('flow-bug-slug')).toHaveText('Reports go to .specify/bugs/login-times-out/.')
  await expect(page.getByTestId('flow-base-branch')).toBeVisible()
  await expect(page.getByTestId('flow-start')).toBeEnabled()

  await page.getByTestId('flow-kind-idea').click()
  await expect(page.getByTestId('flow-idea-note')).toContainText('no worktree and no branch')
  await expect(page.getByTestId('flow-base-branch')).toHaveCount(0)
  await expect(page.getByTestId('flow-stack-chips')).toHaveCount(0)
  await expect(page.getByTestId('flow-companions')).toHaveCount(0)
  await page.getByTestId('flow-autopilot-new').click()
  await expect(page.getByTestId('flow-autoship-new')).toHaveCount(0)
})

test('a feature run shows the seven feature stages, and the checklist gate is sent with the run', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-text-title').fill('Guest checkout')
  await page.getByTestId('flow-checklist-new').click()
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
  expect(await rail(page)).toEqual([
    'flow-stage-spec',
    'flow-stage-plan',
    'flow-stage-build',
    'flow-stage-clean',
    'flow-stage-test',
    'flow-stage-review',
    'flow-stage-ship',
  ])
  await expect(page.getByTestId('flow-run-kind-flow-1')).toHaveText('Feature')
})

test('a bug run shows assess, fix and test, then clean, review and ship, and the verdict of its test', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-kind-bug').click()
  await page.getByTestId('flow-bug-title').fill('Login times out')
  await page.getByTestId('flow-bug-text').fill('Login hangs after 30 seconds.')
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
  expect(await rail(page)).toEqual([
    'flow-stage-assess',
    'flow-stage-fix',
    'flow-stage-test',
    'flow-stage-clean',
    'flow-stage-review',
    'flow-stage-ship',
  ])
  await expect(page.getByTestId('flow-run-kind-flow-1')).toHaveText('Bug')
  await expect(page.getByTestId('flow-artefact-doc')).toContainText('Mock assess body.')

  await page.evaluate(() =>
    window.__mock.reportFlowStage('flow-1', 'test', {
      status: 'failed',
      summary: 'The bug test reported partial, not verified, so the fix is not done.',
      report: { bugResult: 'partial' },
    }),
  )
  await page.getByTestId('flow-stage-test').click()
  await expect(page.getByTestId('flow-bug-result')).toHaveText('partial')
  await expect(page.getByTestId('flow-stage-summary')).toContainText('not verified')
})

test('a bug run needs the bug extension, and says so', async ({ page }) => {
  await openFlow(page, { bug: false, assess: false })
  await page.getByTestId('flow-kind-bug').click()
  await page.getByTestId('flow-bug-title').fill('Login times out')
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-error')).toContainText('bug extension is not installed')
})

test('an idea run shows intake to decide in the primary checkout, and a go decision starts a feature', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-kind-idea').click()
  await page.getByTestId('flow-idea-title').fill('Offline cart')
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
  expect(await rail(page)).toEqual([
    'flow-stage-intake',
    'flow-stage-research',
    'flow-stage-define',
    'flow-stage-shape',
    'flow-stage-decide',
  ])
  await expect(page.getByTestId('flow-run-primary')).toBeVisible()

  for (const stage of ['intake', 'research', 'define', 'shape', 'decide']) {
    await expect(page.getByTestId(`flow-stage-${stage}`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('flow-stage-status')).toHaveText('running')
    await page.evaluate(
      (s) =>
        window.__mock.reportFlowStage('flow-1', s, {
          status: 'review',
          summary: `Wrote the ${s} report.`,
          report: s === 'decide' ? { decision: 'go' } : {},
        }),
      stage,
    )
    await expect(page.getByTestId('flow-stage-status')).toHaveText('review')
    await page.getByTestId(stage === 'decide' ? 'flow-finish' : 'flow-approve').click()
  }
  await expect(page.getByTestId('flow-run-status')).toHaveText('done')
  await page.getByTestId('flow-stage-decide').click()
  await expect(page.getByTestId('flow-decision')).toHaveText('go')
  await page.getByTestId('flow-feature').click()
  await expect(page.getByTestId('flow-create')).toBeVisible()
  await expect(page.getByTestId('flow-kind-feature')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-text-title')).toHaveValue('Offline cart')
  await expect(page.getByTestId('flow-text-description')).toHaveValue('Build the offline cart from the decision.')
})

test('Open in Flow from a bug in the SDD tab starts the Bug intake on that slug', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      constitution: 'written',
      extensions: { bug: true, assess: true },
      bugs: [{ slug: 'cart-empty', title: 'Cart empties', files: ['assessment.md'], verdict: null, severity: 'low' }],
    }),
  )
  await page.getByTestId('tab-sdd').click()
  await page.getByTestId('sdd-section-bugs').click()
  await page.getByTestId('sdd-open-flow').click()
  await expect(page.getByTestId('flow-kind-bug')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-bug-title')).toHaveValue('Cart empties')
  await expect(page.getByTestId('flow-bug-slug')).toHaveText('Reports go to .specify/bugs/cart-empty/.')
})

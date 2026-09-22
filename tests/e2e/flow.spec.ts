import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const FEATURES = [
  { id: '4711', title: 'Checkout v2' },
  { id: '4712', title: 'Loyalty points' },
]

async function openFlow(page: Page): Promise<void> {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await expect(page.getByTestId('flow-view')).toBeVisible()
}

async function currentRunId(page: Page): Promise<string> {
  const id = await page.getByTestId('flow-run').getAttribute('data-run-id')
  return id ?? ''
}

test('a feature from Azure DevOps starts a run, with the detected stack chips shown', async ({ page }) => {
  await openFlow(page)
  await page.evaluate(() => window.__mock.setFlowStacks('p-alpha', ['dotnet', 'angular']))
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-source-ado').click()
  await expect(page.getByTestId('flow-stack-dotnet')).toHaveText('.NET')
  await expect(page.getByTestId('flow-stack-angular')).toHaveText('Angular')

  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await expect(page.getByTestId('flow-feature-4712')).toContainText('Loyalty points')
  await page.getByTestId('flow-feature-4711').click()

  await expect(page.getByTestId('flow-run')).toBeVisible()
  await expect(page.getByTestId('flow-run-status')).toHaveText('running')
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
})

test('starts a run from a written description', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill('Guest checkout')
  await page.getByTestId('flow-text-description').fill('Let a guest complete checkout without an account.')
  await page.getByTestId('flow-text-start').click()

  await expect(page.getByTestId('flow-run')).toContainText('Guest checkout')
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
})

test('starts a run from an existing spec folder, at plan or build depending on tasks.md', async ({ page }) => {
  await openFlow(page)
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-cart', title: 'Cart race fix' }],
    }),
  )
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-source-spec').click()
  await expect(page.getByTestId('flow-existing-spec-001-cart')).toContainText('Cart race fix')
  await page.getByTestId('flow-existing-spec-001-cart').click()
  await page.getByTestId('flow-spec-start').click()

  await expect(page.getByTestId('flow-run')).toContainText('001-cart')
})

async function startTextRun(page: Page, title = 'Cart totals'): Promise<void> {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill(title)
  await page.getByTestId('flow-text-description').fill('Fix the cart totals race.')
  await page.getByTestId('flow-text-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
}

test('the stage rail advances stage by stage on approve, and revise/retry/skip act on the running stage', async ({
  page,
}) => {
  await startTextRun(page)
  const runId = await currentRunId(page)
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'review', summary: 'Spec drafted.' }), runId)
  await expect(page.getByTestId('flow-stage-status')).toHaveText('review')

  await page.getByTestId('flow-feedback').fill('Cover the guest checkout path too.')
  await page.getByTestId('flow-revise').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain('Cover the guest checkout path too.')
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'failed', summary: 'It crashed.' }), runId)
  await expect(page.getByTestId('flow-stage-status')).toHaveText('failed')
  await page.getByTestId('flow-retry').click()
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'review', summary: 'Spec drafted.' }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-plan')).toContainText('running')

  await page.getByTestId('flow-skip').click()
  await expect(page.getByTestId('flow-stage-plan')).toContainText('skipped')
  await expect(page.getByTestId('flow-stage-build')).toContainText('running')
})

test('fix findings sends every must_fix item back to the session, only when review needs fixes', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('running')
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
    await page.getByTestId('flow-approve').click()
  }
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')

  await page.evaluate(
    (id) =>
      window.__mock.reportFlowStage(id, 'review', {
        status: 'review',
        report: {
          verdict: 'needs_fixes',
          findings: [{ severity: 'must_fix', file: 'Cart.cs', line: 12, what: 'Off-by-one in the total.' }],
          unmet: ['The regression test still fails.'],
        },
      }),
    runId,
  )

  await expect(page.getByTestId('flow-findings')).toContainText('Off-by-one in the total.')
  await expect(page.getByTestId('flow-unmet')).toContainText('regression test still fails')
  await page.getByTestId('flow-fix').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain('Fix every must_fix finding')
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')
})

test('the ship stage never starts on its own, and needs an explicit click', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('running')
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
    await page.getByTestId('flow-approve').click()
  }
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)
  await page.getByTestId('flow-approve').click()

  await expect(page.getByTestId('flow-stage-ship')).toContainText('pending')
  await expect(page.getByTestId('flow-ship')).toBeVisible()

  await page.getByTestId('flow-ship').click()
  await expect(page.getByTestId('flow-stage-ship')).toContainText('running')

  await page.evaluate((id) => window.__mock.reportFlowShip(id, 'https://dev.azure.com/x/_git/y/pullrequest/9', '9'), runId)
  await expect(page.getByTestId('flow-pr-link')).toContainText('PR 9')
})

test('autopilot advances every stage without a click, and stops before ship unless autoShip is on', async ({
  page,
}) => {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill('Autopilot feature')
  await page.getByTestId('flow-text-description').fill('Should run itself.')
  await page.getByTestId('flow-autopilot-new').click()
  await expect(page.getByTestId('flow-autoship-new')).toBeVisible()
  await page.getByTestId('flow-text-start').click()
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await expect(page.getByTestId('flow-stage-status')).toHaveText('running')
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('approved')
  }
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await expect(page.getByTestId('flow-stage-test')).toContainText('approved')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)
  await expect(page.getByTestId('flow-stage-review')).toContainText('approved')

  await expect(page.getByTestId('flow-stage-ship')).toContainText('pending')
  await expect(page.getByTestId('flow-ship')).toBeVisible()
})

test('autopilot with autoShip on raises the pull request stage automatically too', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill('Autoship feature')
  await page.getByTestId('flow-text-description').fill('Should ship itself.')
  await page.getByTestId('flow-autopilot-new').click()
  await page.getByTestId('flow-autoship-new').click()
  await page.getByTestId('flow-text-start').click()
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
  }
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)

  await expect(page.getByTestId('flow-stage-ship')).toContainText('running')
})

test('a question from the stage session is answered inline', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)
  await expect(page.getByTestId('flow-stage-session')).toBeVisible()

  await page.evaluate((id) => window.__mock.askFlowQuestion(id, 'Which option?', ['Option A', 'Option B']), runId)
  await expect(page.getByTestId('mini-terminal-question')).toBeVisible()
  await expect(page.getByTestId('mini-terminal-question')).toContainText('Which option?')

  await page.getByTestId('question-option-Option A').click()
  await expect(page.getByTestId('mini-terminal-question')).toHaveCount(0)
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe('Option A')
})

test('cancel interrupts the running stage session and ends the run', async ({ page }) => {
  await startTextRun(page)
  await expect(page.getByTestId('flow-stage-session')).toBeVisible()

  await page.getByTestId('flow-cancel').click()
  await expect(page.getByTestId('flow-run-status')).toHaveText('cancelled')
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBeGreaterThan(0)
})

test('removing the worktree needs a second click to confirm', async ({ page }) => {
  await startTextRun(page)
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')

  await expect(page.getByTestId('flow-run-worktree')).toBeVisible()
  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveText('Confirm remove worktree')
  await expect(page.getByTestId('flow-run-worktree')).toBeVisible()

  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-run-worktree')).toHaveCount(0)
})

test('Escape and the close button both dismiss the popup, and it can be reopened', async ({ page }) => {
  await openFlow(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('open-flow')).toBeFocused()

  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await page.getByTestId('flow-popup-close').click()
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
})

test('the popup shows the pending inbox count for this project, and answering it closes the popup', async ({
  page,
}) => {
  await openFlow(page)
  await expect(page.getByTestId('flow-popup-inbox')).toHaveCount(0)

  await page.evaluate(() =>
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: npm test',
      explanation: 'A Flow session wants to run the tests.',
      risk: 'low',
    }),
  )
  await expect(page.getByTestId('flow-popup-inbox')).toHaveText(/1 waiting/)

  await page.evaluate(() =>
    window.__mock.raisePermission({ projectId: 'p-beta', title: 'Run: git status', risk: 'low' }),
  )
  await expect(page.getByTestId('flow-popup-inbox')).toHaveText(/1 waiting/)

  await page.getByTestId('flow-popup-inbox').click()
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('inbox-badge')).toBeVisible()
})

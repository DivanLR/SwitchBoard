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

async function lastSend(page: Page): Promise<string | undefined> {
  return (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text
}

test('with no runs yet, Flow says what it does in one line and offers New feature', async ({ page }) => {
  await openFlow(page)
  await expect(page.getByTestId('flow-empty')).toContainText(
    'spec, plan, build, clean, test, review and pull request, each run in its own worktree',
  )
  await page.getByTestId('flow-new').click()
  await expect(page.getByTestId('flow-create')).toBeVisible()
})

test('Start comes last, stays disabled with a reason until the chosen source has what it needs', async ({ page }) => {
  await openFlow(page)
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', { installed: true, specs: [{ id: '001-cart', title: 'Cart race fix' }] }),
  )
  await page.getByTestId('flow-new').click()

  await expect(page.getByTestId('flow-source-text')).toHaveAttribute('aria-checked', 'true')
  const order = await page
    .getByTestId('flow-create')
    .locator('[data-testid]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
  for (const id of ['flow-stack-chips', 'flow-base-branch', 'flow-autopilot-new']) {
    expect(order.indexOf(id)).toBeLessThan(order.indexOf('flow-start'))
  }
  await page.getByTestId('flow-autopilot-new').click()
  const withShip = await page
    .getByTestId('flow-create')
    .locator('[data-testid]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
  expect(withShip.indexOf('flow-autoship-new')).toBeLessThan(withShip.indexOf('flow-start'))

  await expect(page.getByTestId('flow-start')).toBeDisabled()
  await expect(page.getByTestId('flow-start-reason')).toHaveText('Give the feature a title to start.')
  await page.getByTestId('flow-text-title').fill('Guest checkout')
  await expect(page.getByTestId('flow-start')).toBeEnabled()
  await expect(page.getByTestId('flow-start-reason')).toHaveCount(0)

  await page.getByTestId('flow-source-ado').click()
  await expect(page.getByTestId('flow-source-ado')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-source-text')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('flow-start')).toBeDisabled()
  await expect(page.getByTestId('flow-start-reason')).toHaveText('Pick a Feature from Azure DevOps to start.')

  await page.getByTestId('flow-source-spec').click()
  await expect(page.getByTestId('flow-start-reason')).toHaveText('Pick an existing spec to start.')
  await page.getByTestId('flow-existing-spec-001-cart').click()
  await expect(page.getByTestId('flow-existing-spec-001-cart')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('flow-start')).toBeEnabled()
})

test('a feature from Azure DevOps is picked, then started, with the detected stack chips shown', async ({ page }) => {
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
  await expect(page.getByTestId('flow-feature-4711')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('flow-start').click()

  await expect(page.getByTestId('flow-run')).toBeVisible()
  await expect(page.getByTestId('flow-run')).toContainText('Checkout v2')
  await expect(page.getByTestId('flow-run-status')).toHaveText('running')
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
})

test('an unconnected ado server says which state it is in, and Reconnect retries the Feature list', async ({ page }) => {
  await openFlow(page)
  await page.evaluate((features) => {
    window.__mock.setAdoFeatures(features)
    window.__mock.setAdoConnected(false, 'it needs you to sign in. Sign in to it in Claude Code with /mcp, then Reconnect')
  }, FEATURES)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-source-ado').click()
  await expect(page.getByTestId('flow-ado-state')).toContainText(
    'The Azure DevOps MCP server is not connected for this session: it needs you to sign in.',
  )
  await expect(page.getByTestId('flow-error')).toHaveCount(0)
  await expect(page.getByTestId('flow-ado-reconnect')).toBeEnabled()

  await page.evaluate(() => window.__mock.setAdoConnected(false, 'it failed to start: spawn npx ENOENT'))
  await page.getByTestId('flow-ado-reconnect').click()
  await expect(page.getByTestId('flow-ado-state')).toContainText('it failed to start: spawn npx ENOENT')

  await page.evaluate(() => window.__mock.setAdoConnected(true))
  await page.getByTestId('flow-ado-reconnect').click()
  await expect(page.getByTestId('flow-ado-state')).toHaveCount(0)
  await expect(page.getByTestId('flow-feature-4711')).toContainText('Checkout v2')
  expect((await page.evaluate(() => window.__mock.state())).adoReconnects).toBe(2)
})

test('starts a run from a written description', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill('Guest checkout')
  await page.getByTestId('flow-text-description').fill('Let a guest complete checkout without an account.')
  await page.getByTestId('flow-start').click()

  await expect(page.getByTestId('flow-run')).toContainText('Guest checkout')
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
})

test('starts a run from an existing spec folder', async ({ page }) => {
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
  await page.getByTestId('flow-start').click()

  await expect(page.getByTestId('flow-run')).toContainText('001-cart')
})

async function startTextRun(page: Page, title = 'Cart totals'): Promise<void> {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await page.getByTestId('flow-text-title').fill(title)
  await page.getByTestId('flow-text-description').fill('Fix the cart totals race.')
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
}

async function approveThrough(page: Page, runId: string, stages: readonly string[]): Promise<void> {
  for (const stage of stages) {
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('running')
    await page.evaluate(({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }), {
      runId,
      stage,
    })
    await page.getByTestId('flow-approve').click()
  }
}

test('run-level controls live in the run header, and a running stage offers only Skip', async ({ page }) => {
  await startTextRun(page)
  const header = page.getByTestId('flow-run').locator('header')
  await expect(header.getByTestId('flow-cancel')).toHaveText('Cancel run')
  await expect(header.getByTestId('flow-autopilot-toggle')).toBeVisible()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveCount(0)

  const card = page.getByTestId('flow-stage-detail')
  await expect(card.getByTestId('flow-cancel')).toHaveCount(0)
  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText(['Skip this stage'])
  await expect(page.getByTestId('flow-feedback')).toHaveCount(0)
})

test('the stage rail advances stage by stage on approve, and revise/retry/skip act on the current stage', async ({
  page,
}) => {
  await startTextRun(page)
  const runId = await currentRunId(page)
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
  await expect(page.getByTestId('flow-stage-spec')).toHaveAttribute('aria-selected', 'true')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'review', summary: 'Spec drafted.' }), runId)
  await expect(page.getByTestId('flow-stage-status')).toHaveText('review')
  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText(['Approve', 'Skip this stage'])

  await expect(page.getByTestId('flow-revise')).toBeDisabled()
  await page.getByTestId('flow-feedback').fill('Cover the guest checkout path too.')
  await page.getByTestId('flow-revise').click()
  await expect.poll(() => lastSend(page)).toContain('Cover the guest checkout path too.')
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'failed', summary: 'It crashed.' }), runId)
  await expect(page.getByTestId('flow-stage-status')).toHaveText('failed')
  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText(['Retry', 'Skip this stage'])
  await page.getByTestId('flow-retry').click()
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')

  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'review', summary: 'Spec drafted.' }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-plan')).toContainText('running')

  await page.getByTestId('flow-skip').click()
  await expect(page.getByTestId('flow-stage-plan')).toContainText('skipped')
  await expect(page.getByTestId('flow-stage-build')).toContainText('running')
})

test('an earlier stage is read-only: its summary and artefact, with no actions or session', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'spec', { status: 'review', summary: 'Spec drafted.' }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-plan')).toContainText('running')

  await page.getByTestId('flow-stage-spec').click()
  await expect(page.getByTestId('flow-stage-spec')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('flow-stage-readonly')).toBeVisible()
  await expect(page.getByTestId('flow-stage-summary')).toHaveText('Spec drafted.')
  await expect(page.getByTestId('flow-artefact-markdown')).toContainText('Mock spec body.')
  await expect(page.getByTestId('flow-stage-actions')).toHaveCount(0)
  await expect(page.getByTestId('flow-feedback')).toHaveCount(0)
  await expect(page.getByTestId('flow-stage-session')).toHaveCount(0)
  await expect(page.getByTestId('flow-stage-detail').getByTestId('flow-cancel')).toHaveCount(0)
})

test('fix findings sends every must_fix item back, only when review needs fixes', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)

  await approveThrough(page, runId, ['spec', 'plan', 'build', 'clean'])
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

  await expect(page.getByTestId('flow-review-verdict')).toHaveText('Needs fixes')
  await expect(page.getByTestId('flow-findings')).toContainText('Off-by-one in the total.')
  await expect(page.getByTestId('flow-unmet')).toContainText('regression test still fails')
  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText([
    'Fix findings',
    'Approve',
    'Skip this stage',
  ])
  await page.getByTestId('flow-fix').click()
  await expect.poll(() => lastSend(page)).toContain('Off-by-one in the total.')
  await expect(page.getByTestId('flow-stage-status')).toHaveText('running')
})

test('the ship stage needs an explicit click, and Finish on the open pull request ends the run', async ({ page }) => {
  await startTextRun(page)
  const runId = await currentRunId(page)

  await approveThrough(page, runId, ['spec', 'plan', 'build', 'clean'])
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)
  await expect(page.getByTestId('flow-fix')).toHaveCount(0)
  await page.getByTestId('flow-approve').click()

  await expect(page.getByTestId('flow-stage-ship')).toContainText('pending')
  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText([
    'Raise pull request',
    'Finish without a pull request',
  ])

  await page.getByTestId('flow-ship').click()
  await expect(page.getByTestId('flow-stage-ship')).toContainText('running')

  const url = 'https://dev.azure.com/x/_git/y/pullrequest/9'
  await page.evaluate(({ id, url }) => window.__mock.reportFlowShip(id, url, '9'), { id: runId, url })
  await expect(page.getByTestId('flow-pr-link')).toContainText('PR 9')
  const box = await page.getByTestId('flow-pr-link').boundingBox()
  const card = await page.getByTestId('flow-stage-detail').boundingBox()
  expect(box!.width).toBeLessThan(card!.width / 3)
  await page.getByTestId('flow-pr-link').click()
  await expect.poll(async () => (await page.evaluate(() => window.__mock.state().prOpens)).at(-1)).toBe(url)

  await expect(page.getByTestId('flow-stage-actions').locator('button')).toHaveText(['Finish'])
  await page.getByTestId('flow-finish').click()
  await expect(page.getByTestId('flow-run-status')).toHaveText('done')
  await expect(page.getByTestId('flow-stage-readonly')).toBeVisible()
  await expect(page.getByTestId('flow-cancel')).toHaveCount(0)
  await expect(page.getByTestId('flow-autopilot-toggle')).toHaveCount(0)
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
  await page.getByTestId('flow-start').click()
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await expect(page.getByTestId('flow-stage-status')).toHaveText('running')
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('approved')
  }
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await expect(page.getByTestId('flow-stage-test')).toContainText('approved')
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')
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
  await page.getByTestId('flow-start').click()
  const runId = await currentRunId(page)

  for (const stage of ['spec', 'plan', 'build', 'clean'] as const) {
    await expect(page.getByTestId(`flow-stage-${stage}`)).toContainText('running')
    await page.evaluate(
      ({ runId, stage }) => window.__mock.reportFlowStage(runId, stage, { status: 'review' }),
      { runId, stage },
    )
  }
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)

  await expect(page.getByTestId('flow-stage-ship')).toContainText('running')
})

test('a question the stage session asks through AskUserQuestion is answered inline, into that tool call', async ({
  page,
}) => {
  await startTextRun(page)
  const runId = await currentRunId(page)
  await expect(page.getByTestId('flow-stage-session')).toBeVisible()
  const sendsBefore = await page.evaluate(() => window.__mock.state().sends.length)

  const eventId = await page.evaluate(
    (id) => window.__mock.askFlowQuestion(id, 'Which option?', ['Option A', 'Option B']),
    runId,
  )
  await expect(page.getByTestId('mini-terminal-question')).toBeVisible()
  await expect(page.getByTestId('mini-terminal-question')).toContainText('Which option?')

  await page.getByTestId('question-option-Option A').click()
  await expect(page.getByTestId('mini-terminal-question')).toHaveCount(0)
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().answers)).at(-1))
    .toEqual({ eventId, choice: 'Option A' })
  expect(await page.evaluate(() => window.__mock.state().sends.length)).toBe(sendsBefore)
})

test('cancel stops the running stage session and ends the run', async ({ page }) => {
  await startTextRun(page)
  await expect(page.getByTestId('flow-stage-session')).toBeVisible()

  await page.getByTestId('flow-cancel').click()
  await expect(page.getByTestId('flow-run-status')).toHaveText('cancelled')
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBeGreaterThan(0)
})

test('the worktree can be removed only once the run has ended, and needs a second click', async ({ page }) => {
  await startTextRun(page)
  await expect(page.getByTestId('flow-stage-spec')).toContainText('running')
  await expect(page.getByTestId('flow-run-worktree')).toBeVisible()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveCount(0)

  await page.getByTestId('flow-cancel').click()
  await expect(page.getByTestId('flow-run-status')).toHaveText('cancelled')
  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveText('Confirm remove worktree')
  await expect(page.getByTestId('flow-run-worktree')).toBeVisible()

  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-run-worktree')).toHaveCount(0)
})

async function startTwoRepoRun(page: Page): Promise<void> {
  await openFlow(page)
  await page.evaluate(() => {
    window.__mock.setFlowStacks('p-alpha', ['dotnet'])
    window.__mock.setFlowStacks('p-beta', ['angular'])
  })
  await page.getByTestId('flow-new').click()
  await expect(page.getByTestId('flow-companion-p-beta')).toContainText('beta')
  await expect(page.getByTestId('flow-companion-p-beta-stack-angular')).toHaveText('Angular')
  await expect(page.getByTestId('flow-companion-p-beta')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('flow-companion-base-p-beta')).toHaveCount(0)
  await page.getByTestId('flow-companion-p-beta').click()
  await expect(page.getByTestId('flow-companion-p-beta')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('flow-companion-base-p-beta').fill('develop')
  await page.getByTestId('flow-text-title').fill('Renewal quote')
  await page.getByTestId('flow-start').click()
  await expect(page.getByTestId('flow-run')).toBeVisible()
}

test('Also change adds another project to the run, and the header lists every repository with its branch and stacks', async ({
  page,
}) => {
  await startTwoRepoRun(page)
  const alpha = page.getByTestId('flow-run-repo-p-alpha')
  const beta = page.getByTestId('flow-run-repo-p-beta')
  await expect(alpha).toContainText('alpha')
  await expect(alpha).toContainText('feature/flow-1')
  await expect(alpha).toContainText('base main')
  await expect(alpha).toContainText('.NET')
  await expect(beta).toContainText('feature/flow-1')
  await expect(beta).toContainText('base develop')
  await expect(beta).toContainText('Angular')
  await expect(page.getByTestId('flow-run-worktree')).toHaveCount(0)

  await page.getByTestId('flow-cancel').click()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveText('Remove 2 worktrees')
  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveText('Confirm remove 2 worktrees')
  await page.getByTestId('flow-remove-worktree').click()
  await expect(page.getByTestId('flow-remove-worktree')).toHaveCount(0)
})

test('the ship stage of a two-repository run shows and opens one pull request per repository', async ({ page }) => {
  await startTwoRepoRun(page)
  const runId = await currentRunId(page)
  await approveThrough(page, runId, ['spec', 'plan', 'build', 'clean'])
  await expect(page.getByTestId('flow-stage-test')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowVerify(id, { suites: [{ id: 'alpha/unit', label: 'Unit', status: 'pass', detail: 'ok' }] }), runId)
  await page.getByTestId('flow-approve').click()
  await expect(page.getByTestId('flow-stage-review')).toContainText('running')
  await page.evaluate((id) => window.__mock.reportFlowStage(id, 'review', { status: 'review', report: { verdict: 'ready', findings: [], unmet: [] } }), runId)
  await page.getByTestId('flow-approve').click()
  await page.getByTestId('flow-ship').click()
  await expect(page.getByTestId('flow-stage-ship')).toContainText('running')
  await expect(page.getByTestId('flow-pr-p-beta')).toContainText('No pull request yet.')

  const api = 'https://dev.azure.com/x/_git/api/pullrequest/11'
  const fe = 'https://github.com/x/fe/pull/12'
  await page.evaluate(
    ({ id, api, fe }) =>
      window.__mock.reportFlowShip(id, api, '11', [
        { projectId: 'p-alpha', prUrl: api, prId: '11' },
        { projectId: 'p-beta', prUrl: fe, prId: '12' },
      ]),
    { id: runId, api, fe },
  )
  await expect(page.getByTestId('flow-pr-link-p-alpha')).toContainText('PR 11')
  await expect(page.getByTestId('flow-pr-link-p-beta')).toContainText('PR 12')
  await expect(page.getByTestId('flow-pr-link')).toHaveCount(0)
  await page.getByTestId('flow-pr-link-p-beta').click()
  await expect.poll(async () => (await page.evaluate(() => window.__mock.state().prOpens)).at(-1)).toBe(fe)
  await page.getByTestId('flow-pr-link-p-alpha').click()
  await expect.poll(async () => (await page.evaluate(() => window.__mock.state().prOpens)).at(-1)).toBe(api)
})

for (const [seed, note] of [
  [{ defaultSessionMode: 'bypass' }, 'Stages run on this machine in accept edits, not bypass'],
  [{ useContainers: true }, 'Stages run on this machine, not in a container'],
] as const) {
  test(`the intake says a ${'useContainers' in seed ? 'container' : 'bypass'} project runs its stages on this machine`, async ({
    page,
  }) => {
    const scenario = twoProjectScenario()
    Object.assign(scenario.projects[0], seed)
    await page.addInitScript(installMockHost, scenario)
    await page.goto('/')
    await page.getByTestId('open-flow').click()
    await page.getByTestId('flow-new').click()
    await expect(page.getByTestId('flow-host-note')).toContainText(note)
    await expect(page.getByTestId('flow-host-note')).toContainText('a container mounts only the project folder')
  })
}

test('a project on the host with no bypass shows no host note in the intake', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('flow-new').click()
  await expect(page.getByTestId('flow-create')).toBeVisible()
  await expect(page.getByTestId('flow-host-note')).toHaveCount(0)
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

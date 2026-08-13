// Planning mode: a session that reads before it acts, proposes a plan, and waits
// for the developer to approve it. The inbox half of this already existed and was
// unreachable — nothing ever started a session in plan mode, so nothing ever
// called ExitPlanMode. These cover the half that turns it on.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

// The pair of switches that used to sit here (Plan, Bypass) had to clear each
// other, because a bypass session approves everything before the gate a plan
// needs is ever reached: the two together did nothing while the developer waited
// on a review. One choice cannot express that, so the test is now that choosing
// is exclusive rather than that two controls fight.
test('the session type is one choice, so plan and bypass cannot both be asked for', async ({
  page,
}) => {
  await page.getByTestId('add-project').click()

  await page.getByTestId('session-mode-plan').check()
  await expect(page.getByTestId('session-mode-plan')).toBeChecked()

  await page.getByTestId('session-mode-bypass').check()
  await expect(page.getByTestId('session-mode-bypass')).toBeChecked()
  await expect(page.getByTestId('session-mode-plan')).not.toBeChecked()
  // Bypass is the one mode that carries a warning, because it is the one that
  // removes every gate rather than moving one.
  await expect(page.getByTestId('bypass-warning')).toBeVisible()

  await page.getByTestId('session-mode-plan').check()
  await expect(page.getByTestId('session-mode-bypass')).not.toBeChecked()
  await expect(page.getByTestId('bypass-warning')).toBeHidden()
})

test('a session started with Plan on says it is planning, and asks for it', async ({ page }) => {
  await page.getByTestId('add-project').click()
  await page.getByTestId('folder-input').fill('C:\\work\\gamma')
  await page.getByTestId('session-mode-plan').check()
  await page.getByTestId('start-session').click()

  // The pill first: the sidebar row appears at registration, which is before the
  // session has started, so reading the recorded start any earlier races it.
  await expect(page.getByTestId('plan-mode-toggle')).toContainText('Planning')
  const start = await page.evaluate(() => window.__mock.state().starts.at(-1))
  expect(start?.planMode).toBe(true)
  expect(start?.bypassPermissions).toBe(false)
})

test('the live pill switches a running session in and out of planning', async ({ page }) => {
  const pill = page.getByTestId('plan-mode-toggle')
  await expect(pill).toContainText('Plan')
  await expect(pill).toHaveAttribute('aria-checked', 'false')

  await pill.click()
  await expect(pill).toContainText('Planning')
  await expect(pill).toHaveAttribute('aria-checked', 'true')

  await pill.click()
  await expect(pill).toContainText('Plan')

  expect(await page.evaluate(() => window.__mock.state().planModeChanges)).toEqual([
    { sessionId: 's-alpha', enabled: true },
    { sessionId: 's-alpha', enabled: false },
  ])
})

// Approving the plan IS leaving plan mode — the tool's own contract, so no
// second click is needed and the header must not go on claiming a restriction
// that has been lifted.
test('approving the plan returns the session to acting, with no second click', async ({ page }) => {
  await page.getByTestId('plan-mode-toggle').click()
  await expect(page.getByTestId('plan-mode-toggle')).toContainText('Planning')

  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Plan approval',
      detail: '1. Read the store\n2. Add the column',
      type: 'plan_approval',
      risk: 'low',
    })
  })
  await page.getByTestId('approve-btn').click()

  await expect(page.getByTestId('plan-mode-toggle')).toContainText('Plan')
  await expect(page.getByTestId('plan-mode-toggle')).toHaveAttribute('aria-checked', 'false')
})

test('denying the plan keeps the session planning, so the model revises', async ({ page }) => {
  await page.getByTestId('plan-mode-toggle').click()
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Plan approval',
      detail: 'Rewrite everything',
      type: 'plan_approval',
      risk: 'low',
    })
  })
  await page.getByTestId('deny-btn').click()

  await expect(page.getByTestId('plan-mode-toggle')).toContainText('Planning')
})

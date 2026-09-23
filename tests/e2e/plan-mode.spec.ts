import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the session type is one choice, so plan and bypass cannot both be asked for', async ({
  page,
}) => {
  await page.getByTestId('add-project').click()

  await page.getByTestId('session-mode-plan').check()
  await expect(page.getByTestId('session-mode-plan')).toBeChecked()

  await page.getByTestId('session-mode-bypass').check()
  await expect(page.getByTestId('session-mode-bypass')).toBeChecked()
  await expect(page.getByTestId('session-mode-plan')).not.toBeChecked()
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

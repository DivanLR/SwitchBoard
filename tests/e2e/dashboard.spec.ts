// T034: dashboard identity, counters, registration, and input isolation
// (quickstart V2). Aligned to the Switchboard design: status is an animated
// dot carrying a data-status attribute, counters are label/value pairs.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('sidebar shows name, branch, status dot and a ticking timer (FR-003/004)', async ({ page }) => {
  const alpha = page.getByTestId('sidebar-project-alpha')
  await expect(alpha).toContainText('alpha')
  await expect(alpha).toContainText('main')
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'working')
  await expect(page.getByTestId('sidebar-project-beta')).toContainText('feature/x')

  const first = await page.getByTestId('timer-alpha').textContent()
  await expect
    .poll(async () => page.getByTestId('timer-alpha').textContent(), { timeout: 5000 })
    .not.toBe(first)
})

test('status pushes update the dot without user action (FR-004)', async ({ page }) => {
  await page.evaluate(() => window.__mock.setStatus('s-alpha', 'error'))
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'error')
  await page.evaluate(() => window.__mock.completeTurn('s-beta'))
  await expect(page.getByTestId('status-badge-beta')).toHaveAttribute('data-status', 'done')
})

test('registration offers suggestions and validates manual paths (FR-001a)', async ({ page }) => {
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('suggestion-gamma')).toContainText('C:\\work\\gamma')
  await page.getByTestId('suggestion-gamma').getByRole('button', { name: 'add' }).click()
  await expect(page.getByTestId('sidebar-project-gamma')).toBeVisible()

  await page.getByTestId('manual-path').fill('C:\\work\\missing')
  await page.getByTestId('manual-add').click()
  await expect(page.getByTestId('registration-error')).toContainText('does not exist')

  await page.getByTestId('manual-path').fill('C:\\work\\alpha')
  await page.getByTestId('manual-add').click()
  await expect(page.getByTestId('registration-error')).toContainText('already registered')
})

test('aggregate counters are truthful (FR-005)', async ({ page }) => {
  await expect(page.getByTestId('counter-running-value')).toHaveText('2')
  await expect(page.getByTestId('counter-needsyou-value')).toHaveText('0')

  await page.evaluate(() => {
    window.__mock.raisePermission({ projectId: 'p-alpha', title: 'x', risk: 'low' })
  })
  await expect(page.getByTestId('counter-needsyou-value')).toHaveText('1')
  await expect(page.getByTestId('counter-running-value')).toHaveText('1')

  await page.evaluate(() => window.__mock.completeTurn('s-beta', 1.25))
  await expect(page.getByTestId('counter-running-value')).toHaveText('0')
  await expect(page.getByTestId('counter-cost-value')).toHaveText('$1.25')
})

test('messages go only to the selected project (SC-002)', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('composer-input').fill('hello alpha')
  await page.getByTestId('composer-send').click()

  await expect(
    page.getByTestId('stream').getByTestId('stream-event-prompt').filter({ hasText: 'hello alpha' }),
  ).toBeVisible()

  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends).toEqual([{ sessionId: 's-alpha', text: 'hello alpha' }])

  // Beta's stream contains no prompt events at all.
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('stream').getByTestId('stream-event-prompt')).toHaveCount(0)
})

test('header always names the selected project and its path (SC-003)', async ({ page }) => {
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('session-project-name')).toHaveText('beta')
  await expect(page.getByTestId('session-project-path')).toHaveText('C:\\work\\beta')
  // The design header carries the branch and git diff stats.
  await expect(page.getByTestId('diff-stats')).toContainText('+12')
  await expect(page.getByTestId('diff-stats')).toContainText('4')
})

// T049: responsiveness assertions — interaction acknowledged within 1 second
// with 10 busy sessions (SC-007) and needs-you signalled within 5 seconds
// (SC-006).
import { expect, test } from '@playwright/test'
import { installMockHost, type MockScenario } from './mock-host'

function tenProjectScenario(): MockScenario {
  return {
    projects: Array.from({ length: 10 }, (_, i) => ({
      id: `p-${i}`,
      name: `project-${i}`,
      path: `C:\\work\\project-${i}`,
      session: { id: `s-${i}`, status: 'working' as const, branch: 'main' },
    })),
  }
}

test('interactions acknowledge within 1s while 10 sessions stream (SC-007)', async ({ page }) => {
  await page.addInitScript(installMockHost, tenProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-project-0')).toBeVisible()

  // All 10 sessions flood raw output continuously.
  await page.evaluate(() => window.__mock.startFlood(50, 2))
  await page.waitForTimeout(1500)

  await page.getByTestId('sidebar-project-project-0').click()
  await page.getByTestId('composer-input').fill('are you responsive?')
  const started = Date.now()
  await page.getByTestId('composer-send').click()
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'are you responsive?' }),
  ).toBeVisible()
  const elapsed = Date.now() - started
  expect(elapsed).toBeLessThan(1000)

  await page.evaluate(() => window.__mock.stopFlood())
})

test('a blocked session is signalled within 5s (SC-006)', async ({ page }) => {
  await page.addInitScript(installMockHost, tenProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-project-5')).toBeVisible()

  await page.evaluate(() => window.__mock.startFlood(50, 2))
  const started = Date.now()
  await page.evaluate(() =>
    window.__mock.raisePermission({ projectId: 'p-5', title: 'Run: npm test', risk: 'medium' }),
  )
  await expect(page.getByTestId('status-badge-project-5')).toHaveAttribute('data-status', 'needs_you', {
    timeout: 5000,
  })
  await expect(page.getByTestId('counter-needsyou-value')).toHaveText('1', { timeout: 5000 })
  expect(Date.now() - started).toBeLessThan(5000)

  await page.evaluate(() => window.__mock.stopFlood())
})

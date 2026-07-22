// Cleanup section: a launcher of Ponytail / Dotnet Claude Kit review + cleanup
// commands that run in the selected project's session.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('the Cleanup tab lists grouped commands and runs one in the session', async ({ page }) => {
  await page.getByTestId('tab-cleanup').click()
  await expect(page.getByTestId('cleanup-view')).toBeVisible()
  // Both plugin groups are present, with runnable command rows.
  await expect(page.getByTestId('cleanup-view')).toContainText('dotnet-claude-kit')
  await expect(page.getByTestId('cleanup-view')).toContainText('ponytail')
  await expect(page.getByTestId('cleanup-cmd-code-review')).toBeVisible()

  // Running a command jumps to the Session tab and sends the slash command.
  await page.getByTestId('cleanup-cmd-de-sloppify').click()
  await expect(page.getByTestId('tab-session')).toHaveClass(/sel/)
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.some((s) => s.text === '/de-sloppify')).toBe(true)
})

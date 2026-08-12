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

  // Running a command sends it to the project's BACKGROUND session and leaves
  // the developer where they were. It used to jump to the Session tab, which
  // now shows the conversation the work is deliberately no longer in.
  await page.getByTestId('cleanup-cmd-de-sloppify').click()
  await expect(page.getByTestId('tab-cleanup')).toHaveClass(/sel/)
  await expect
    .poll(() => page.evaluate(() => window.__mock.state().sends.map((x) => x.text)))
    .toContain('/de-sloppify')
  const sends = await page.evaluate(() => window.__mock.state().sends)
  const run = sends.find((s) => s.text === '/de-sloppify')
  expect(run?.sessionId).not.toBe('s-alpha')
})

test('a stack-specific plugin is not advertised to a project that has not installed it', async ({
  page,
}) => {
  // Once the session reports its real command list, the app knows what is
  // installed. The .NET toolkit used to be offered, with a download button, to
  // every project whatever its language; only ponytail is ecosystem-neutral.
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['ponytail-review', 'ponytail-audit']))
  await page.getByTestId('tab-cleanup').click()

  await expect(page.getByTestId('cleanup-view')).toContainText('ponytail')
  await expect(page.getByTestId('cleanup-view')).not.toContainText('dotnet-claude-kit')
})

test('an installed stack-specific plugin still shows its commands', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['code-review', 'de-sloppify']))
  await page.getByTestId('tab-cleanup').click()

  await expect(page.getByTestId('cleanup-view')).toContainText('dotnet-claude-kit')
  await expect(page.getByTestId('cleanup-cmd-code-review')).toBeVisible()
})

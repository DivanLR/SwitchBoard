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

  // Running a command leaves the developer where they were: it used to jump to
  // the Session tab, which shows the conversation the work is not in.
  await page.getByTestId('cleanup-cmd-de-sloppify').click()
  await expect(page.getByTestId('tab-cleanup')).toHaveClass(/sel/)
  await expect
    .poll(() => page.evaluate(() => window.__mock.state().sends.map((x) => x.text)))
    .toContain('/de-sloppify')

  // It goes to the LIVE session, and this assertion is the reverse of what it
  // used to be. These are plugin commands, and the background session is
  // containerised: its ~/.claude is a fresh Docker volume with no plugins in it,
  // so seven of the nine commands here could never resolve there however healthy
  // the "Installed" badge looked. Same fix, and the same trade, as Diagrams.
  const sends = await page.evaluate(() => window.__mock.state().sends)
  const run = sends.find((s) => s.text === '/de-sloppify')
  expect(run?.sessionId).toBe('s-alpha')
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

// The names a session actually reports are plugin-qualified, and every row in
// this group is a SKILL rather than a command: dotnet-claude-kit ships no
// commands/ directory at all. The tests above used bare names, so they would
// have passed even with the colon handling broken — and the real symptom was
// one row runnable out of six, with the other five reading "Not available"
// while the plugin was installed the whole time.
test('every skill a plugin reports is runnable, however the session qualifies its name', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      'dotnet-claude-kit:code-review',
      'dotnet-claude-kit:de-sloppify',
      'dotnet-claude-kit:security-scan',
      'dotnet-claude-kit:verify',
      'dotnet-claude-kit:health-check',
      'dotnet-claude-kit:migrate',
    ]),
  )
  await page.getByTestId('tab-cleanup').click()

  for (const name of [
    'code-review',
    'de-sloppify',
    'security-scan',
    'verify',
    'health-check',
    'migrate',
  ]) {
    await expect(page.getByTestId(`cleanup-cmd-${name}`)).toBeEnabled()
  }
})

test('running a row sends the name the session reported, not the catalogue shorthand', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['dotnet-claude-kit:security-scan']),
  )
  await page.getByTestId('tab-cleanup').click()
  await page.getByTestId('cleanup-cmd-security-scan').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toBe('/dotnet-claude-kit:security-scan')
})

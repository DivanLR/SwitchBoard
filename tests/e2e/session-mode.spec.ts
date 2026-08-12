// The per-project session mode. The point of the feature is that the choice is
// made once, on the project, and then applies to every session it starts — so the
// tests that matter are the ones proving the choice PERSISTS rather than that a
// control merely looked selected.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('a new project defaults to Auto, which is what every project ran as before', async ({
  page,
}) => {
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('session-mode-auto')).toBeChecked()
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypass']) {
    await expect(page.getByTestId(`session-mode-${mode}`)).not.toBeChecked()
  }
})

test('the mode chosen when adding a project is what its session starts in', async ({ page }) => {
  await page.getByTestId('add-project').click()
  await page.getByTestId('folder-input').fill('C:\\work\\gamma')
  await page.getByTestId('session-mode-acceptEdits').check()
  await page.getByTestId('start-session').click()

  await expect(page.getByTestId('registration-dialog')).toBeHidden()
  const start = await page.evaluate(() => window.__mock.state().starts.at(-1))
  // The start names no mode of its own: it reads the project's, which is the whole
  // point — the session the dialogue opens and every session after it agree.
  expect(start?.mode).toBe('acceptEdits')
  expect(start?.bypassPermissions).toBe(false)
  expect(start?.planMode).toBe(false)
})

test('choosing Bypass sends bypass, and the session records it', async ({ page }) => {
  await page.getByTestId('add-project').click()
  await page.getByTestId('folder-input').fill('C:\\work\\gamma')
  await page.getByTestId('session-mode-bypass').check()
  await page.getByTestId('start-session').click()

  await expect(page.getByTestId('registration-dialog')).toBeHidden()
  const start = await page.evaluate(() => window.__mock.state().starts.at(-1))
  expect(start?.mode).toBe('bypass')
  expect(start?.bypassPermissions).toBe(true)
  // Bypass beats plan by construction now: one value cannot be both.
  expect(start?.planMode).toBe(false)
})

test('the mode can be changed afterwards, and the next session uses the new one', async ({
  page,
}) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-proj').click()
  await expect(page.getByTestId('proj-session-mode')).toBeVisible()
  await page.getByTestId('proj-session-mode-default').click()
  await page.getByTestId('settings-close').click()

  // alpha already has a live session, so end it before another can be started.
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('end-session').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await page.getByTestId('start-session').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts.at(-1)))?.mode)
    .toBe('default')
})

test('each project keeps its own mode', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-proj').click()
  await page.getByTestId('proj-session-mode-plan').click()
  await expect(page.getByTestId('proj-session-mode-plan')).toHaveClass(/sel/)

  // Switch the tab to the other project: it must still be on the default.
  await page.getByTestId('proj-settings-picker').click()
  await page.getByTestId('proj-settings-option-p-beta').click()
  await expect(page.getByTestId('proj-session-mode-auto')).toHaveClass(/sel/)
  await expect(page.getByTestId('proj-session-mode-plan')).not.toHaveClass(/sel/)

  // And back: the first project's choice was not overwritten by reading the second.
  await page.getByTestId('proj-settings-picker').click()
  await page.getByTestId('proj-settings-option-p-alpha').click()
  await expect(page.getByTestId('proj-session-mode-plan')).toHaveClass(/sel/)
})

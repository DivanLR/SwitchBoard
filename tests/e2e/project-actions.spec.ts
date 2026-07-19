// Plugin/skill command suggestions, project removal, and Ctrl+C interrupt.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test("a project's plugin/skill commands are suggested in the composer", async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['ponytail', 'ponytail-review', 'speckit-plan']),
  )
  // Commands load when a project is selected, so switch away and back to pick
  // up the seeded set (they normally arrive from the session init message).
  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('sidebar-project-alpha').click()

  const input = page.getByTestId('composer-input')
  await input.fill('/pony')
  // Ghost text completes the first matching command.
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('tail')
  // Dropdown lists the matching plugin commands.
  const list = page.getByTestId('suggest-list')
  await expect(list).toBeVisible()
  await expect(page.getByTestId('suggest-item-0')).toContainText('/ponytail')
  await expect(page.getByTestId('suggest-item-1')).toContainText('/ponytail-review')
  await input.press('Tab')
  await expect(input).toHaveValue('/ponytail')
})

test('a project can be removed via the confirmation popup', async ({ page }) => {
  // Removal requires no live session, so end beta's session first.
  await page.evaluate(() => window.__mock.endSession('s-beta'))
  await page.getByTestId('sidebar-project-beta').getByTestId('remove-project-beta').click({ force: true })
  // A popup confirms before removing.
  const dialog = page.getByTestId('remove-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('beta')
  await dialog.getByTestId('remove-confirm').click()
  await expect(page.getByTestId('sidebar-project-beta')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('cancel in the popup keeps the project', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-beta'))
  await page.getByTestId('sidebar-project-beta').getByTestId('remove-project-beta').click({ force: true })
  await page.getByTestId('remove-dialog').getByTestId('remove-cancel').click()
  await expect(page.getByTestId('remove-dialog')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})

test('removing a project with a running session is refused with a clear message', async ({ page }) => {
  // s-alpha is 'working' in the scenario.
  await page.getByTestId('sidebar-project-alpha').getByTestId('remove-project-alpha').click({ force: true })
  await page.getByTestId('remove-dialog').getByTestId('remove-confirm').click()
  await expect(page.getByTestId('remove-error')).toContainText('Stop the session')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('right-click opens a context menu to rename or remove', async ({ page }) => {
  await page.getByTestId('sidebar-project-beta').click({ button: 'right' })
  const menu = page.getByTestId('project-ctx-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('beta')
  await expect(menu.getByTestId('ctx-rename')).toBeVisible()
  await expect(menu.getByTestId('ctx-remove')).toBeVisible()
})

test('renaming a project inline updates its name', async ({ page }) => {
  await page.getByTestId('sidebar-project-beta').click({ button: 'right' })
  await page.getByTestId('ctx-rename').click()
  const input = page.getByTestId('rename-input-beta')
  await expect(input).toBeVisible()
  await input.fill('beta-renamed')
  await input.press('Enter')
  await expect(page.getByTestId('sidebar-project-beta-renamed')).toBeVisible()
})

test('the context menu can remove a project (opens the popup)', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-beta'))
  await page.getByTestId('sidebar-project-beta').click({ button: 'right' })
  await page.getByTestId('ctx-remove').click()
  await expect(page.getByTestId('remove-dialog')).toBeVisible()
})

test('Ctrl+C interrupts the running session, like a terminal', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('composer-input').press('Control+c')
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().interrupts)).length)
    .toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__mock.state().interrupts)).toContain('s-alpha')
})

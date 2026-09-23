import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const DAY_MS = 24 * 60 * 60 * 1000

test.beforeEach(async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.projects.push({
    id: 'p-old',
    name: 'old',
    path: 'C:\\work\\old',
    archivedAt: new Date(Date.now() - 27 * DAY_MS - 60_000).toISOString(),
  })
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the context menu deletes a project from Switchboard after a dialog says what goes and what stays', async ({
  page,
}) => {
  await page.evaluate(() => window.__mock.endSession('s-beta'))
  await page.getByTestId('sidebar-project-beta').click({ button: 'right' })
  await page.getByTestId('ctx-delete').click()

  const dialog = page.getByTestId('delete-dialog')
  await expect(dialog).toContainText('Delete beta from Switchboard?')
  await expect(dialog.getByTestId('delete-goes')).toContainText('its sessions and their history')
  await expect(dialog.getByTestId('delete-goes')).toContainText('drafts and the queue')
  await expect(dialog.getByTestId('delete-stays')).toContainText('the folder on disk')
  await expect(dialog.getByTestId('delete-stays')).toContainText('worktrees on disk')
  await expect(dialog.getByTestId('delete-cancel')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()

  await page.getByTestId('sidebar-project-beta').click({ button: 'right' })
  await page.getByTestId('ctx-delete').click()
  await page.getByTestId('delete-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toHaveCount(0)
  await expect(page.getByTestId('group-count-archived')).toHaveText('1')
})

test('deleting a project with a live session is refused and says why', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await page.getByTestId('ctx-delete').click()
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('delete-error')).toContainText('live session')
  await expect(page.getByTestId('delete-dialog')).toBeVisible()
  await page.getByTestId('delete-cancel').click()
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('an archived project shows the days left before it is deleted, and can be deleted now', async ({ page }) => {
  await page.getByTestId('group-head-archived').click()
  await expect(page.getByTestId('archived-days-old')).toHaveText('3 days left')

  await page.getByTestId('delete-project-old').click()
  await expect(page.getByTestId('delete-dialog')).toContainText('Delete old from Switchboard?')
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('archived-project-old')).toHaveCount(0)
  await expect(page.getByTestId('group-head-archived')).toHaveCount(0)
})

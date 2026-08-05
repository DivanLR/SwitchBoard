// Several sessions in one project, listed under it. The sidebar half of the feature:
// starting a second session, seeing both, and switching which one the pane shows.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

/** Starts a second session in alpha through the project's own context menu. */
async function startSecond(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await expect(page.getByTestId('project-ctx-menu')).toBeVisible()
  await page.getByTestId('ctx-new-session').click()
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()
}

test('one session lists no subsessions, because the lane already is that session', async ({
  page,
}) => {
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)
})

test('a project runs a second session alongside the first, and lists both', async ({ page }) => {
  await startSecond(page)

  const rows = page.getByTestId('sidebar-subsessions-alpha').getByRole('button')
  await expect(rows).toHaveCount(2)
  // The pre-seeded session is still there: the second one was added, not swapped in.
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toBeVisible()

  // Both are live, so the board counts two running rather than one.
  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.filter((s) => s.projectId === 'p-alpha')).toHaveLength(1)
})

test('the new session takes focus, since it is the one just asked for', async ({ page }) => {
  await startSecond(page)
  // The seeded session is no longer the focused row; the new one is.
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).not.toHaveClass(/sel/)
  const rows = page.getByTestId('sidebar-subsessions-alpha').getByRole('button')
  await expect(rows.filter({ has: page.locator('.sel') })).toHaveCount(0)
  await expect(rows.nth(1)).toHaveClass(/sel/)
})

test('clicking a subsession points the centre pane at it', async ({ page }) => {
  await startSecond(page)

  // The header quotes the focused run's own id, so it is the proof the pane moved.
  const stamp = page.getByTestId('session-stamp')
  const onNew = await stamp.textContent()

  await page.getByTestId('sidebar-subsession-s-alpha').click()
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toHaveClass(/sel/)
  await expect(stamp).toContainText('s-alpha')
  expect(await stamp.textContent()).not.toBe(onNew)
})

test('a second session in one project leaves the other project alone', async ({ page }) => {
  await startSecond(page)
  await expect(page.getByTestId('sidebar-subsessions-beta')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toBeVisible()
})

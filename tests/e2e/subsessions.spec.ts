import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

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

  const rows = page.getByTestId(/^sidebar-subsession-s/)
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toBeVisible()

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.filter((s) => s.projectId === 'p-alpha')).toHaveLength(1)
})

test('the new session takes focus, since it is the one just asked for', async ({ page }) => {
  await startSecond(page)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).not.toHaveClass(/sel/)
  const rows = page.getByTestId(/^sidebar-subsession-s/)
  await expect(rows.nth(1)).toHaveClass(/sel/)
})

test('clicking a subsession points the centre pane at it', async ({ page }) => {
  await startSecond(page)

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

test('every session in a project can be ended at once, and the list comes back down', async ({
  page,
}) => {
  await startSecond(page)
  await expect(page.getByTestId(/^sidebar-subsession-s/)).toHaveCount(2)

  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  const endAll = page.getByTestId('ctx-end-all')
  await expect(endAll).toBeVisible()
  await expect(endAll).toContainText('2')
  await endAll.click()

  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('the end-all item stays hidden while a project runs a single session', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await expect(page.getByTestId('project-ctx-menu')).toBeVisible()
  await expect(page.getByTestId('ctx-end-all')).toHaveCount(0)
})

test('each session row closes its own session and leaves the rest running', async ({ page }) => {
  await startSecond(page)
  await expect(page.getByTestId(/^sidebar-subsession-s/)).toHaveCount(2)

  await page.getByTestId('session-end-s-alpha').click()

  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toHaveCount(0)

  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

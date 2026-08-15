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

  // Counted by row rather than by button: each row now carries its own close
  // control, so "every button in the list" is two per session.
  const rows = page.getByTestId(/^sidebar-subsession-s/)
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
  // Session rows only: each row also carries its own close control now, so
  // "every button in the list" would be two per session.
  const rows = page.getByTestId(/^sidebar-subsession-s/)
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

// A project accumulates sessions, since a section starts its own, and ending
// them was one at a time. Tedious at two and genuinely annoying at four, which
// is a count this app reaches on its own without being asked.
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

  // Both end, not just the focused one — and the list collapses back to a lane
  // with nothing running under it, which is the other half of the ask.
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

// One session is the lane itself, so there is no "all" to end and the item would
// be a second name for the End button already on screen.
test('the end-all item stays hidden while a project runs a single session', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click({ button: 'right' })
  await expect(page.getByTestId('project-ctx-menu')).toBeVisible()
  await expect(page.getByTestId('ctx-end-all')).toHaveCount(0)
})

// Ending sessions one at a time meant focusing each and using the header button,
// or ending all of them together. Neither is "close that one".
test('each session row closes its own session and leaves the rest running', async ({ page }) => {
  await startSecond(page)
  await expect(page.getByTestId(/^sidebar-subsession-s/)).toHaveCount(2)

  await page.getByTestId('session-end-s-alpha').click()

  // One down, one still running — so the list retires, because a lone session IS
  // the lane and a single child row would be noise.
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toHaveCount(0)

  // The one that closed is the one that was asked to. If the click had ended the
  // project rather than the session, this banner would be up.
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

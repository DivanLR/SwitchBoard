// The three controls the project header gained: one WSL-container checkbox for
// the whole project, one button that starts another session, and the session's
// own name, typed in place.
//
// They belong together because they answer the same complaint — a project ran
// everything in one place, decided where on its own, and gave every session of
// the same checkout the same unhelpful branch name.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the WSL checkbox is off until asked, and reaches the host', async ({ page }) => {
  const box = page.getByTestId('project-containers-input')
  // Off is the default (migration 026): containers are rationed two to the
  // machine, so running everything in one has to be a choice the developer made.
  await expect(box).not.toBeChecked()

  await box.check()
  await expect(box).toBeChecked()

  // Survives a project switch and back, which is the difference between a stored
  // project fact and a control that only looked as though it remembered.
  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('sidebar-project-alpha').click()
  await expect(page.getByTestId('project-containers-input')).toBeChecked()
})

test('a session started from the header follows that checkbox', async ({ page }) => {
  await page.getByTestId('new-session').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised)
    .toBe(false)

  await page.getByTestId('project-containers-input').check()
  await page.getByTestId('new-session').click()
  // The checkbox is the one place the question is answered, so a second button
  // that ignored it would make the checkbox a lie.
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1)?.containerised)
    .toBe(true)
})

test('the header starts another session in the same project', async ({ page }) => {
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)

  await page.getByTestId('new-session').click()

  // Two rows under the project: the seeded session is still there and the new one
  // joined it, rather than replacing it.
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()
  await expect(page.getByTestId(/^sidebar-subsession-s/)).toHaveCount(2)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toBeVisible()
})

test('a session takes the name you type, in the header and in the sidebar', async ({ page }) => {
  // Two sessions, so the sidebar lists them: with one, the project lane already
  // IS that session and there is no row to read the name off.
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()

  await page.getByTestId('sidebar-subsession-s-alpha').click()
  const button = page.getByTestId('session-name')
  await expect(button).toHaveText('Name this session')

  await button.click()
  const input = page.getByTestId('session-name-input')
  await input.fill('release smoke')
  await input.press('Enter')

  await expect(page.getByTestId('session-name')).toHaveText('release smoke')
  // The sidebar reads the same field, so naming it once names it everywhere.
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toContainText('release smoke')
})

test('clearing a name gives the derived one back rather than leaving it blank', async ({ page }) => {
  await page.getByTestId('session-name').click()
  const input = page.getByTestId('session-name-input')
  await input.fill('temporary')
  await input.press('Enter')
  await expect(page.getByTestId('session-name')).toHaveText('temporary')

  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('')
  await page.getByTestId('session-name-input').press('Enter')
  // Empty clears the stored name; nothing was derived for a plain conversation,
  // so the prompt is what is left — and there is no second control for undoing.
  await expect(page.getByTestId('session-name')).toHaveText('Name this session')
})

test('escape abandons an edit instead of saving it', async ({ page }) => {
  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('never sent')
  await page.getByTestId('session-name-input').press('Escape')

  await expect(page.getByTestId('session-name-input')).toHaveCount(0)
  await expect(page.getByTestId('session-name')).toHaveText('Name this session')
})

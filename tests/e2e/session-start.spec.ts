// Starting a session from the ended banner: one mode picker carrying every mode
// the SDK has, one Resume switch, one Start button — and the heavy-subagent
// setting that shapes how whatever starts does the work.
//
// This replaces the transcript suite. Saving a transcript by hand and carrying
// its digest into the next session were both retired: the main process writes
// every transcript continuously without being asked, and "carry the last one"
// was a weaker approximation of the resume this banner now offers directly.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
})

test('the mode picker offers every mode the SDK can spawn, each with its description', async ({
  page,
}) => {
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list).toBeVisible()

  // All six. A picker that offers four of six quietly decides for you.
  for (const mode of ['default', 'dontAsk', 'auto', 'acceptEdits', 'plan', 'bypass']) {
    await expect(list.getByTestId(`start-mode-${mode}`)).toBeVisible()
  }

  // The description is on the row itself and repeated on hover.
  const bypass = list.getByTestId('start-mode-bypass')
  await expect(bypass).toContainText('disposable Docker container')
  await expect(bypass).toHaveAttribute('title', /disposable Docker container/)
})

test('choosing bypass states what it means, rather than only colouring the control', async ({
  page,
}) => {
  await expect(page.getByTestId('bypass-warning')).toHaveCount(0)

  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-bypass').click()

  // The picker closes on selection, so a warning that lived only inside the list
  // would vanish at the moment it started mattering.
  await expect(page.getByTestId('start-mode-list')).toHaveCount(0)
  await expect(page.getByTestId('bypass-warning')).toContainText('Nothing will ask for approval')

  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-plan').click()
  await expect(page.getByTestId('bypass-warning')).toHaveCount(0)
})

test('picking a mode starts the next session in it', async ({ page }) => {
  await page.getByTestId('start-mode-picker').click()
  await page.getByTestId('start-mode-plan').click()
  await expect(page.getByTestId('start-mode-list')).toHaveCount(0)
  await expect(page.getByTestId('start-mode-picker')).toContainText('Plan first')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', mode: 'plan', resume: false })
})

test('Resume asks for a real resume of the previous conversation', async ({ page }) => {
  const resume = page.getByTestId('resume-session')
  await expect(resume).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('start-session')).toContainText('Start session')

  await resume.click()
  await expect(resume).toHaveAttribute('aria-checked', 'true')
  // The button says what it will do, so the choice is legible before the click.
  await expect(page.getByTestId('start-session')).toContainText('Resume')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', resume: true })
})

test('Resume is refused when there is no conversation to resume', async ({ page }) => {
  // Start a fresh session and end it again before it ever reaches an SDK session
  // id. Offering to resume that would be an offer to restore nothing.
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  await page.getByTestId('end-session').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const resume = page.getByTestId('resume-session')
  await expect(resume).toBeDisabled()
  await expect(resume).toHaveAttribute('aria-checked', 'false')
})

test('resuming a native session never offers bypass, because its transcript is on this machine', async ({
  page,
}) => {
  await page.getByTestId('resume-session').click()
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list.getByTestId('start-mode-default')).toBeVisible()
  // Resuming a host session inside a container would look for a transcript that
  // is not there and silently find nothing, so the pair is not offered at all.
  await expect(list.getByTestId('start-mode-bypass')).toHaveCount(0)
  await expect(list).toContainText('on this machine')
})

test('heavy subagent mode is off by default and can be turned on', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  const toggle = page.getByTestId('setting-heavy-subagents')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // It survives closing the panel, because it shapes every session that starts after.
  await page.getByTestId('settings-done').click()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-term').click()
  await expect(page.getByTestId('setting-heavy-subagents')).toHaveAttribute('aria-checked', 'true')
})

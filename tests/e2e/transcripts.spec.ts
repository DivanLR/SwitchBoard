// Session transcripts: saving one on demand, carrying one into the next session,
// and the heavy-subagent setting that shapes how sessions do the work.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('a live session can be written to a transcript file, and says where it landed', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'prompt', { text: 'tighten the lane rows', pending: false })
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Rows are 40px now.', partial: false })
  })

  await page.getByTestId('save-transcript').click()

  // The path is the deliverable: it is what gets handed to anything outside the app.
  const saved = page.getByTestId('transcript-saved')
  await expect(saved).toBeVisible()
  await expect(saved).toContainText('s-alpha.md')

  // It is dismissible, because a path pinned to the header forever is noise.
  await saved.click()
  await expect(saved).toHaveCount(0)
})

test('a saved transcript can be carried into the next session as context', async ({ page }) => {
  // Nothing to carry before anything is saved, and the app must not offer one:
  // an offer to seed expired or absent context would be a lie about what the new
  // session will know.
  await expect(page.getByTestId('carry-transcript-toggle')).toHaveCount(0)

  await page.evaluate(() =>
    window.__mock.emitEvent('s-alpha', 'prompt', { text: 'tighten the lane rows', pending: false }),
  )
  await page.getByTestId('save-transcript').click()
  await expect(page.getByTestId('transcript-saved')).toBeVisible()

  // End the session so the start panel is on screen.
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()

  const carry = page.getByTestId('carry-transcript-toggle')
  await expect(carry).toBeVisible()
  await expect(carry).toHaveAttribute('aria-checked', 'false')
  await carry.click()
  await expect(carry).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  // The new session was asked for with the previous session's transcript.
  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', carryTranscriptFrom: 's-alpha' })
})

test('starting without the toggle carries nothing', async ({ page }) => {
  await page.getByTestId('save-transcript').click()
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('carry-transcript-toggle')).toBeVisible()

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)?.carryTranscriptFrom).toBeUndefined()
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

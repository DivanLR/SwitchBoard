import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

async function endWithPrompt(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'prompt', { text: 'tighten the lane rows', pending: false })
    window.__mock.emitEvent('s-alpha', 'assistant_text', { text: 'Rows are 40px now.', partial: false })
    window.__mock.endSession('s-alpha')
  })
  await expect(page.getByTestId('ended-banner')).toBeVisible()
}

test('the ended session transcript can be carried into the next session as context', async ({ page }) => {
  await endWithPrompt(page)

  const carry = page.getByTestId('carry-transcript-toggle')
  await expect(carry).toBeVisible()
  await expect(carry).toHaveAttribute('aria-checked', 'false')
  await carry.click()
  await expect(carry).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ projectId: 'p-alpha', resume: false, carryTranscriptFrom: 's-alpha' })
})

test('starting without the toggle carries nothing', async ({ page }) => {
  await endWithPrompt(page)
  await expect(page.getByTestId('carry-transcript-toggle')).toBeVisible()

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)?.carryTranscriptFrom).toBeUndefined()
})

test('a session that was never asked anything offers no transcript to carry', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.endSession('s-alpha')
    window.__mock.emitEvent('s-beta', 'prompt', { text: 'rename the branch', pending: false })
    window.__mock.endSession('s-beta')
  })
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('carry-transcript-toggle')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await expect(page.getByTestId('carry-transcript-toggle')).toHaveCount(0)
})

test('resuming withdraws the carry, because a resume already has the whole conversation', async ({ page }) => {
  await endWithPrompt(page)
  const carry = page.getByTestId('carry-transcript-toggle')
  await carry.click()
  await expect(carry).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('resume-session').click()
  await expect(carry).toHaveCount(0)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ resume: true })
  expect(starts.at(-1)?.carryTranscriptFrom).toBeUndefined()
})

test('a Codex start withdraws the carry, because Codex takes no carried instructions', async ({ page }) => {
  await endWithPrompt(page)
  const carry = page.getByTestId('carry-transcript-toggle')
  await carry.click()

  await page.getByTestId('start-engine-codex').click()
  await expect(carry).toHaveCount(0)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const starts = await page.evaluate(() => window.__mock.state().starts)
  expect(starts.at(-1)).toMatchObject({ engine: 'codex' })
  expect(starts.at(-1)?.carryTranscriptFrom).toBeUndefined()
})

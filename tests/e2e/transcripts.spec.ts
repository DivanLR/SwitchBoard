import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

async function endWithPrompt(page: import('@playwright/test').Page, sessionId = 's-alpha'): Promise<void> {
  await page.evaluate((id) => {
    window.__mock.emitEvent(id, 'prompt', { text: 'tighten the lane rows', pending: false })
    window.__mock.emitEvent(id, 'assistant_text', { text: 'Rows are 40px now.', partial: false })
    window.__mock.endSession(id)
  }, sessionId)
  await expect(page.getByTestId('ended-banner')).toBeVisible()
}

async function lastStart(page: import('@playwright/test').Page) {
  return (await page.evaluate(() => window.__mock.state().starts)).at(-1)
}

test('Continue resumes the conversation when it can be resumed, and carries nothing', async ({ page }) => {
  await endWithPrompt(page)

  const cont = page.getByTestId('resume-session')
  await expect(cont).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('continue-how')).toContainText('Resumes the conversation')
  await expect(page.getByTestId('carry-transcript-toggle')).toHaveCount(0)
  await cont.click()
  await expect(cont).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('start-session')).toContainText('Resume')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const start = await lastStart(page)
  expect(start).toMatchObject({ projectId: 'p-alpha', resume: true })
  expect(start?.carryTranscriptFrom).toBeUndefined()
})

test('Continue carries the transcript when the conversation cannot be resumed', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const freshId = await page.evaluate(async () => {
    const { projects } = await window.switchboard.invoke('projects.list', undefined)
    return projects.find((p) => p.id === 'p-alpha')?.session?.id ?? ''
  })
  await endWithPrompt(page, freshId)

  await expect(page.getByTestId('continue-how')).toHaveText('Carries its transcript, 1 prompt')
  await page.getByTestId('resume-session').click()
  await expect(page.getByTestId('start-session')).toContainText('Continue')

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  expect(await lastStart(page)).toMatchObject({ projectId: 'p-alpha', resume: false, carryTranscriptFrom: freshId })
})

test('starting with Continue off neither resumes nor carries', async ({ page }) => {
  await endWithPrompt(page)

  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)
  const start = await lastStart(page)
  expect(start).toMatchObject({ resume: false })
  expect(start?.carryTranscriptFrom).toBeUndefined()
})

test('a Codex start cannot continue a Claude session', async ({ page }) => {
  await endWithPrompt(page)
  const cont = page.getByTestId('resume-session')
  await cont.click()

  await page.getByTestId('start-engine-codex').click()
  await expect(cont).toBeDisabled()
  await expect(cont).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('continue-how')).toHaveCount(0)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('ended-banner')).toHaveCount(0)

  const start = await lastStart(page)
  expect(start).toMatchObject({ engine: 'codex', resume: false })
  expect(start?.carryTranscriptFrom).toBeUndefined()
})

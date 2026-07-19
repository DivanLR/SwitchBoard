// T044: composer queueing, clickable questions, and interrupt (quickstart V4).
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('mid-task sends queue visibly and deliver when the session is ready (FR-019)', async ({
  page,
}) => {
  // s-alpha starts in status working, so the send queues.
  await page.getByTestId('composer-input').fill('queued message')
  await page.getByTestId('composer-send').click()

  const prompt = page.getByTestId('stream-event-prompt').filter({ hasText: 'queued message' })
  await expect(prompt.getByTestId('prompt-pending')).toBeVisible()

  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(prompt.getByTestId('prompt-pending')).toHaveCount(0)
})

test('multiple-choice questions are answered by click, in the stream, never the inbox (FR-020)', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__mock.askQuestion('s-alpha', 'Which approach should I take?', ['Fast', 'Thorough']),
  )

  await expect(page.getByTestId('question-event')).toContainText('Which approach should I take?')
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'needs_you')
  // Questions never appear in the inbox (FR-020).
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
  await expect(page.getByTestId('inbox-zero')).toBeVisible()

  await page.getByTestId('question-option-Thorough').click()
  await expect(page.getByTestId('question-answered')).toContainText('Thorough')

  const answers = await page.evaluate(() => window.__mock.state().answers)
  expect(answers).toEqual([{ eventId: expect.any(String), choice: 'Thorough' }])

  // Clicking again does nothing: the options are disabled once answered.
  await expect(page.getByTestId('question-option-Fast')).toBeDisabled()
})

test('interrupt stops the activity and the session remains usable (FR-019a)', async ({ page }) => {
  await page.getByTestId('interrupt-btn').click()
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => window.__mock.state().interrupts)).toEqual(['s-alpha'])

  await page.getByTestId('composer-input').fill('carry on')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('stream-event-prompt').filter({ hasText: 'carry on' })).toBeVisible()
})

test('stop ends the session and offers a new start (FR-019a)', async ({ page }) => {
  await page.getByTestId('stop-btn').click()
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await expect(page.getByTestId('start-session')).toBeVisible()
})

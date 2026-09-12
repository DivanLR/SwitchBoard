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
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
  await expect(page.getByTestId('inbox-zero')).toBeVisible()

  await page.getByTestId('question-option-Thorough').click()
  await expect(page.getByTestId('question-answered')).toContainText('Thorough')

  const answers = await page.evaluate(() => window.__mock.state().answers)
  expect(answers).toEqual([{ eventId: expect.any(String), choice: 'Thorough' }])

  await expect(page.getByTestId('question-option-Fast')).toBeDisabled()
})

test('Ctrl+C interrupts the activity and the session remains usable (FR-019a)', async ({
  page,
}) => {
  const input = page.getByTestId('composer-input')
  await input.focus()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toBeVisible()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('status-badge-alpha')).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => window.__mock.state().interrupts)).toEqual(['s-alpha'])

  await page.getByTestId('composer-input').fill('carry on')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('stream-event-prompt').filter({ hasText: 'carry on' })).toBeVisible()
})

test('an ended session shows the banner and offers a new start (FR-019a)', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await expect(page.getByTestId('start-session')).toBeVisible()
})

test('a scrolled-back stream offers a jump to the newest line', async ({ page }) => {
  await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0)

  await page.evaluate(() => {
    for (let i = 0; i < 60; i++) {
      window.__mock.emitEvent('s-alpha', 'assistant_text', {
        text: `line ${i} — long enough to fill the pane and force a scrollback`,
        partial: false,
      })
    }
  })
  const stream = page.getByTestId('stream')
  await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0) 

  await stream.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.getByTestId('scroll-to-bottom')).toBeVisible()

  await page.getByTestId('scroll-to-bottom').click()
  await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0)
  expect(
    await stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
  ).toBeLessThan(24)
})

test('a working session offers a red stop button that interrupts the turn', async ({ page }) => {
  await expect(page.getByTestId('stop-session')).toBeVisible()
  await expect(page.getByTestId('stop-session')).not.toContainText('⌃C')
  await expect(page.getByTestId('stop-session')).toHaveAttribute(
    'aria-label',
    'Interrupt the current turn',
  )

  await page.getByTestId('stop-session').click()
  await expect.poll(() => page.evaluate(() => window.__mock.state().interrupts.length)).toBe(1)

  await expect(page.getByTestId('end-session')).toBeVisible()

  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(page.getByTestId('stop-session')).toHaveCount(0)
})

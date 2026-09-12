import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

async function queueMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('prompt-pending')).toBeVisible()
}

test('a queued message shows as queued and offers itself for editing', async ({ page }) => {
  await queueMessage(page, 'run the tests')

  const editable = page.getByTestId('prompt-editable')
  await expect(editable).toBeVisible()
  await expect(editable).toContainText('run the tests')
  await expect(editable).toHaveAttribute('title', /edit/i)
})

test('rewording a queued message sends the new text when the turn finishes', async ({ page }) => {
  await queueMessage(page, 'run the tests')

  await page.getByTestId('prompt-editable').click()
  const editor = page.getByTestId('prompt-edit')
  await expect(editor).toBeVisible()
  await editor.fill('run the tests, then lint')
  await editor.press('Enter')

  await expect(page.getByTestId('prompt-editable')).toContainText('run the tests, then lint')
  await expect(page.getByTestId('prompt-pending')).toBeVisible()

  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(page.getByTestId('prompt-pending')).toHaveCount(0)
  const sent = await page.evaluate(() => window.__mock.state().sends)
  expect(sent.some((s) => s.text === 'run the tests')).toBe(true) 
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'run the tests, then lint' }),
  ).toBeVisible()
})

test('Escape abandons an edit and leaves the queued text alone', async ({ page }) => {
  await queueMessage(page, 'original text')

  await page.getByTestId('prompt-editable').click()
  await page.getByTestId('prompt-edit').fill('discard this')
  await page.getByTestId('prompt-edit').press('Escape')

  await expect(page.getByTestId('prompt-editable')).toContainText('original text')
  await expect(page.getByTestId('prompt-pending')).toBeVisible()
})

test('clearing a queued message withdraws it, and it is never delivered', async ({ page }) => {
  await queueMessage(page, 'never mind this')

  await page.getByTestId('prompt-editable').click()
  await page.getByTestId('prompt-edit').fill('')
  await page.getByTestId('prompt-edit').press('Enter')

  await expect(page.getByTestId('prompt-withdrawn')).toBeVisible()
  await expect(page.getByTestId('prompt-pending')).toHaveCount(0)
  await expect(page.getByTestId('prompt-editable')).toHaveCount(0)
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'never mind this' }),
  ).toBeVisible()

  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(page.getByTestId('prompt-withdrawn')).toBeVisible()
  await expect(page.getByTestId('prompt-pending')).toHaveCount(0)
})

test('a message already delivered is not editable', async ({ page }) => {
  await queueMessage(page, 'on its way')
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))

  await expect(page.getByTestId('prompt-pending')).toHaveCount(0)
  await expect(page.getByTestId('prompt-editable')).toHaveCount(0)
})

test('a turn that finishes mid-edit says the message has already gone', async ({ page }) => {
  await queueMessage(page, 'too late to change')

  await page.getByTestId('prompt-editable').click()
  await page.getByTestId('prompt-edit').fill('changed my mind')

  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await page.getByTestId('prompt-edit').press('Enter')

  await expect(page.getByTestId('queued-edit-error')).toContainText('already been sent')
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'too late to change' }),
  ).toBeVisible()
})

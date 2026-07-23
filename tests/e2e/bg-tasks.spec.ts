// Background tasks + subagents: visibility, capping, and the summary-suppression
// gate while background work runs.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await page.getByTestId('sidebar-project-alpha').click()
})

test('background tasks show as a card + header pill', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setBackgroundTasks('s-alpha', [
      { taskId: 't1', description: 'deep-research: 12 sources' },
      { taskId: 't2', description: 'workflow wf_ab: 5 agents' },
    ]),
  )
  await expect(page.getByTestId('bg-pill')).toContainText('2 background')
  const card = page.getByTestId('bg-task-list')
  await expect(card).toBeVisible()
  await expect(card).toContainText('deep-research: 12 sources')
  await expect(page.getByTestId('bg-task-row')).toHaveCount(2)
})

test('a large background fan-out is capped with a show-all toggle', async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, i) => ({ taskId: `t${i}`, description: `task ${i}` }))
  await page.evaluate((tasks) => window.__mock.setBackgroundTasks('s-alpha', tasks), many)
  // Only the first 6 show; a "+5 more" / toggle reveals the rest.
  await expect(page.getByTestId('bg-task-row')).toHaveCount(6)
  await expect(page.getByTestId('bg-task-more')).toContainText('5 more')
  await page.getByTestId('bg-task-toggle').click()
  await expect(page.getByTestId('bg-task-row')).toHaveCount(11)
  await page.getByTestId('bg-task-toggle').click()
  await expect(page.getByTestId('bg-task-row')).toHaveCount(6)
})

test('interim summaries are hidden while background work runs; turn-complete stays', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mock.setBackgroundTasks('s-alpha', [{ taskId: 't1', description: 'auditing' }])
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'Slice 1 back. Five auditors running.' })
    window.__mock.emitEvent('s-alpha', 'result', { totalCostUsd: 3.26, durationMs: 8300, usage: {} })
  })
  // The turn-complete line shows; the interim summary card does not.
  await expect(page.getByTestId('result-event')).toBeVisible()
  await expect(page.getByTestId('stream').getByTestId('stream-event-summary')).toHaveCount(0)

  // Once background work settles, a summary renders normally.
  await page.evaluate(() => {
    window.__mock.setBackgroundTasks('s-alpha', [])
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'All done — consolidated report.' })
  })
  // Only the final summary renders — the interim one stays hidden.
  const summaries = page.getByTestId('stream').getByTestId('stream-event-summary')
  await expect(summaries).toHaveCount(1)
  await expect(summaries).toContainText('consolidated report')
})

test('Ctrl+C only stops when the composer is focused, and confirms first', async ({ page }) => {
  const input = page.getByTestId('composer-input')

  // Focus elsewhere → Ctrl+C does nothing to the session.
  await page.getByTestId('session-project-name').click()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toHaveCount(0)

  // In the composer → first Ctrl+C shows the confirm, no interrupt yet.
  await input.focus()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBe(0)

  // Second Ctrl+C confirms → interrupt is sent.
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toHaveCount(0)
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBe(1)
})

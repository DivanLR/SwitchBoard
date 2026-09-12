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

test('a task that never reported can be cleared, and the session settles', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setBackgroundTasks('s-alpha', [
      { taskId: 't1', description: 'Locate archify.mjs referenced by the README' },
    ]),
  )
  await expect(page.getByTestId('bg-task-list')).toBeVisible()

  await page.getByTestId('bg-task-clear').click()

  await expect(page.getByTestId('bg-task-list')).toHaveCount(0)
  await expect(page.getByTestId('bg-pill')).toHaveCount(0)
})

test('a large background fan-out is capped with a show-all toggle', async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, i) => ({ taskId: `t${i}`, description: `task ${i}` }))
  await page.evaluate((tasks) => window.__mock.setBackgroundTasks('s-alpha', tasks), many)
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
  await expect(page.getByTestId('result-event')).toBeVisible()
  await expect(page.getByTestId('stream').getByTestId('stream-event-summary')).toHaveCount(0)

  await page.evaluate(() => {
    window.__mock.setBackgroundTasks('s-alpha', [])
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'All done, consolidated report.' })
  })
  const summaries = page.getByTestId('stream').getByTestId('stream-event-summary')
  await expect(summaries).toHaveCount(2)
  await expect(summaries.first()).toContainText('Five auditors running')
  await expect(summaries.last()).toContainText('consolidated report')
})

test('Ctrl+C only stops when the composer is focused, and confirms first', async ({ page }) => {
  const input = page.getByTestId('composer-input')

  await page.getByTestId('session-project-name').click()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toHaveCount(0)

  await input.focus()
  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBe(0)

  await page.keyboard.press('Control+c')
  await expect(page.getByTestId('stop-confirm')).toHaveCount(0)
  expect(await page.evaluate(() => window.__mock.state().interrupts.length)).toBe(1)
})

test('background work hides only the summaries that arrive during it', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'Earlier summary, before any background work' })
  })
  await expect(page.getByTestId('stream')).toContainText('Earlier summary')

  await page.evaluate(() => {
    window.__mock.setBackgroundTasks('s-alpha', [{ taskId: 't1', description: 'deep research' }])
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'Interim chatter while researching' })
  })
  await expect(page.getByTestId('stream')).not.toContainText('Interim chatter')

  await expect(page.getByTestId('stream')).toContainText('Earlier summary')

  await page.evaluate(() => {
    window.__mock.setBackgroundTasks('s-alpha', [])
    window.__mock.emitEvent('s-alpha', 'summary', { text: 'Final consolidated summary' })
  })
  await expect(page.getByTestId('stream')).toContainText('Final consolidated summary')
  await expect(page.getByTestId('stream')).toContainText('Earlier summary')
  await expect(page.getByTestId('stream')).toContainText('Interim chatter')
})

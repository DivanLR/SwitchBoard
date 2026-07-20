// Planned task queue (FR-023).
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

test('planned goals queue while the session is busy and run in order as it goes idle', async ({
  page,
}) => {
  // s-alpha starts working, so queued tasks wait rather than run immediately.
  await page.getByTestId('composer-input').fill('first goal')
  await page.getByTestId('composer-queue').click()
  await page.getByTestId('composer-input').fill('second goal')
  await page.getByTestId('composer-queue').click()

  const queue = page.getByTestId('task-queue')
  await expect(queue.getByTestId('queue-item-0')).toContainText('first goal')
  await expect(queue.getByTestId('queue-item-1')).toContainText('second goal')

  // First turn completes: the front task is delivered and leaves the queue.
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(page.getByTestId('queue-item-0')).toContainText('second goal')
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'first goal' }),
  ).toBeVisible()

  // Second turn completes: the last task runs and the queue empties.
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(page.getByTestId('task-queue')).toHaveCount(0)
  await expect(
    page.getByTestId('stream-event-prompt').filter({ hasText: 'second goal' }),
  ).toBeVisible()

  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(sends).toEqual(['first goal', 'second goal'])
})

test('a queued goal can be removed before it runs', async ({ page }) => {
  await page.getByTestId('composer-input').fill('remove me')
  await page.getByTestId('composer-queue').click()
  await expect(page.getByTestId('queue-item-0')).toContainText('remove me')

  await page.getByTestId('queue-remove-0').click()
  await expect(page.getByTestId('task-queue')).toHaveCount(0)
})

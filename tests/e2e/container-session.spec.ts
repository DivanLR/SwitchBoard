import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

function containerScenario(): ReturnType<typeof twoProjectScenario> {
  const scenario = twoProjectScenario()
  const alpha = scenario.projects[0]
  alpha.session = { ...alpha.session!, containerised: true }
  return scenario
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, containerScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('a live container session offers no hand-over to the CLI on this machine', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-terminal').click()
  await page.getByTestId('conversation-terminal-shell').click()
  const pane = page.getByTestId('terminal-pane')
  await expect(pane.getByTestId('terminal-live-note')).toBeVisible()
  await expect(pane.getByTestId('terminal-takeover')).toHaveCount(0)
})

test('resuming a container session keeps it in a container, whatever the project switch says now', async ({
  page,
}) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  const toggle = page.getByTestId('run-in-container')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await page.getByTestId('resume-session').click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeDisabled()

  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list.getByTestId('start-mode-bypass')).toBeVisible()
  await expect(list).toContainText('inside the container')
  await list.getByTestId('start-mode-default').click()

  await page.getByTestId('start-session').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1))
    .toMatchObject({ projectId: 'p-alpha', resume: true, resumeSessionId: 's-alpha', mode: 'default', containerised: true })
})

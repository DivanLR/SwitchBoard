import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('settings chooses the engine for new sessions and lists the Codex models apart from Claude', async ({
  page,
}) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('default-engine-claude')).toHaveClass(/sel/)
  await expect(panel.getByTestId('model-gpt-5-codex')).toHaveCount(0)
  await panel.getByTestId('codex-model-gpt-5-codex').click()
  await expect(panel.getByTestId('codex-model-gpt-5-codex')).toHaveClass(/sel/)
  await panel.getByTestId('default-engine-codex').click()
  await expect(panel.getByTestId('default-engine-codex')).toHaveClass(/sel/)
  await panel.getByTestId('settings-done').click()
  await page.getByTestId('open-settings').click()
  await expect(panel.getByTestId('default-engine-codex')).toHaveClass(/sel/)
  await expect(panel.getByTestId('default-engine-claude')).not.toHaveClass(/sel/)
})

test('an ended session starts again on Codex, on this machine and never in bypass', async ({ page }) => {
  await page.evaluate(() => window.__mock.endSession('s-alpha'))
  await expect(page.getByTestId('ended-banner')).toBeVisible()
  await expect(page.getByTestId('start-engine-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('run-in-container')).toBeVisible()
  await expect(page.getByTestId('resume-session')).toBeEnabled()

  await page.getByTestId('start-engine-codex').click()
  await expect(page.getByTestId('run-in-container')).toHaveCount(0)
  await expect(page.getByTestId('resume-session')).toBeDisabled()
  await page.getByTestId('start-mode-picker').click()
  const list = page.getByTestId('start-mode-list')
  await expect(list.getByTestId('start-mode-bypass')).toHaveCount(0)
  await list.getByTestId('start-mode-default').click()

  await page.getByTestId('start-session').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().starts)).at(-1))
    .toMatchObject({ projectId: 'p-alpha', engine: 'codex', containerised: false, mode: 'default' })
  await page.getByTestId('tab-terminal').click()
  await expect(page.getByTestId('conversation-terminal-title')).toContainText('Codex')
})

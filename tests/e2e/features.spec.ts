import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the status bar token count increases after a completed turn', async ({ page }) => {
  const tokens = page.getByTestId('usage-tokens')
  await expect(tokens).toHaveText('0 tok')
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(tokens).not.toHaveText('0 tok')
})

test('settings exposes model cards', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('model-claude-fable-5')).toBeVisible()
  await expect(panel.getByTestId('model-claude-sonnet-5')).toBeVisible()
  await panel.getByTestId('model-claude-opus-5[1m]').click()
  await expect(panel.getByTestId('model-claude-opus-5[1m]')).toHaveClass(/sel/)
  await panel.getByTestId('settings-done').click()
  await expect(page.getByTestId('model-summary')).toContainText('Opus 5')
})

test('General keeps plugins and skills up to date, checks on demand and lists every result', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-gen').click()

  const toggle = panel.getByTestId('setting-keep-current')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(panel).toContainText('Updates apply to sessions started afterwards.')
  await expect(panel.getByTestId('keep-current-last')).toHaveText('Not checked yet.')
  await expect(panel.getByTestId('keep-current-results')).toHaveCount(0)

  await panel.getByTestId('keep-current-check').click()
  await expect(panel.getByTestId('keep-current-last')).toContainText('Last checked')
  await expect(panel.getByTestId('keep-current-last')).toContainText(
    '1 needs your confirmation, 1 failed, 1 updated, 1 current.',
  )
  const rows = panel.getByTestId('keep-current-results').getByTestId('keep-result-status')
  await expect(rows).toHaveText(['Needs your confirmation', 'Failed', 'Updated', 'Current'])
  await expect(panel.getByTestId('keep-result-brag@brag (project)')).toContainText(
    'The marketplace declares a command to fetch it.',
  )
  await expect(panel.getByTestId('keep-result-research')).toContainText('GitHub is rate-limiting this machine.')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await panel.getByTestId('settings-done').click()
  await page.getByTestId('open-settings').click()
  await panel.getByTestId('settings-tab-gen').click()
  await expect(panel.getByTestId('setting-keep-current')).toHaveAttribute('aria-checked', 'false')
  await expect(panel.getByTestId('keep-current-results').getByTestId('keep-result-status')).toHaveCount(4)
})

test('the picker follows the account: a new model appears, a retired one goes', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setAvailableModels([
      { id: 'claude-fable-5', label: 'Fable', description: '' },
      { id: 'claude-sonnet-5', label: 'Sonnet', description: '' },
      { id: 'claude-opus-7-2[1m]', label: 'Opus (1M context)', description: 'Newest Opus' },
    ]),
  )
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  const newCard = panel.getByTestId('model-claude-opus-7-2[1m]')
  await expect(newCard).toBeVisible()
  await expect(newCard).toContainText('Opus 7.2 (1M)')
  await expect(newCard).toContainText('Newest Opus')
  await expect(panel.getByTestId('model-claude-fable-5')).toBeVisible()
  await expect(panel.getByTestId('model-claude-opus-5[1m]')).toHaveCount(0)
  await expect(panel.getByTestId('model-claude-opus-4-8')).toHaveCount(0)
  await expect(panel.getByTestId('model-default')).toBeVisible()
})

test('the This project tab configures the project, but never its models', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-proj').click()
  await expect(panel.getByTestId('proj-settings-picker')).toBeVisible()

  await expect(panel.getByTestId('proj-model-global')).toHaveCount(0)
  await expect(panel.getByTestId('proj-worker-global')).toHaveCount(0)

  await panel.getByTestId('settings-tab-models').click()
  await expect(panel.getByTestId('model-default')).toBeVisible()
})

test('no subscription rate-limit meter is rendered, even once usage reports', async ({ page }) => {
  await page.evaluate(() => window.__mock.setUsage('s-alpha', 72, 95, 'five_hour'))
  await expect(page.getByTestId('statusbar')).not.toContainText('5h limit')
  await expect(page.getByTestId('session-usage')).toHaveCount(0)
})

test('typing "/" lists many available skill commands (not just 6)', async ({ page }) => {
  const many = Array.from({ length: 20 }, (_, i) => `skill-${String(i).padStart(2, '0')}`)
  await page.evaluate((cmds) => window.__mock.setCommands('p-alpha', cmds), many)
  await page.getByTestId('sidebar-project-beta').click()
  await page.getByTestId('sidebar-project-alpha').click()

  await page.getByTestId('composer-input').fill('/skill-')
  const items = page.getByTestId('suggest-list').locator('.suggest-item')
  expect(await items.count()).toBeGreaterThan(10)
})

test('decision history expands to show the full command description', async ({ page }) => {
  await page.evaluate(() => {
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: npm test',
      explanation: 'Runs the cart test suite to verify the race fix.',
      detail: 'Bash: npm test -- cart',
      risk: 'low',
    })
  })
  await page.getByTestId('inbox-group-alpha').getByTestId('approve-btn').click()
  await page.getByTestId('inbox-tab-history').click()
  await page.getByTestId('history-item').first().click()
  await expect(page.getByTestId('history-detail')).toContainText(
    'Runs the cart test suite to verify the race fix.',
  )
})

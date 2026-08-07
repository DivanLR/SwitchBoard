// New feature coverage: tokens today, per-model settings, history descriptions,
// and the "/" command palette listing all skills.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the status bar token count increases after a completed turn', async ({ page }) => {
  // Token spend is counted from persisted event rows, so it works regardless of
  // whether the subscription ever reports a rate-limit window.
  const tokens = page.getByTestId('usage-tokens')
  await expect(tokens).toHaveText('0 tok')
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(tokens).not.toHaveText('0 tok')
})

test('settings exposes intelligent and worker model cards', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('intelligent-model-claude-fable-5')).toBeVisible()
  await expect(panel.getByTestId('worker-model-claude-sonnet-5')).toBeVisible()
  // Picking an intelligent-model card selects it.
  await panel.getByTestId('intelligent-model-claude-opus-5[1m]').click()
  await expect(panel.getByTestId('intelligent-model-claude-opus-5[1m]')).toHaveClass(/sel/)
  // The sidebar model summary reflects the choice, labelled from the id.
  await panel.getByTestId('settings-done').click()
  await expect(page.getByTestId('model-summary')).toContainText('Opus 5')
})

test('the picker follows the account: a new model appears, a retired one goes', async ({ page }) => {
  // Simulate a model release: the account gains a model the app has never seen
  // and loses the one it used to ship in code.
  await page.evaluate(() =>
    window.__mock.setAvailableModels([
      { id: 'claude-fable-5', label: 'Fable', description: '' },
      { id: 'claude-sonnet-5', label: 'Sonnet', description: '' },
      { id: 'claude-opus-7-2[1m]', label: 'Opus (1M context)', description: 'Newest Opus' },
    ]),
  )
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  // The brand-new model is selectable, named and described without a code change.
  const newCard = panel.getByTestId('intelligent-model-claude-opus-7-2[1m]')
  await expect(newCard).toBeVisible()
  await expect(newCard).toContainText('Opus 7.2 (1M)')
  await expect(newCard).toContainText('Newest Opus')
  await expect(panel.getByTestId('intelligent-model-claude-fable-5')).toBeVisible()
  // Models the account no longer offers are gone, including the previous Opus.
  await expect(panel.getByTestId('intelligent-model-claude-opus-5[1m]')).toHaveCount(0)
  await expect(panel.getByTestId('intelligent-model-claude-opus-4-8')).toHaveCount(0)
  // The account default is always offered, whatever the account reports.
  await expect(panel.getByTestId('intelligent-model-default')).toBeVisible()
})

test('settings Terminals tab explains terse mode and its levels', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-term').click()
  await expect(panel.getByTestId('setting-terse-mode')).toBeVisible()
  // Terse level cards are shown with explanations while terse mode is on.
  await expect(panel.getByTestId('terse-level-full')).toBeVisible()
  await expect(panel).toContainText('conclusion first')
})

test('settings has a This project tab with a per-project model override', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('settings-tab-proj').click()
  await expect(panel.getByTestId('proj-settings-picker')).toBeVisible()
  // Defaults to the global model; picking a card overrides for this project only.
  await expect(panel.getByTestId('proj-model-global')).toHaveClass(/sel/)
  await panel.getByTestId('proj-model-claude-haiku-4-5-20251001').click()
  await expect(panel.getByTestId('proj-model-claude-haiku-4-5-20251001')).toHaveClass(/sel/)
})

test('no subscription rate-limit meter is rendered, even once usage reports', async ({ page }) => {
  // It read the SDK's rate_limit_event, which never arrives for this account, so
  // it only ever showed an em dash. Removed rather than left claiming a reading.
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
  // More than the 6-item cap used for ordinary history matches.
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

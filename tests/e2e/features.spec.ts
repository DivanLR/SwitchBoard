// New feature coverage: tokens today, per-model settings, history descriptions,
// and the "/" command palette listing all skills.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('session usage meter shows token spend and increases after a completed turn', async ({
  page,
}) => {
  // The design moved token spend out of the stats card into the session-usage
  // meter, which shows once a session reports rate-limit utilization.
  await page.evaluate(() => window.__mock.setUsage('s-alpha', 40, 120, 'five_hour'))
  const tokens = page.getByTestId('usage-tokens')
  await expect(tokens).toHaveText('0 tok')
  await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  await expect(tokens).not.toHaveText('0 tok')
})

test('settings exposes planning and work model cards', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('plan-model-claude-fable-5')).toBeVisible()
  await expect(panel.getByTestId('work-model-claude-opus-4-8')).toBeVisible()
  // Picking a work-model card selects it.
  await panel.getByTestId('work-model-claude-opus-4-8').click()
  await expect(panel.getByTestId('work-model-claude-opus-4-8')).toHaveClass(/sel/)
  // The sidebar model summary reflects the choice.
  await panel.getByTestId('settings-done').click()
  await expect(page.getByTestId('model-summary')).toContainText('Opus')
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

test('the session usage meter shows when a session reports rate-limit usage', async ({ page }) => {
  // No usage yet → no meter.
  await expect(page.getByTestId('usage-meter')).toHaveCount(0)
  await page.evaluate(() => window.__mock.setUsage('s-alpha', 72, 95, 'five_hour'))
  const meter = page.getByTestId('usage-meter')
  await expect(meter).toBeVisible()
  await expect(meter).toContainText('72% of 5h limit')
  await expect(meter).toContainText('Resets in')
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

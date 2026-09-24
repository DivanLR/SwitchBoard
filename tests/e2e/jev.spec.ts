import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the mode list offers Jev, Auto and Basic, and no Advisor or Orchestrator card', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('mode-jev')).toBeVisible()
  await expect(panel.getByTestId('mode-auto')).toBeVisible()
  await expect(panel.getByTestId('mode-basic')).toBeVisible()
  await expect(panel.getByTestId('mode-advisor')).toHaveCount(0)
  await expect(panel.getByTestId('mode-orchestrator')).toHaveCount(0)

  await panel.getByTestId('mode-jev').click()
  await expect(panel.getByTestId('mode-jev')).toHaveClass(/sel/)
})

test('saving a Jev key clears the input and shows the saved state, and removing it brings the input back', async ({
  page,
}) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')

  const input = panel.getByTestId('jev-key-input')
  await expect(input).toBeVisible()
  await input.fill('sk-jev-test-key-1234')
  await panel.getByTestId('jev-key-save').click()

  await expect(panel.getByTestId('jev-key-saved')).toBeVisible()
  await expect(panel.getByTestId('jev-key-input')).toHaveCount(0)

  await expect
    .poll(() => page.evaluate(() => window.switchboard.invoke('jev.status', undefined)))
    .toMatchObject({ configured: true })

  await panel.getByTestId('jev-key-remove').click()
  await expect(panel.getByTestId('jev-key-saved')).toHaveCount(0)
  await expect(panel.getByTestId('jev-key-input')).toBeVisible()
  await expect(panel.getByTestId('jev-key-input')).toHaveValue('')

  await expect
    .poll(() => page.evaluate(() => window.switchboard.invoke('jev.status', undefined)))
    .toMatchObject({ configured: false })
})

test('replacing a saved key can be cancelled, leaving the saved state in place', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')

  await panel.getByTestId('jev-key-input').fill('sk-jev-test-key-1234')
  await panel.getByTestId('jev-key-save').click()
  await expect(panel.getByTestId('jev-key-saved')).toBeVisible()

  await panel.getByTestId('jev-key-replace').click()
  await expect(panel.getByTestId('jev-key-input')).toBeVisible()
  await panel.getByTestId('jev-key-cancel').click()
  await expect(panel.getByTestId('jev-key-saved')).toBeVisible()
})

test('Test key reports no key set, then reports the answer once one is saved', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')

  await panel.getByTestId('jev-key-test').click()
  await expect(panel.getByTestId('jev-test-result')).toContainText('No Jev API key is set')

  await panel.getByTestId('jev-key-input').fill('sk-jev-test-key-1234')
  await panel.getByTestId('jev-key-save').click()
  await panel.getByTestId('jev-key-test').click()
  await expect(panel.getByTestId('jev-test-result')).toContainText('Jev answered')
})

test('the switch limit defaults to 60 and reaches settings when changed', async ({ page }) => {
  await page.getByTestId('open-settings').click()
  const panel = page.getByTestId('settings-panel')

  const limit = panel.getByTestId('jev-switch-limit')
  await expect(limit).toHaveValue('60')
  await limit.fill('120')
  await limit.press('Enter')

  await expect
    .poll(() => page.evaluate(() => window.switchboard.invoke('settings.get', undefined)))
    .toMatchObject({ jevSwitchLimit: 120 })
})

test('a live session with a Jev route shows the Jev chip, marked when it switched', async ({ page }) => {
  await page.getByTestId('sidebar-project-alpha').click()
  const chip = page.getByTestId('session-jev-chip')
  await expect(chip).toHaveCount(0)

  await page.evaluate(() =>
    window.__mock.setJevRoute('s-alpha', {
      model: 'claude-sonnet-5',
      switched: true,
      note: 'Jev chose Sonnet 5 (86%).',
    }),
  )
  await expect(chip).toContainText('Jev')
  await expect(chip).toContainText('Sonnet 5')
  await expect(chip).toHaveClass(/switched/)
  await expect(chip).toHaveAttribute('title', 'Jev chose Sonnet 5 (86%).')

  await page.evaluate(() =>
    window.__mock.setJevRoute('s-alpha', {
      model: 'claude-opus-5[1m]',
      switched: false,
      note: 'Jev chose Sonnet 5 (52%), too unsure to leave Opus 5 (1M).',
    }),
  )
  await expect(chip).not.toHaveClass(/switched/)

  await page.evaluate(() => window.__mock.setJevRoute('s-alpha', null))
  await expect(chip).toHaveCount(0)
})

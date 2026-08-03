// The rules editor: PRODUCT.md Principle 3 says risk classification and output
// swallowing "ship as editable defaults, never as fixed policy". Until this screen
// existed only standing permissions were editable, so the claim was two-thirds
// unmet. These specs are what holds the claim up.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-rules').click()
})

test('lists the shipped rules with the level each one assigns', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('risk-rules')).toBeVisible()
  await expect(panel.getByTestId('noise-rules')).toBeVisible()

  // A shipped rule shows as on, at its shipped level.
  await expect(panel.getByTestId('risk-toggle-builtin:tool-read')).toHaveClass(/on/)
  await expect(panel.getByTestId('risk-level-builtin:tool-read-low')).toHaveClass(/on/)
})

test('a shipped risk rule can be switched off and back on', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  const toggle = panel.getByTestId('risk-toggle-builtin:tool-read')

  await toggle.click()
  await expect(toggle).not.toHaveClass(/on/)
  // Off means the level no longer applies, so it cannot be edited either.
  await expect(panel.getByTestId('risk-level-builtin:tool-read-low')).toBeDisabled()

  await toggle.click()
  await expect(toggle).toHaveClass(/on/)
})

test("changing a shipped rule's risk level marks it as changed, and Reset undoes it", async ({
  page,
}) => {
  const panel = page.getByTestId('settings-panel')
  const row = panel.getByTestId('risk-rules').locator('.card-opt', { hasText: 'Read a file' })

  await panel.getByTestId('risk-level-builtin:tool-read-high').click()
  await expect(panel.getByTestId('risk-level-builtin:tool-read-high')).toHaveClass(/on/)
  // The developer can see they have departed from the shipped default.
  await expect(row).toContainText('changed')

  await panel.getByTestId('risk-remove-builtin:tool-read').click()
  await expect(row).not.toContainText('changed')
})

test('a shipped rule offers Reset, never Delete, so it cannot be lost', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  await expect(panel.getByTestId('risk-remove-builtin:tool-read')).toHaveText('Reset')
  await expect(panel.getByTestId('noise-remove-builtin:progress')).toHaveText('Reset')
})

test('a developer can add their own risk rule and delete it again', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  const list = panel.getByTestId('risk-rules')
  const before = await list.locator('.card-opt').count()

  await panel.getByTestId('risk-add-tool').fill('Bash')
  await panel.getByTestId('risk-add-pattern').fill('^docker compose')
  await panel.getByTestId('risk-add-level-low').click()
  await panel.getByTestId('risk-add-btn').click()

  const row = list.locator('.card-opt', { hasText: '^docker compose' })
  await expect(row).toBeVisible()
  // Marked as the developer's own, and it sits above the shipped rules because
  // classification is first-match-wins and their rule has to be able to win.
  await expect(row).toContainText('yours')
  await expect(list.locator('.card-opt').first()).toContainText('^docker compose')
  expect(await list.locator('.card-opt').count()).toBe(before + 1)

  // Their own rule deletes rather than resets.
  await expect(row.getByText('Delete')).toBeVisible()
  await row.getByText('Delete').click()
  await expect(list.locator('.card-opt', { hasText: '^docker compose' })).toHaveCount(0)
})

test('adding a risk rule without a tool is refused and says why', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('risk-add-pattern').fill('something')
  await panel.getByTestId('risk-add-btn').click()

  await expect(panel.getByTestId('rules-error')).toContainText('Name a tool')
  // The typed pattern survives the refusal, so nothing has to be retyped.
  await expect(panel.getByTestId('risk-add-pattern')).toHaveValue('something')
})

test('a noise rule can be switched off, so the clean view stops hiding that output', async ({
  page,
}) => {
  const panel = page.getByTestId('settings-panel')
  const toggle = panel.getByTestId('noise-toggle-builtin:build-output')

  await expect(toggle).toHaveClass(/on/)
  await toggle.click()
  await expect(toggle).not.toHaveClass(/on/)
})

test('a developer can add their own noise rule', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')

  await panel.getByTestId('noise-add-pattern').fill('DEPRECATION WARNING')
  await panel.getByTestId('noise-add-label').fill('deprecations')
  await panel.getByTestId('noise-add-btn').click()

  const row = panel.getByTestId('noise-rules').locator('.card-opt', { hasText: 'deprecations' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('yours')
})

test('adding a noise rule with no label is refused', async ({ page }) => {
  const panel = page.getByTestId('settings-panel')
  await panel.getByTestId('noise-add-pattern').fill('something')
  await panel.getByTestId('noise-add-btn').click()

  await expect(panel.getByTestId('rules-error')).toContainText('Name what this hides')
})

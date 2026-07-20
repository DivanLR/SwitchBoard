// Terminal-style composer suggestions: inline ghost text, dropdown of matching
// past commands, Tab/arrow acceptance, and up-arrow recall.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()

  // Seed command history by sending a few commands.
  for (const cmd of ['git status', 'git commit -m wip', 'npm run build']) {
    await page.getByTestId('composer-input').fill(cmd)
    await page.getByTestId('composer-send').click()
    await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  }
})

test('the composer is focused on session open — typing works without a click', async ({ page }) => {
  // The beforeEach clicked around; switch projects to re-trigger the focus watch.
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  // Keystrokes land in the composer with no prior click.
  await page.keyboard.type('/hel')
  await expect(page.getByTestId('composer-input')).toHaveValue('/hel')
})

test('inline ghost text completes from history and Tab accepts it', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('git c')
  // Ghost shows the remainder of the most recent matching command.
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('ommit -m wip')
  await input.press('Tab')
  await expect(input).toHaveValue('git commit -m wip')
})

test('a dropdown lists matching past commands and click accepts one', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('git')
  const list = page.getByTestId('suggest-list')
  await expect(list).toBeVisible()
  // Both git commands match; newest first.
  await expect(page.getByTestId('suggest-item-0')).toContainText('git commit -m wip')
  await expect(page.getByTestId('suggest-item-1')).toContainText('git status')
  await page.getByTestId('suggest-item-1').click()
  await expect(input).toHaveValue('git status')
})

test('arrow keys navigate the dropdown and Enter accepts the highlighted row', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('git')
  await input.press('ArrowDown') // highlight row 0
  await input.press('ArrowDown') // highlight row 1
  await input.press('Enter') // accept highlighted, does not send
  await expect(input).toHaveValue('git status')
  // Nothing was sent by that Enter.
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.filter((s) => s.text === 'git status')).toHaveLength(1)
})

test('up-arrow on an empty composer recalls the most recent command', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('npm run build')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('git commit -m wip')
})

test('Escape dismisses the suggestions', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('git')
  await expect(page.getByTestId('suggest-list')).toBeVisible()
  await input.press('Escape')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('')
})

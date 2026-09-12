import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()

  for (const cmd of ['git status', 'git commit -m wip', 'npm run build']) {
    await page.getByTestId('composer-input').fill(cmd)
    await page.getByTestId('composer-send').click()
    await page.evaluate(() => window.__mock.completeTurn('s-alpha'))
  }
})

test('the composer is focused on session open — typing works without a click', async ({ page }) => {
  await page.getByTestId('sidebar-project-beta').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type('/hel')
  await expect(page.getByTestId('composer-input')).toHaveValue('/hel')
})

test('past prompts are never auto-suggested — commands only', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.fill('git c')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('')
})

test('inline ghost text completes a slash command and Tab accepts it', async ({ page }) => {
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['speckit-plan']))
  const input = page.getByTestId('composer-input')
  await input.fill('/speckit-p')
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('lan')
  await input.press('Tab')
  await expect(input).toHaveValue('/speckit-plan')
})

test('the dropdown lists matching commands and click accepts one', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['speckit-plan', 'speckit-tasks']),
  )
  const input = page.getByTestId('composer-input')
  await input.fill('/speckit-')
  const list = page.getByTestId('suggest-list')
  await expect(list).toBeVisible()
  await expect(list).toContainText('/speckit-plan')
  await expect(list).toContainText('/speckit-tasks')
  await page.getByTestId('suggest-item-1').click()
  await expect(input).toHaveValue('/speckit-tasks')
})

test('arrow keys navigate the dropdown and Enter accepts the highlighted row', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['speckit-plan', 'speckit-tasks']),
  )
  const input = page.getByTestId('composer-input')
  await input.fill('/speckit-')
  await input.press('ArrowDown') 
  await input.press('ArrowDown') 
  await input.press('Enter') 
  await expect(input).toHaveValue('/speckit-tasks')
  const sends = await page.evaluate(() => window.__mock.state().sends)
  expect(sends.filter((s) => s.text === '/speckit-tasks')).toHaveLength(0)
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
  await page.evaluate(() => window.__mock.setCommands('p-alpha', ['speckit-plan']))
  const input = page.getByTestId('composer-input')
  await input.fill('/speckit')
  await expect(page.getByTestId('suggest-list')).toBeVisible()
  await input.press('Escape')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('')
})

test('commands only suggest for a slash token, never for plain prose', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', [
      { name: 'claude-api', description: 'API reference' },
      { name: 'cleanup', description: 'Tidy the repo' },
    ]),
  )
  const input = page.getByTestId('composer-input')

  await input.fill('c')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)

  await input.fill('/c')
  await expect(page.getByTestId('suggest-list')).toContainText('/claude-api')

  await input.fill('please run /clean')
  await expect(page.getByTestId('suggest-list')).toContainText('/cleanup')
  await page.getByTestId('suggest-item-0').click()
  await expect(input).toHaveValue('please run /cleanup ')

  await input.fill('src/main')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)
})

test('completing a command does not leave a ghost tail behind it', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['ponytail', 'ponytail-audit', 'ponytail-review']),
  )
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('/ponyt')
  await expect(page.getByTestId('ghost-suggestion')).not.toHaveText('')

  await input.press('Tab')
  await expect(input).toHaveValue('/ponytail')
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('')
})

test('Tab with nothing to complete leaves the composer alone and keeps focus', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('just some prose, no command here')
  await page.keyboard.press('Tab')

  await expect(input).toHaveValue('just some prose, no command here')
  await expect(input).toBeFocused()
})

test('Shift+Tab still moves focus out, so the composer is not a keyboard trap', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('prose')
  await page.keyboard.press('Shift+Tab')

  await expect(input).not.toBeFocused()
})

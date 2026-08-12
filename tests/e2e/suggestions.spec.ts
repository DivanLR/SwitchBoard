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

test('past prompts are never auto-suggested — commands only', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  // Typing prose that matches history shows no dropdown and no ghost text.
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
  await input.press('ArrowDown') // highlight row 0
  await input.press('ArrowDown') // highlight row 1
  await input.press('Enter') // accept highlighted, does not send
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

  // Plain prose starting with "c": no command suggestions (history does not
  // prefix-match "c" either, so the dropdown stays closed).
  await input.fill('c')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)

  // A leading slash opens the command palette.
  await input.fill('/c')
  await expect(page.getByTestId('suggest-list')).toContainText('/claude-api')

  // A mid-sentence slash after a space also suggests, and accepting replaces
  // only that token.
  await input.fill('please run /clean')
  await expect(page.getByTestId('suggest-list')).toContainText('/cleanup')
  await page.getByTestId('suggest-item-0').click()
  await expect(input).toHaveValue('please run /cleanup ')

  // A slash with no space before it (mid-word) does not suggest.
  await input.fill('src/main')
  await expect(page.getByTestId('suggest-list')).toHaveCount(0)
})

// A command that is a literal prefix of its siblings (/ponytail has five) used to
// re-ghost the instant it was completed, painting a dim grey tail with no further
// typing. It reads as blank space because .composer-input.is-command makes the
// real text transparent, leaving the low-contrast mirror as the only thing drawn.
test('completing a command does not leave a ghost tail behind it', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setCommands('p-alpha', ['ponytail', 'ponytail-audit', 'ponytail-review']),
  )
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('/ponyt')
  // The ghost offers the completion, which is the feature working.
  await expect(page.getByTestId('ghost-suggestion')).not.toHaveText('')

  // Accept it. Nothing should be suggested afterwards, even though two siblings
  // still start with exactly this text.
  await input.press('Tab')
  await expect(input).toHaveValue('/ponytail')
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('')
})

// Tab in a composer means "finish what I am typing". Its NATIVE action is to
// move focus to the next control, so a Tab with nothing to complete used to
// take the developer out of the field mid-thought with no visible cause — the
// preventDefault only ran on the branches that actually accepted something.
test('Tab with nothing to complete leaves the composer alone and keeps focus', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('just some prose, no command here')
  await page.keyboard.press('Tab')

  await expect(input).toHaveValue('just some prose, no command here')
  await expect(input).toBeFocused()
})

// Shift+Tab is the way back out. Trapping it would strand keyboard focus in a
// text box with no way to reach the controls above it.
test('Shift+Tab still moves focus out, so the composer is not a keyboard trap', async ({ page }) => {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill('prose')
  await page.keyboard.press('Shift+Tab')

  await expect(input).not.toBeFocused()
})

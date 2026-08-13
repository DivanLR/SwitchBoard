// A draft left by a previous run, and the note that claims the composer holds
// one. It used to be a one-way flag cleared only on a project switch, so
// clearing the box and typing something of your own kept the note up, now
// describing text the app had never seen.
//
// Its own file because it needs its own board. A test cannot undo the scenario a
// file-level beforeEach already installed: Playwright has no way to remove an
// init script, so a second install leaves BOTH registered and both run on the
// next navigation, and which one the renderer reads first is a race that only
// shows itself under parallel load. The sibling case in plan-mode did exactly
// that once. One scenario per file removes the race rather than making it rarer.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test('the note describes the restored text, and only that text', async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.projects[0].drafts = ['half-written thought']
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await page.getByTestId('sidebar-project-alpha').click()

  await expect(page.getByTestId('composer-input')).toHaveValue('half-written thought')
  await expect(page.getByTestId('draft-note')).toBeVisible()

  // Typing your own text ends the claim.
  await page.getByTestId('composer-input').fill('something I am writing myself')
  await expect(page.getByTestId('draft-note')).toHaveCount(0)

  // And an empty box has no restored draft to talk about either.
  await page.getByTestId('composer-input').fill('')
  await expect(page.getByTestId('draft-note')).toHaveCount(0)
})

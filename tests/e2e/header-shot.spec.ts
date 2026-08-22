// A look at the project header's three new controls, for the human pass.
// Not a test: it drives the mock host and writes a PNG. Skipped unless SHOTS=1,
// the same gate shots.spec.ts uses, so `npm run check` never pays for it.
//
// Run: SHOTS=1 npx playwright test tests/e2e/header-shot.spec.ts
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.skip(!process.env.SHOTS, 'screenshot pass; set SHOTS=1 to capture')

test('the project header, with the container switch, + Session, and a named session', async ({
  page,
}) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  // Untouched first: this is what a developer meets on opening a project.
  await page.locator('header.head').screenshot({ path: '.impeccable/shots/header-default.png' })

  // Then all three exercised at once, which is the state worth looking at: a
  // second session running, the first one named, containers on.
  await page.getByTestId('project-containers-input').check()
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()

  await page.getByTestId('sidebar-subsession-s-alpha').click()
  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('release smoke')
  await page.getByTestId('session-name-input').press('Enter')
  await expect(page.getByTestId('session-name')).toHaveText('release smoke')

  await page.locator('header.head').screenshot({ path: '.impeccable/shots/header-active.png' })
  // The sidebar reads the same name, which is the half of the feature the header
  // cannot show on its own.
  await page.locator('aside.sidebar').screenshot({ path: '.impeccable/shots/sidebar-named.png' })
})

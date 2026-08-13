// A bypass session is offered no plan control at all.
//
// Its own file, and that is the point rather than an accident of tidying. This
// test needs a DIFFERENT board from the rest of plan-mode.spec.ts, and a test
// cannot undo the scenario a file-level beforeEach already installed: Playwright
// has no way to remove an init script, so a second install leaves BOTH
// registered and both run on the next navigation. Which one the renderer reads
// first is then a race, and it lost exactly once in a six-worker run and passed
// every time it was run alone — the worst shape a failure can have, because it
// looks like the app being flaky rather than the test being wrong.
//
// One scenario per file removes the race instead of making it rarer.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario, type MockScenario } from './mock-host'

test('a bypass session is offered no plan control at all', async ({ page }) => {
  const bypassScenario: MockScenario = {
    ...twoProjectScenario(),
    projects: [
      {
        id: 'p-alpha',
        name: 'alpha',
        path: 'C:\\work\\alpha',
        session: { id: 's-alpha', status: 'working', branch: 'main', bypassPermissions: true },
      },
    ],
  }
  await page.addInitScript(installMockHost, bypassScenario)
  await page.goto('/')
  await expect(page.getByTestId('bypass-pill')).toBeVisible()
  // A bypass session approves everything before the gate a plan needs is ever
  // reached, so the control is absent rather than present and inert.
  await expect(page.getByTestId('plan-mode-toggle')).toHaveCount(0)
})

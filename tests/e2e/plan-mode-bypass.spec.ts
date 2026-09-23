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
  await expect(page.getByTestId('plan-mode-toggle')).toHaveCount(0)
})

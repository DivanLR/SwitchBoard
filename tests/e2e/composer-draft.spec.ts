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

  await page.getByTestId('composer-input').fill('something I am writing myself')
  await expect(page.getByTestId('draft-note')).toHaveCount(0)

  await page.getByTestId('composer-input').fill('')
  await expect(page.getByTestId('draft-note')).toHaveCount(0)
})

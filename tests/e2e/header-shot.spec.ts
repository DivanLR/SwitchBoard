import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.skip(!process.env.SHOTS, 'screenshot pass; set SHOTS=1 to capture')

test('the project header, with + Session, and a named session', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()

  await page.locator('header.head').screenshot({ path: '.impeccable/shots/header-default.png' })

  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()

  await page.getByTestId('sidebar-subsession-s-alpha').click()
  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('release smoke')
  await page.getByTestId('session-name-input').press('Enter')
  await expect(page.getByTestId('session-name')).toHaveText('release smoke')

  await page.locator('header.head').screenshot({ path: '.impeccable/shots/header-active.png' })
  await page.locator('aside.sidebar').screenshot({ path: '.impeccable/shots/sidebar-named.png' })
})

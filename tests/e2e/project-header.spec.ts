import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
})

test('the header starts another session in the same project', async ({ page }) => {
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toHaveCount(0)

  await page.getByTestId('new-session').click()

  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()
  await expect(page.getByTestId(/^sidebar-subsession-s/)).toHaveCount(2)
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toBeVisible()
})

test('a session takes the name you type, in the header and in the sidebar', async ({ page }) => {
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('sidebar-subsessions-alpha')).toBeVisible()

  await page.getByTestId('sidebar-subsession-s-alpha').click()
  const button = page.getByTestId('session-name')
  await expect(button).toHaveText('Name this session')

  await button.click()
  const input = page.getByTestId('session-name-input')
  await input.fill('release smoke')
  await input.press('Enter')

  await expect(page.getByTestId('session-name')).toHaveText('release smoke')
  await expect(page.getByTestId('sidebar-subsession-s-alpha')).toContainText('release smoke')
})

test('clearing a name gives the derived one back rather than leaving it blank', async ({ page }) => {
  await page.getByTestId('session-name').click()
  const input = page.getByTestId('session-name-input')
  await input.fill('temporary')
  await input.press('Enter')
  await expect(page.getByTestId('session-name')).toHaveText('temporary')

  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('')
  await page.getByTestId('session-name-input').press('Enter')
  await expect(page.getByTestId('session-name')).toHaveText('Name this session')
})

test('escape abandons an edit instead of saving it', async ({ page }) => {
  await page.getByTestId('session-name').click()
  await page.getByTestId('session-name-input').fill('never sent')
  await page.getByTestId('session-name-input').press('Escape')

  await expect(page.getByTestId('session-name-input')).toHaveCount(0)
  await expect(page.getByTestId('session-name')).toHaveText('Name this session')
})

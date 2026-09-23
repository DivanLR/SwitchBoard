import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

async function sends(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__mock.state().sends)
}

test('a verify run and a diagram never share a session, nor take the chat one', async ({
  page,
}) => {
  await page.getByTestId('composer-input').fill('what does this project do?')
  await page.getByTestId('composer-send').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(0)
  const chat = (await sends(page)).at(-1)?.sessionId
  expect(chat).toBe('s-alpha')

  await page.getByTestId('tab-tests').click()
  await page.getByTestId('tests-stack-dotnet').click()
  await page.getByTestId('tests-run').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(1)
  const verify = (await sends(page)).at(-1)?.sessionId

  await page.getByTestId('tab-diagrams').click()
  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(2)
  const diagram = (await sends(page)).at(-1)?.sessionId

  expect(verify).toBeTruthy()
  expect(diagram).toBeTruthy()
  expect(new Set([chat, verify, diagram]).size).toBe(3)
})

test('a second diagram takes a session of its own, unlike a second test run', async ({ page }) => {
  await page.getByTestId('tab-diagrams').click()

  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect.poll(async () => (await sends(page)).length).toBe(1)
  const first = (await sends(page)).at(-1)?.sessionId

  await page.getByTestId('diagram-input').fill('Payment flow')
  await page.getByTestId('diagram-generate').click()
  await expect.poll(async () => (await sends(page)).length).toBe(2)
  const second = (await sends(page)).at(-1)?.sessionId

  expect(first).toBeTruthy()
  expect(second).not.toBe(first)
})

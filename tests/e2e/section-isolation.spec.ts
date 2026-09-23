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

test('two Spec Kit commands take two sessions, and neither is the chat', async ({ page }) => {
  await page.getByTestId('composer-input').fill('what does this project do?')
  await page.getByTestId('composer-send').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(0)
  const chat = (await sends(page)).at(-1)?.sessionId

  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0 }],
      details: {
        '001-x': {
          id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0,
          description: 'desc', path: 'specs/001-x', sections: [], phases: [], clarifications: [], tasks: [],
        },
      },
    }),
  )
  await page.getByTestId('tab-specs').click()

  await page.getByTestId('part-cmds').click()
  await page.getByTestId('speckit-cmd-speckit-plan').click()
  await expect
    .poll(async () => (await sends(page)).some((s) => s.text.startsWith('/speckit-plan')))
    .toBe(true)
  const plan = (await sends(page)).find((s) => s.text.startsWith('/speckit-plan'))?.sessionId

  await page.getByTestId('part-spec').click()
  await page.getByTestId('spec-new').click()
  await page.getByTestId('new-spec-input').fill('A per-domain container')
  await page.getByTestId('new-spec-submit').click()
  await expect
    .poll(async () => (await sends(page)).some((s) => s.text.startsWith('/speckit-specify')))
    .toBe(true)
  const specify = (await sends(page)).find((s) => s.text.startsWith('/speckit-specify'))?.sessionId

  expect(plan).toBeTruthy()
  expect(specify).toBeTruthy()
  expect(new Set([chat, plan, specify]).size).toBe(3)
})

test('a command that is running says so on the control that started it', async ({ page }) => {
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', {
      installed: true,
      specs: [{ id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0 }],
      details: {
        '001-x': {
          id: '001-x', title: 'X', status: 'draft', tasksTotal: 0, tasksDone: 0,
          description: 'desc', path: 'specs/001-x', sections: [], phases: [], clarifications: [], tasks: [],
        },
      },
    }),
  )
  await page.getByTestId('tab-specs').click()
  await page.getByTestId('part-cmds').click()

  const plan = page.getByTestId('speckit-cmd-speckit-plan')
  const tasks = page.getByTestId('speckit-cmd-speckit-tasks')
  await page.evaluate(() => window.__mock.setStartDelay(3000))
  await plan.click()

  await expect(plan).toContainText('Starting')
  await expect(plan).toBeDisabled()
  await expect(tasks).toContainText('Run')

  await expect(plan).toContainText('Running', { timeout: 10_000 })
  await expect(plan).toBeDisabled()
  await expect(tasks).toContainText('Run')
  await expect(tasks).toBeEnabled()
})

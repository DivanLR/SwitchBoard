// One session per section, end to end.
//
// The unit suite covers the resolver (backgroundSessionFor keyed by kind); this
// covers the thing the developer actually asked for: dispatching from two
// different sections, and from the composer, puts the work in three different
// sessions rather than queueing it behind whichever one was already open.
//
// It is written against `sends[].sessionId` rather than against the sidebar,
// because where the work RUNS is the guarantee. A section showing its own
// terminal while sharing a session with another section would look identical and
// still queue.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
})

/** Every send so far, so a test can ask which session a dispatch landed in. */
async function sends(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__mock.state().sends)
}

test('a cleanup command and a diagram never share a session, nor take the chat one', async ({
  page,
}) => {
  // The conversation first, so there IS an open chat session for a section to
  // wrongly fall into. This is the session every section used to land in.
  await page.getByTestId('composer-input').fill('what does this project do?')
  await page.getByTestId('composer-send').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(0)
  const chat = (await sends(page)).at(-1)?.sessionId
  expect(chat).toBe('s-alpha')

  await page.getByTestId('tab-cleanup').click()
  await page.getByTestId('cleanup-cmd-de-sloppify').click()
  await expect.poll(async () => (await sends(page)).some((s) => s.text === '/de-sloppify')).toBe(true)
  const cleanup = (await sends(page)).find((s) => s.text === '/de-sloppify')?.sessionId

  await page.getByTestId('tab-diagrams').click()
  await page.getByTestId('diagram-input').fill('Auth flow for login')
  await page.getByTestId('diagram-generate').click()
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(2)
  const diagram = (await sends(page)).at(-1)?.sessionId

  // Three dispatches, three sessions. The cleanup pass does not queue behind the
  // developer's question, and the drawing does not queue behind the cleanup pass.
  expect(cleanup).toBeTruthy()
  expect(diagram).toBeTruthy()
  expect(new Set([chat, cleanup, diagram]).size).toBe(3)
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

  // Drawings never reuse, even within their own kind: two diagrams sharing one
  // session means the second waits for the first, which is the same blocking the
  // per-kind split exists to remove, moved one place along.
  expect(first).toBeTruthy()
  expect(second).not.toBe(first)
})

test('two Spec Kit commands take two sessions, and neither is the chat', async ({ page }) => {
  // Spec Kit's commands are the longest work in the app: /speckit-specify writes
  // a spec folder over minutes and /speckit-implement can run for an hour. When
  // they shared the project's one `spec` session, a command sent while another
  // was still running simply waited, with nothing on screen saying so.
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

  // Two different controls, because that is the case that used to queue: a plan
  // sent while a specify was still writing.
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
  // Hold the start open: this is the window a real containerised project spends
  // bringing an image up, and it is the half of the feedback that was missing.
  await page.evaluate(() => window.__mock.setStartDelay(3000))
  await plan.click()

  // First the wait, on the control that was clicked and nowhere else.
  await expect(plan).toContainText('Starting')
  await expect(plan).toBeDisabled()
  await expect(tasks).toContainText('Run')

  // Then the run itself, once the session exists.
  await expect(plan).toContainText('Running', { timeout: 10_000 })
  await expect(plan).toBeDisabled()
  await expect(tasks).toContainText('Run')
  await expect(tasks).toBeEnabled()
})

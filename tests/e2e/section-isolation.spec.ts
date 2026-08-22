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

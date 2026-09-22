import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

interface LegacyFlowMock {
  reportFlowScope: (...args: unknown[]) => unknown
  reportFlowSignoff: (...args: unknown[]) => unknown
  reportFlowPublished: (...args: unknown[]) => unknown
  reportFlowItem: (...args: unknown[]) => unknown
  reportFlowLessons: (...args: unknown[]) => unknown
  setFlowDirty: (...args: unknown[]) => unknown
}

interface LegacyFlowState {
  flowPublishes: { runId: string; count: number }[]
  flowWorkStarts: string[]
  flowRetries: string[]
  flowLessonDecisions: { lessonId: string; accept: boolean }[]
}

const FEATURES = [
  { id: '4711', title: 'Checkout v2' },
  { id: '4712', title: 'Loyalty points' },
]

const ITEMS = [
  {
    localId: 'cart-race',
    title: 'Version the cart state',
    body: 'Reconcile optimistic updates by version.',
    acceptance: ['Two fast adds keep both items'],
  },
  { localId: 'cart-tests', title: 'Cover the two-add race', body: 'One regression test.' },
]

async function openFlow(page: Page): Promise<void> {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await expect(page.getByTestId('flow-view')).toBeVisible()
}

async function scopedRun(page: Page): Promise<void> {
  await openFlow(page)
  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await page.getByTestId('flow-feature-4711').click()
  await expect(page.getByTestId('flow-scoping')).toBeVisible()
  await page.evaluate((items) => (window.__mock as unknown as LegacyFlowMock).reportFlowScope('p-alpha', items), ITEMS)
  await expect(page.getByTestId('flow-run-status')).toHaveText('crosscheck')
  await page.evaluate(() => (window.__mock as unknown as LegacyFlowMock).reportFlowSignoff('p-alpha', 'approve', []))
  await expect(page.getByTestId('flow-items')).toBeVisible()
}

test.describe.skip('F2 rewrites this against the new stage-based Flow backend and UI', () => {

test('a feature is picked from DevOps and scoped in plan mode', async ({ page }) => {
  await openFlow(page)
  await expect(page.getByTestId('flow-features-empty')).toBeVisible()

  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await expect(page.getByTestId('flow-feature-4712')).toContainText('Loyalty points')

  await page.getByTestId('flow-feature-4711').click()

  await expect(page.getByTestId('flow-run-status')).toHaveText('scoping')
  await expect(page.getByTestId('flow-scoping')).toBeVisible()
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().sends)).at(-1)?.text)
    .toContain('4711')
})

test('the tab says so when the DevOps server is not connected, and starts nothing', async ({
  page,
}) => {
  await openFlow(page)
  await page.evaluate(() => window.__mock.setAdoConnected(false))

  await page.getByTestId('flow-feature-refresh').click()

  await expect(page.getByTestId('flow-error')).toContainText('Azure DevOps MCP server is not connected')
  await expect(page.getByTestId('flow-run')).toHaveCount(0)
})

test('the breakdown is shown for approval, and nothing reaches DevOps until it is armed', async ({
  page,
}) => {
  await scopedRun(page)

  await expect(page.getByTestId('flow-item-cart-race')).toContainText('Version the cart state')
  await expect(page.getByTestId('flow-item-cart-race-nowid')).toContainText('not in DevOps yet')
  await expect(page.getByTestId('flow-publish')).toContainText('Write these to DevOps')
  expect(await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowPublishes)).toEqual([])

  await page.getByTestId('flow-publish').click()
  await expect(page.getByTestId('flow-publish')).toContainText('Create 2 in DevOps')
  expect(await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowPublishes)).toEqual([])

  await page.getByTestId('flow-publish').click()
  await expect
    .poll(async () => (await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowPublishes)).at(-1))
    .toEqual({ runId: 'flow-1', count: 2 })
})

test('an item dropped from the breakdown is not published', async ({ page }) => {
  await scopedRun(page)

  await page.getByTestId('flow-item-cart-tests-drop').click()
  await expect(page.getByTestId('flow-item-cart-tests')).toHaveCount(0)

  await page.getByTestId('flow-publish').click()
  await page.getByTestId('flow-publish').click()

  await expect
    .poll(async () => (await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowPublishes)).at(-1)?.count)
    .toBe(1)
})

test('created work items show their id, and a failed one says why', async ({ page }) => {
  await scopedRun(page)
  await page.getByTestId('flow-publish').click()
  await page.getByTestId('flow-publish').click()

  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowPublished(
      'p-alpha',
      [{ localId: 'cart-race', workItemId: '5001' }],
      [{ localId: 'cart-tests', why: 'the area path was rejected' }],
    ),
  )

  await expect(page.getByTestId('flow-item-cart-race-wid')).toHaveText('#5001')
  await expect(page.getByTestId('flow-item-cart-tests')).toContainText('the area path was rejected')
  await expect(page.getByTestId('flow-run-note')).toContainText('could not be created')
})

async function publishedRun(page: Page): Promise<void> {
  await scopedRun(page)
  await page.getByTestId('flow-publish').click()
  await page.getByTestId('flow-publish').click()
  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowPublished('p-alpha', [
      { localId: 'cart-race', workItemId: '5001' },
      { localId: 'cart-tests', workItemId: '5002' },
    ]),
  )
  await expect(page.getByTestId('flow-item-cart-race-wid')).toHaveText('#5001')
}

test('work is refused while the main checkout is dirty, and says how many changes', async ({
  page,
}) => {
  await publishedRun(page)
  await page.evaluate(() => (window.__mock as unknown as LegacyFlowMock).setFlowDirty([' M src/app.ts']))

  await page.getByTestId('flow-start-work').click()

  await expect(page.getByTestId('flow-error')).toContainText('1 uncommitted change')
  expect(await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowWorkStarts)).toEqual([])
})

test('starting work puts every item in its own worktree and shows what is running', async ({
  page,
}) => {
  await publishedRun(page)

  await page.getByTestId('flow-start-work').click()

  await expect(page.getByTestId('flow-item-cart-race-status')).toHaveText('implementing')
  await expect(page.getByTestId('flow-work-counts')).toContainText('2 running')
  await expect
    .poll(async () => (await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowWorkStarts)).length)
    .toBe(1)
})

test('a raised pull request is shown, and a blocked item can be retried', async ({ page }) => {
  await publishedRun(page)
  await page.getByTestId('flow-start-work').click()

  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowItem('p-alpha', 'cart-race', 'pr_open', { prId: '312' }),
  )
  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowItem('p-alpha', 'cart-tests', 'blocked', {
      note: 'the API it needs does not exist yet',
    }),
  )

  await expect(page.getByTestId('flow-item-cart-race-pr')).toContainText('PR #312')
  await expect(page.getByTestId('flow-item-cart-tests')).toContainText('does not exist yet')
  await expect(page.getByTestId('flow-work-counts')).toContainText('1 with a PR')
  await expect(page.getByTestId('flow-work-counts')).toContainText('1 stuck')

  await page.getByTestId('flow-item-cart-tests-retry').click()
  await expect
    .poll(async () => (await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowRetries)).length)
    .toBe(1)
})

test('the breakdown goes to a second session before it reaches you', async ({ page }) => {
  await openFlow(page)
  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await page.getByTestId('flow-feature-4711').click()
  await page.evaluate((items) => (window.__mock as unknown as LegacyFlowMock).reportFlowScope('p-alpha', items), ITEMS)

  await expect(page.getByTestId('flow-run-status')).toHaveText('crosscheck')
  await expect(page.getByTestId('flow-scoping')).toContainText('did not write it')
  await expect(page.getByTestId('flow-publish')).toHaveCount(0)

  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowSignoff('p-alpha', 'approve', ['the second item leans on a missing endpoint']),
  )

  await expect(page.getByTestId('flow-run-status')).toHaveText('awaiting_approval')
  await expect(page.getByTestId('flow-concerns')).toContainText('missing endpoint')
  await expect(page.getByTestId('flow-run-note')).toContainText('approved it, with notes')
})

test('a revision goes back for rescoping rather than to you', async ({ page }) => {
  await openFlow(page)
  await page.evaluate((features) => window.__mock.setAdoFeatures(features), FEATURES)
  await page.getByTestId('flow-feature-refresh').click()
  await page.getByTestId('flow-feature-4711').click()
  await page.evaluate((items) => (window.__mock as unknown as LegacyFlowMock).reportFlowScope('p-alpha', items), ITEMS)

  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowSignoff('p-alpha', 'revise', ['item two is half of item one']),
  )

  await expect(page.getByTestId('flow-run-status')).toHaveText('scoping')
  await expect(page.getByTestId('flow-concerns')).toContainText('half of item one')
  await expect(page.getByTestId('flow-publish')).toHaveCount(0)
})

test('review comments become rules you accept or reject, one at a time', async ({ page }) => {
  await publishedRun(page)
  await page.getByTestId('flow-start-work').click()
  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowItem('p-alpha', 'cart-race', 'pr_open', { prId: '312' }),
  )

  await page.getByTestId('flow-learn').click()
  await page.evaluate(() =>
    (window.__mock as unknown as LegacyFlowMock).reportFlowLessons('p-alpha', [
      {
        rule: 'Name the work item in every commit message.',
        section: null,
        quote: 'which work item is this?',
      },
      { rule: 'Always use tabs.', section: null, quote: 'tabs please' },
    ]),
  )

  await expect(page.getByTestId('flow-lessons')).toContainText('Name the work item')
  await expect(page.getByTestId('flow-lessons')).toContainText('which work item is this?')

  await page.getByTestId('flow-lesson-lesson-1-accept').click()
  await expect(page.getByTestId('flow-lesson-written')).toContainText('Wrote 1 line')

  await page.getByTestId('flow-lesson-lesson-2-reject').click()
  await expect(page.getByTestId('flow-lessons')).toHaveCount(0)
  await expect
    .poll(async () => (await page.evaluate(() => (window.__mock.state() as unknown as LegacyFlowState).flowLessonDecisions)))
    .toEqual([
      { lessonId: 'lesson-1', accept: true },
      { lessonId: 'lesson-2', accept: false },
    ])
})

test('stopping a flow says who stopped it and frees the project for another', async ({ page }) => {
  await scopedRun(page)

  await page.getByTestId('flow-cancel').click()

  await expect(page.getByTestId('flow-run-status')).toHaveText('cancelled')
  await expect(page.getByTestId('flow-run-note')).toContainText('You stopped this flow')
})

test('Flow is a popup over the session, closed by Escape or its close button', async ({ page }) => {
  await openFlow(page)
  await expect(page.getByTestId('tab-flow')).toHaveCount(0)
  await expect(page.getByTestId('view-toggle')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('open-flow')).toBeFocused()
  await page.getByTestId('open-flow').click()
  await expect(page.getByTestId('flow-popup')).toBeVisible()
  await page.getByTestId('flow-popup-close').click()
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('open-flow')).toBeFocused()
})

test('a request raised while Flow is open is counted in the popup, and answering it closes Flow', async ({
  page,
}) => {
  await openFlow(page)
  await expect(page.getByTestId('flow-popup-inbox')).toHaveCount(0)
  await page.evaluate(() =>
    window.__mock.raisePermission({
      projectId: 'p-alpha',
      title: 'Run: npm test',
      explanation: 'A Flow session wants to run the tests.',
      risk: 'low',
    }),
  )
  await expect(page.getByTestId('flow-popup-inbox')).toHaveText(/1 waiting/)
  await page.evaluate(() =>
    window.__mock.raisePermission({
      projectId: 'p-beta',
      title: 'Run: git status',
      risk: 'low',
    }),
  )
  await expect(page.getByTestId('flow-popup-inbox')).toHaveText(/1 waiting/)
  await page.getByTestId('flow-popup-inbox').click()
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('inbox-badge')).toBeVisible()
})

test('Flow closes rather than following a selection change to another project', async ({ page }) => {
  await openFlow(page)
  await page.evaluate(() => window.__mock.focusSession('s-beta'))
  await expect(page.getByTestId('flow-popup')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-project-beta')).toHaveAttribute('aria-selected', 'true')
})

test('one spec is written for the whole feature through Spec Kit, from the approved items', async ({ page }) => {
  await scopedRun(page)
  await expect(page.getByTestId('flow-spec-foot')).toBeVisible()
  await page.getByTestId('flow-spec').click()
  await expect(page.getByTestId('flow-error')).toContainText('Install Spec Kit')
  await page.evaluate(() =>
    window.__mock.setSpecKit('p-alpha', { installed: true, specs: [] }),
  )
  await page.getByTestId('flow-spec').click()
  await expect(page.getByTestId('flow-spec-session')).toBeVisible()
  await expect(page.getByTestId('flow-spec')).toHaveText('Write it again')
  const sends = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(sends.some((text) => text.startsWith('/speckit-specify Feature 4711: Checkout v2'))).toBe(true)
  await page.getByTestId('flow-spec').click()
  await expect(page.getByTestId('flow-error')).toContainText('already being written')
  const after = await page.evaluate(() => window.__mock.state().sends.map((s) => s.text))
  expect(after.filter((text) => text.startsWith('/speckit-specify')).length).toBe(1)
})

})

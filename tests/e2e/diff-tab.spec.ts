// Diff tab (specs/003-diff-tab) — quickstart.md scenarios 1, 3, and 5: a
// populated list with per-file selection, the no-changes state, and the
// no-live-session state. gitNotice ("can't read this project") is exercised
// at the unit level (git-diff-files.spec.ts) since it depends on a real
// filesystem condition the in-browser mock has no equivalent for.
import { expect, test, type Page } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

async function openProject(page: Page, name: 'alpha' | 'beta'): Promise<void> {
  await expect(page.getByTestId(`sidebar-project-${name}`)).toBeVisible()
  await page.getByTestId(`sidebar-project-${name}`).click()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
}

test('lists changed files with line counts and shows a selected file\'s diff', async ({ page }) => {
  const scenario = twoProjectScenario()
  // Seeded at scenario construction, not via a post-goto __mock.setDiff call:
  // alpha is the project the app selects on load, so a call made after goto()
  // would race the app's own initial diff.list load for it.
  scenario.projects[0].diff = {
    gitNotice: null,
    files: [
      { path: 'src/app.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false },
      { path: 'new.txt', status: 'untracked', addedLines: 2, removedLines: 0, binary: false },
    ],
  }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await page.evaluate(() => {
    window.__mock.setFileDiff('p-alpha', 'src/app.ts', {
      binary: false,
      lines: [
        { type: 'context', text: 'const x = 1' },
        { type: 'del', text: 'old line' },
        { type: 'add', text: 'new line' },
      ],
    })
  })

  await openProject(page, 'alpha')

  // The badge on the tab itself reflects the count without needing the tab open.
  await expect(page.getByTestId('tab-diff')).toContainText('2')

  await expect(page.getByTestId('diff-file-src/app.ts')).toContainText('+3')
  await expect(page.getByTestId('diff-file-src/app.ts')).toContainText('−1')
  await expect(page.getByTestId('diff-file-new.txt')).toContainText('+2')

  await page.getByTestId('diff-file-src/app.ts').click()
  await expect(page.getByTestId('diff-pane-lines')).toContainText('old line')
  await expect(page.getByTestId('diff-pane-lines')).toContainText('new line')

  await page.getByTestId('diff-file-new.txt').click()
  await expect(page.getByTestId('diff-pane-empty')).not.toBeVisible()
})

test('states there are no changes rather than an empty or stuck list', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')

  await openProject(page, 'alpha')

  await expect(page.getByTestId('diff-no-changes')).toBeVisible()
  await expect(page.getByTestId('tab-diff')).not.toContainText(/[1-9]/)
})

test('states a live session is required rather than showing a stale list', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  // End beta's session BEFORE switching to it, so the project-switch load sees
  // NOT_LIVE from the start rather than racing an in-flight earlier request.
  await page.evaluate(() => window.__mock.endSession('s-beta'))

  await openProject(page, 'beta')

  await expect(page.getByTestId('diff-not-live')).toBeVisible()
})

test('starts reflecting a project once its session starts, without a project switch', async ({ page }) => {
  await page.addInitScript(installMockHost, twoProjectScenario())
  await page.goto('/')
  await page.evaluate(() => window.__mock.endSession('s-beta'))

  await openProject(page, 'beta')
  await expect(page.getByTestId('diff-not-live')).toBeVisible()

  // Start a new session for the SAME project while staying on it — no
  // sidebar click, no project.id change. Neither diffAdds nor diffDels
  // changes on session start (both begin null), so this only refreshes if
  // the tab also watches liveSession's id.
  await page.getByTestId('tab-session').click()
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('session-pill')).toBeVisible()

  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('diff-not-live')).not.toBeVisible()
  await expect(page.getByTestId('diff-no-changes')).toBeVisible()
})

// Commenting on a region: the same gesture as a pull-request comment, except the
// comment is carried out. The instruction goes to the containerised session,
// which has the working tree mounted, so the edit lands in this same diff.
async function openDiffWithLines(page: Page): Promise<void> {
  const scenario = twoProjectScenario()
  scenario.projects[0].diff = {
    gitNotice: null,
    files: [{ path: 'src/app.ts', status: 'modified', addedLines: 2, removedLines: 1, binary: false }],
  }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await page.evaluate(() => {
    window.__mock.setFileDiff('p-alpha', 'src/app.ts', {
      binary: false,
      lines: [
        { type: 'context', text: 'const x = 1' },
        { type: 'del', text: 'const timeout = 500' },
        { type: 'add', text: 'const timeout = 5000' },
        { type: 'context', text: 'return timeout' },
      ],
    })
  })
  await openProject(page, 'alpha')
  await page.getByTestId('diff-file-src/app.ts').click()
  await expect(page.getByTestId('diff-pane-lines')).toBeVisible()
}

test('a comment on one diff line is applied by the container session', async ({ page }) => {
  await openDiffWithLines(page)

  // Nothing is offered until a line is pointed at.
  await expect(page.getByTestId('diff-comment')).toHaveCount(0)

  await page.getByTestId('diff-line-2').click()
  await expect(page.getByTestId('diff-comment-count')).toContainText('1 line selected')

  await page.getByTestId('diff-comment-input').fill('make this configurable')
  await page.getByTestId('diff-comment-send').click()

  // The region travels as TEXT, markers intact, not as line numbers: numbers are
  // wrong the moment anything above them moves, and the first edit invalidates
  // the very diff the selection was made from.
  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().diffApplies)).at(-1))
    .toEqual({
      projectId: 'p-alpha',
      path: 'src/app.ts',
      lines: ['+const timeout = 5000'],
      instruction: 'make this configurable',
    })

  // Sent, so the composer closes and the selection is released.
  await expect(page.getByTestId('diff-comment')).toHaveCount(0)
})

test('shift-click extends the selection over several lines, in order', async ({ page }) => {
  await openDiffWithLines(page)

  await page.getByTestId('diff-line-1').click()
  await page.getByTestId('diff-line-3').click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('diff-comment-count')).toContainText('3 lines selected')

  await page.getByTestId('diff-comment-input').fill('extract these')
  await page.getByTestId('diff-comment-send').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().diffApplies)).at(-1)?.lines)
    .toEqual(['-const timeout = 500', '+const timeout = 5000', ' return timeout'])
})

// Selecting upwards is the same region. Anchoring on the first click and letting
// the second be either side of it is what makes that work.
test('extending upwards selects the same region as extending down', async ({ page }) => {
  await openDiffWithLines(page)

  await page.getByTestId('diff-line-3').click()
  await page.getByTestId('diff-line-1').click({ modifiers: ['Shift'] })

  await page.getByTestId('diff-comment-input').fill('x')
  await page.getByTestId('diff-comment-send').click()

  await expect
    .poll(async () => (await page.evaluate(() => window.__mock.state().diffApplies)).at(-1)?.lines)
    .toEqual(['-const timeout = 500', '+const timeout = 5000', ' return timeout'])
})

test('an empty instruction cannot be sent', async ({ page }) => {
  await openDiffWithLines(page)
  await page.getByTestId('diff-line-2').click()

  await expect(page.getByTestId('diff-comment-send')).toBeDisabled()
  await page.getByTestId('diff-comment-input').fill('   ')
  await expect(page.getByTestId('diff-comment-send')).toBeDisabled()
})

// Line indices belong to the file they were read from.
test('changing file drops a selection made in the previous one', async ({ page }) => {
  const scenario = twoProjectScenario()
  scenario.projects[0].diff = {
    gitNotice: null,
    files: [
      { path: 'src/app.ts', status: 'modified', addedLines: 2, removedLines: 1, binary: false },
      { path: 'other.ts', status: 'modified', addedLines: 1, removedLines: 0, binary: false },
    ],
  }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await page.evaluate(() => {
    window.__mock.setFileDiff('p-alpha', 'src/app.ts', {
      binary: false,
      lines: [{ type: 'add', text: 'one' }],
    })
    window.__mock.setFileDiff('p-alpha', 'other.ts', {
      binary: false,
      lines: [{ type: 'add', text: 'two' }],
    })
  })
  await openProject(page, 'alpha')

  await page.getByTestId('diff-file-src/app.ts').click()
  await page.getByTestId('diff-line-0').click()
  await expect(page.getByTestId('diff-comment')).toBeVisible()

  await page.getByTestId('diff-file-other.ts').click()
  await expect(page.getByTestId('diff-comment')).toHaveCount(0)
})

// The line has always been clickable and nothing on screen said so: the whole
// commenting feature rested on a title attribute nobody hovers long enough to
// read. A mark that appears under the pointer is what makes it discoverable.
test('a comment mark appears on the line under the pointer, and is out of the way otherwise', async ({
  page,
}) => {
  await openDiffWithLines(page)

  const mark = page.getByTestId('diff-line-1').locator('.dl-comment')
  const opacity = async () => mark.evaluate((el) => getComputedStyle(el).opacity)

  // Present on every line, so its space is reserved and revealing it cannot
  // shift the code sideways; invisible until the line is pointed at.
  await expect(mark).toHaveCount(1)
  expect(await opacity()).toBe('0')

  await page.getByTestId('diff-line-1').hover()
  await expect.poll(opacity).toBe('1')
})

// The composer sits IN the line list, attached to the last selected line. This is
// the property that keeps shift-click working: a box floating over the code would
// cover the lines below it, which are exactly the ones an extend targets.
test('the comment box is attached to the selection and never covers a line', async ({ page }) => {
  await openDiffWithLines(page)

  await page.getByTestId('diff-line-1').click()
  const box = page.getByTestId('diff-comment')
  await expect(box).toBeVisible()

  // In flow: it takes its own space rather than being lifted out of the list.
  expect(await box.evaluate((el) => getComputedStyle(el).position)).toBe('static')
  // Directly after the line it belongs to, and inside the list itself.
  expect(
    await box.evaluate((el) => el.previousElementSibling?.getAttribute('data-testid')),
  ).toBe('diff-line-1')
  expect(await box.evaluate((el) => el.parentElement?.getAttribute('data-testid'))).toBe(
    'diff-pane-lines',
  )

  // And it follows the selection as the region grows.
  await page.getByTestId('diff-line-3').click({ modifiers: ['Shift'] })
  expect(
    await box.evaluate((el) => el.previousElementSibling?.getAttribute('data-testid')),
  ).toBe('diff-line-3')
})

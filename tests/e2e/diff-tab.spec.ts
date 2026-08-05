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

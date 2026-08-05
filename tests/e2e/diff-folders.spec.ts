// The Diff tab groups changed files by the folder holding them. A flat list stops
// being readable at about a screenful, and a working tree mid-refactor is mostly one
// folder repeated, so the grouping is what makes a real change set manageable.
import { expect, test } from '@playwright/test'
import { installMockHost, twoProjectScenario } from './mock-host'

const CHANGES = [
  { path: 'package.json', status: 'modified', addedLines: 1, removedLines: 1, binary: false },
  { path: 'src/app.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false },
  { path: 'src/main.ts', status: 'added', addedLines: 12, removedLines: 0, binary: false },
  {
    path: 'src/renderer/View.vue',
    status: 'modified',
    addedLines: 4,
    removedLines: 2,
    binary: false,
  },
  { path: 'docs/logo.png', status: 'added', addedLines: null, removedLines: null, binary: true },
]

async function openDiff(page: import('@playwright/test').Page): Promise<void> {
  const scenario = twoProjectScenario()
  // Seeded at scenario construction, not via a post-goto __mock.setDiff call: alpha is
  // the project the app selects on load, so a later call races its own initial
  // diff.list. Same reason diff-tab.spec.ts does it this way.
  scenario.projects[0].diff = { gitNotice: null, files: CHANGES }
  await page.addInitScript(installMockHost, scenario)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-project-alpha')).toBeVisible()
  await page.getByTestId('sidebar-project-alpha').click()
  await page.getByTestId('tab-diff').click()
  await expect(page.getByTestId('diff-file-list')).toBeVisible()
}

test('files are grouped under the folder that holds them', async ({ page }) => {
  await openDiff(page)

  // One heading per distinct folder, root included.
  await expect(page.getByTestId('diff-folder-root')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src')).toBeVisible()
  await expect(page.getByTestId('diff-folder-src/renderer')).toBeVisible()
  await expect(page.getByTestId('diff-folder-docs')).toBeVisible()

  // Root leads, then folders alphabetically: docs, src, src/renderer.
  const headings = page.locator('.diff-folder')
  await expect(headings).toHaveCount(4)
  await expect(headings.nth(0)).toHaveAttribute('data-testid', 'diff-folder-root')
  await expect(headings.nth(1)).toHaveAttribute('data-testid', 'diff-folder-docs')
  await expect(headings.nth(2)).toHaveAttribute('data-testid', 'diff-folder-src')
  await expect(headings.nth(3)).toHaveAttribute('data-testid', 'diff-folder-src/renderer')
})

test("a folder heading totals its own files, so a folded folder still reports", async ({ page }) => {
  await openDiff(page)

  // src holds app.ts (+3 −1) and main.ts (+12 −0).
  await expect(page.getByTestId('diff-folder-src')).toContainText('+15')
  await expect(page.getByTestId('diff-folder-src')).toContainText('−1')
  await expect(page.getByTestId('diff-folder-src')).toContainText('2')

  // docs holds one binary file, so there is no count to report rather than a
  // fabricated zero — the same discipline the file rows follow.
  await expect(page.getByTestId('diff-folder-docs')).toContainText('binary')
})

test('a file row shows its own name, since the heading already said where it is', async ({
  page,
}) => {
  await openDiff(page)
  const row = page.getByTestId('diff-file-src/renderer/View.vue')
  await expect(row).toContainText('View.vue')
  await expect(row).not.toContainText('src/renderer/View.vue')
  // The full path stays reachable rather than lost.
  await expect(row.locator('.dfr-path')).toHaveAttribute('title', 'src/renderer/View.vue')
})

test('folding a folder hides its files and keeps its heading', async ({ page }) => {
  await openDiff(page)
  await expect(page.getByTestId('diff-file-src/app.ts')).toBeVisible()

  await page.getByTestId('diff-folder-src').click()
  await expect(page.getByTestId('diff-folder-src')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('diff-file-src/app.ts')).toHaveCount(0)
  // Its neighbours are untouched: folding is per folder, not a global collapse.
  await expect(page.getByTestId('diff-file-src/renderer/View.vue')).toBeVisible()
  await expect(page.getByTestId('diff-file-package.json')).toBeVisible()

  await page.getByTestId('diff-folder-src').click()
  await expect(page.getByTestId('diff-file-src/app.ts')).toBeVisible()
})

test('selecting a file still opens its diff, grouped or not', async ({ page }) => {
  await openDiff(page)
  await page.evaluate(() => {
    window.__mock.setFileDiff('p-alpha', 'src/app.ts', {
      binary: false,
      lines: [{ type: 'add', text: 'grouped and still selectable' }],
    })
  })

  await page.getByTestId('diff-file-src/app.ts').click()
  await expect(page.getByTestId('diff-pane-lines')).toContainText('grouped and still selectable')
})
